import {
    decodeOpusRun,
    decodePcmRun,
    decodeStreamRun,
    openRunStream,
    segmentFromRun,
    type AudioManifest,
    type ManifestSegment,
    type ManifestSource,
    type SegmentEntry,
} from '@saitdigital/rt-dspplr/format';
import { decodersModule } from './wasm/decoders';

// ---------------------------------------------------------------------------
// A prepared timeline read back the way the player reads it (manifest v4):
// each segment's byte range of the source, decoded as one run, its frames
// taken out (segmentFromRun). The same code and the same WebAssembly as the
// player's, so what comes back is what plays.
// ---------------------------------------------------------------------------

type Source = Omit<ManifestSource, 'url' | 'bytes'>;

const headers = new WeakMap<Source, Uint8Array>();

/** A run of `source` (the bytes of a segment's range), decoded: planar, its warm-up included. */
export async function decodeSourceRun(source: Source, bytes: Uint8Array): Promise<Float32Array[]> {
    if (source.codec === 'wav') return decodePcmRun(bytes, source as ManifestSource);
    let header = headers.get(source);
    if (!header && source.header) headers.set(source, (header = Buffer.from(source.header, 'base64')));
    if (source.codec === 'opus') return (await decodeOpusRun(decodersModule(), header!, bytes)).channels;
    return (await decodeStreamRun(decodersModule(), source.codec, bytes, header)).channels;
}

/** One segment's frames: its range read with `read`, decoded, cut out. */
export async function readSegment(source: Source, seg: ManifestSegment, channels: number, read: (start: number, end: number) => Promise<Uint8Array>): Promise<Float32Array[]> {
    if (!seg.range) return segmentFromRun(null, seg, channels);
    const bytes = await read(seg.range[0], seg.range[1]);
    if (bytes.length !== seg.range[1] - seg.range[0]) throw new Error(`segment ${seg.index}: the source ends before byte ${seg.range[1]}`);
    return segmentFromRun(await decodeSourceRun(source, bytes), seg, channels);
}

/**
 * A timeline's segments read back and decoded, the last few kept and requests in flight shared:
 * the alignment windows of a short recording fall in the same segments, and every stem's pairing
 * reads each segment again.
 */
export function sourceReader(segments: AudioManifest['segments'], channels: number, read: (start: number, end: number) => Promise<Uint8Array>, keep = 8): (index: number) => Promise<Float32Array[]> {
    const recent = new Map<number, Promise<Float32Array[]>>();
    return (index) => {
        const known = recent.get(index);
        if (known) {
            recent.delete(index);
            recent.set(index, known);
            return known;
        }
        const loading = readSegment(segments.source, segments.list[index], channels, read);
        loading.catch(() => recent.delete(index));
        recent.set(index, loading);
        if (recent.size > keep) recent.delete(recent.keys().next().value!);
        return loading;
    };
}

/**
 * Whether the index points at the samples the decoder gave: each checked segment (its frames as
 * written to the analyses) against the same segment read back the player's way. WAV and MP3 must
 * match exactly; Opus within `opusTolerance` (a run starts with a fresh decoder, which has
 * converged after its pre-roll but need not be bit-exact).
 */
export async function verifyIndex(
    source: Source,
    list: ManifestSegment[],
    channels: number,
    read: (start: number, end: number) => Promise<Uint8Array>,
    checks: Array<{ index: number; planes: Float32Array[] }>,
    opusTolerance = OPUS_TOLERANCE,
): Promise<void> {
    const tolerance = source.codec === 'opus' ? opusTolerance : 0;
    for (const { index, planes } of checks) {
        const got = await readSegment(source, list[index], channels, read);
        let worst = 0;
        for (let c = 0; c < channels; c += 1) {
            const a = planes[c];
            const b = got[c];
            if (a.length !== b.length) throw new Error(`segment ${index} reads back ${b.length} frames, ${a.length} were decoded`);
            for (let i = 0; i < a.length; i += 1) {
                const d = Math.abs(a[i] - b[i]);
                if (d > worst) worst = d;
            }
        }
        if (worst > tolerance) throw new Error(`segment ${index} reads back off by up to ${worst.toExponential(2)}`);
    }
}

