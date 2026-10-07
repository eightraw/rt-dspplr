import type { ManifestSegment, ManifestSource } from './manifest';
import { decodeInterleaved } from './wavFormat';

// ---------------------------------------------------------------------------
// Runs of a source: the bytes of a segment's range, decoded, and the
// segment's frames taken out of them (manifest v4). Pure code - the player
// (in a worker) and the prepare step (in Node) decode runs alike. The codecs'
// WebAssembly is handed in as a compiled module: the player loads one per
// codec, prepare has one with all of them.
// ---------------------------------------------------------------------------

export interface DecodedRun {
    /** Planar samples of the whole run, its decoder's warm-up included. */
    channels: Float32Array[];
    sampleRate: number;
}

/**
 * A segment's frames from its decoded run: `lead` frames of silence, then the run's samples
 * counted back from its end (`tail` of them belong to the segment), `trail` frames of silence.
 * `channels` out: a mono run fills them all, a run with more keeps the first ones.
 */
export function segmentFromRun(run: Float32Array[] | null, seg: ManifestSegment, channels: number): Float32Array[] {
    const out = Array.from({ length: channels }, () => new Float32Array(seg.frames));
    if (!run || run.length === 0 || seg.range === null) return out;
    const lead = seg.lead ?? 0;
    const from = run[0].length - seg.tail;
    if (from < 0) throw new Error(`segment ${seg.index}: its run decoded to ${run[0].length} frames, ${seg.tail} expected from its start`);
    const count = Math.max(0, Math.min(seg.frames - lead - (seg.trail ?? 0), seg.tail));
    for (let c = 0; c < channels; c += 1) out[c].set(run[c % run.length].subarray(from, from + count), lead);
    return out;
}

/** A run of a WAV source: whole frames of its PCM, as the WAV reader decodes them. */
export function decodePcmRun(bytes: Uint8Array, source: ManifestSource): Float32Array[] {
    const pcm = source.pcm;
    if (!pcm) throw new Error('a wav source needs its pcm layout');
    const frames = Math.floor(bytes.length / pcm.blockAlign);
    return decodeInterleaved({ encoding: pcm.encoding, bitsPerSample: pcm.bitsPerSample, channels: source.channels }, bytes.subarray(0, frames * pcm.blockAlign), frames);
}

// ---- the codecs' WebAssembly (see wasm/decoders.c) ------------------------------------------

interface RunExports {
    memory: WebAssembly.Memory;
    _initialize(): void;
    rtd_in_reserve(n: number): number;
    rtd_in_commit(n: number): void;
    rtd_in_end(): void;
    rtd_open(kind: number, blockFrames: number): number;
    rtd_channels(): number;
    rtd_rate(): number;
    rtd_read(): number;
    rtd_planes(): number;
    rtd_opus_raw_open?(channels: number, gainQ8: number): number;
    rtd_opus_raw_packet?(n: number): number;
    rtd_opus_raw_decode?(n: number): number;
    rtd_opus_raw_pcm?(): number;
}

const IMPORTS = { wasi_snapshot_preview1: { random_get: () => 0 } };
const BLOCK = 32768;
const FLAC = 1;
const MP3 = 2;

async function instance(module: WebAssembly.Module): Promise<RunExports> {
    const x = (await WebAssembly.instantiate(module, IMPORTS)).exports as unknown as RunExports;
    x._initialize();
    return x;
}

function concatPlanes(parts: Float32Array[][], channels: number, total: number): Float32Array[] {
    const out = Array.from({ length: channels }, () => new Float32Array(total));
    let o = 0;
    for (const part of parts) {
        part.forEach((ch, c) => out[c].set(ch, o));
        o += part[0].length;
    }
    return out;
}

/**
 * A run of an MP3 (frames from the middle: no tag, no trimming) or of a FLAC (`header` - fLaC
 * and its STREAMINFO - then frames), decoded raw.
 */
