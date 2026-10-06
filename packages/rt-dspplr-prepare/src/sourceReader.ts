import {
    decodeOpusRun,
    decodePcmRun,
    decodeStreamRun,
    segmentFromRun,
    type AudioManifest,
    type ManifestSegment,
    type ManifestSource,
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

/** Largest difference an Opus run may have against the continuous decode (about -80 dBFS). */
export const OPUS_TOLERANCE = 1e-4;