/**
 * Whether the checked segments decoded as their bytes arrive (in a few pieces) come out as when
 * their runs are decoded whole: their `skip` and `tail` add up to the run, and the samples are
 * the same. The reason they do not, or null.
 */
export async function verifySkips(
    source: Source,
    list: ManifestSegment[],
    channels: number,
    read: (start: number, end: number) => Promise<Uint8Array>,
    indexes: number[],
): Promise<string | null> {
    if (source.codec === 'wav') return null;
    let header = headers.get(source);
    if (!header && source.header) headers.set(source, (header = Buffer.from(source.header, 'base64')));
    for (const index of indexes) {
        const seg = list[index];
        if (!seg?.range || seg.skip === undefined) continue;
        const bytes = await read(seg.range[0], seg.range[1]);
        const stream = await openRunStream(decodersModule(), source.codec, header);
        const blocks: Float32Array[][] = [];
        const pieces = 4;
        for (let k = 0; k < pieces; k += 1) {
            const from = Math.floor((bytes.length * k) / pieces);
            const to = Math.floor((bytes.length * (k + 1)) / pieces);
            blocks.push(...stream.push(bytes.subarray(from, to), k === pieces - 1));
        }
        if (stream.frames !== seg.skip + seg.tail) return `segment ${index}: its run decodes to ${stream.frames} samples as it arrives, skip and tail say ${seg.skip + seg.tail}`;
        const run = Array.from({ length: stream.channels }, () => new Float32Array(stream.frames));
        let o = 0;
        for (const block of blocks) {
            block.forEach((ch, c) => run[c].set(ch, o));
            o += block[0].length;
        }
        const streamed = segmentFromRun(run, seg, channels);
        const whole = segmentFromRun(await decodeSourceRun(source, bytes), seg, channels);
        for (let c = 0; c < channels; c += 1) {
            for (let i = 0; i < whole[c].length; i += 1) {
                if (streamed[c][i] !== whole[c][i]) return `segment ${index}: decoded as it arrives, its sample ${i} differs from the whole run's`;
            }
        }
    }
    return null;
}

/**
 * Whether runs from the entries of the checked segments (their first and last) come out as the
 * segment decoded whole, from each entry's frame on: MP3 and FLAC exactly, Opus within
 * `opusTolerance` (a run from an entry has its own pre-roll). The reason they do not, or null.
 */
export async function verifyEntries(
    source: Source,
    list: ManifestSegment[],
    entries: SegmentEntry[][],
    channels: number,
    read: (start: number, end: number) => Promise<Uint8Array>,
    indexes: number[],
    opusTolerance = OPUS_TOLERANCE,
): Promise<string | null> {
    if (source.codec === 'wav') return null;
    let header = headers.get(source);
    if (!header && source.header) headers.set(source, (header = Buffer.from(source.header, 'base64')));
    const tolerance = source.codec === 'opus' ? opusTolerance : 0;
    for (const index of indexes) {
        const seg = list[index];
        const own = entries[index] ?? [];
        if (!seg?.range || own.length === 0) continue;
        const whole = await readSegment(source, seg, channels, read);
        for (const e of new Set([own[0], own[own.length - 1]])) {
            const bytes = await read(e.byte, seg.range[1]);
            const stream = await openRunStream(decodersModule(), source.codec, header);
            const run = stream.push(bytes, true);
            const tail = seg.tail - (e.at - (seg.lead ?? 0));
            if (stream.frames !== e.skip + tail) return `segment ${index}: a run from its entry at frame ${e.at} decodes to ${stream.frames} samples, not ${e.skip} + ${tail}`;
            let n = 0;
            const end = Math.min(seg.frames - (seg.trail ?? 0), e.at + tail);
            for (const block of run) {
                for (let k = 0; k < block[0].length; k += 1, n += 1) {
                    const frame = e.at + n - e.skip;
                    if (n < e.skip || frame >= end) continue;
                    for (let c = 0; c < channels; c += 1) {
                        if (Math.abs(block[c % block.length][k] - whole[c][frame]) > tolerance) return `segment ${index}: from its entry at frame ${e.at}, sample ${frame} differs from the segment's`;
                    }
                }
            }
        }
    }
    return null;
}

/** Largest difference an Opus run may have against the continuous decode (about -80 dBFS). */
export const OPUS_TOLERANCE = 1e-4;