export async function decodeStreamRun(module: WebAssembly.Module, codec: 'mp3' | 'flac', bytes: Uint8Array, header?: Uint8Array): Promise<DecodedRun> {
    const x = await instance(module);
    const parts = header ? [header, bytes] : [bytes];
    for (const part of parts) {
        const p = x.rtd_in_reserve(part.length);
        if (!p) throw new Error('decoder: out of memory');
        new Uint8Array(x.memory.buffer, p, part.length).set(part);
        x.rtd_in_commit(part.length);
    }
    x.rtd_in_end();
    if (x.rtd_open(codec === 'flac' ? FLAC : MP3, BLOCK) !== 0) throw new Error(`not a ${codec} run`);
    const C = x.rtd_channels();
    const sampleRate = x.rtd_rate();
    const blocks: Float32Array[][] = [];
    let total = 0;
    for (;;) {
        const n = x.rtd_read();
        if (n === 0) break;
        if (n < 0) throw new Error(`${codec} run: decode failed (${n})`);
        const planes = new Float32Array(x.memory.buffer, x.rtd_planes(), BLOCK * C);
        blocks.push(Array.from({ length: C }, (_, c) => planes.slice(c * BLOCK, c * BLOCK + n)));
        total += n;
    }
    return { channels: concatPlanes(blocks, C, total), sampleRate };
}

/** The packets of a run of Ogg pages, in order (a packet may span pages); a run starts at a page. */
export function oggPackets(bytes: Uint8Array): Uint8Array[] {
    const packets: Uint8Array[] = [];
    let pending: Uint8Array[] = [];
    // The run's first page may continue a packet begun before the run: up to where that packet
    // ends (on this page or a later one), the bytes are no packet.
    let fragment = bytes.length > 5 && (bytes[5] & 1) !== 0;
    let o = 0;
    while (o + 27 <= bytes.length) {
        if (bytes[o] !== 0x4f || bytes[o + 1] !== 0x67 || bytes[o + 2] !== 0x67 || bytes[o + 3] !== 0x53) throw new Error('not an Ogg page');
        if ((bytes[o + 5] & 1) === 0) pending = [];
        const segments = bytes[o + 26];
        let p = o + 27 + segments;
        for (let i = 0; i < segments; i += 1) {
            const lace = bytes[o + 27 + i];
            if (!fragment) pending.push(bytes.subarray(p, p + lace));
            p += lace;
            if (lace < 255) {
                if (!fragment) packets.push(pending.length === 1 ? pending[0] : concatBytes(pending));
                fragment = false;
                pending = [];
            }
        }
        o = p;
    }
    return packets;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

/** OpusHead: channels, pre-skip, output gain (Q7.8 dB), channel mapping family. */
export function opusHead(head: Uint8Array): { channels: number; preSkip: number; gainQ8: number; mapping: number } {
    if (String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead') throw new Error('not an OpusHead');
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return { channels: head[9], preSkip: view.getUint16(10, true), gainQ8: view.getInt16(16, true), mapping: head[18] };
}

/** A run of an Ogg Opus file (whole pages, the stream's OpusHead as `header`), decoded raw at 48 kHz. */
export async function decodeOpusRun(module: WebAssembly.Module, header: Uint8Array, bytes: Uint8Array): Promise<DecodedRun> {
    const head = opusHead(header);
    if (head.mapping !== 0 || head.channels < 1 || head.channels > 2) throw new Error('opus runs: mono or stereo only');
    const x = await instance(module);
    if (!x.rtd_opus_raw_open || x.rtd_opus_raw_open(head.channels, head.gainQ8) !== 0) throw new Error('opus decoder unavailable');
    const C = head.channels;
    const blocks: Float32Array[][] = [];
    let total = 0;
    for (const packet of oggPackets(bytes)) {
        const p = x.rtd_opus_raw_packet!(packet.length);
        new Uint8Array(x.memory.buffer, p, packet.length).set(packet);
        const n = x.rtd_opus_raw_decode!(packet.length);
        if (n < 0) throw new Error('opus run: a packet failed to decode');
        const pcm = new Float32Array(x.memory.buffer, x.rtd_opus_raw_pcm!(), n * C);
        blocks.push(Array.from({ length: C }, (_, c) => {
            const ch = new Float32Array(n);
            for (let i = 0; i < n; i += 1) ch[i] = pcm[i * C + c];
            return ch;
        }));
        total += n;
    }
    return { channels: concatPlanes(blocks, C, total), sampleRate: 48000 };
}

/** base64 → bytes (no Buffer, no atob dependency on the DOM's typing). */
export function base64Bytes(text: string): Uint8Array {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
}
