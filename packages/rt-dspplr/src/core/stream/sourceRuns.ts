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
    rtd_in_ahead(): number;
    rtd_open(kind: number, blockFrames: number): number;
    rtd_channels(): number;
    rtd_rate(): number;
    rtd_read(): number;
    rtd_planes(): number;
    rtd_opus_raw_open?(channels: number, gainQ8: number): number;
    rtd_opus_raw_packet?(n: number): number;
    rtd_opus_raw_decode?(n: number): number;
    rtd_opus_raw_pcm?(): number;
    rtd_mp3_raw_open?(): number;
    rtd_mp3_raw_frame?(n: number): number;
    rtd_mp3_raw_decode?(n: number): number;
    rtd_mp3_raw_pcm?(): number;
    rtd_mp3_raw_channels?(): number;
    rtd_mp3_raw_rate?(): number;
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

// ---- runs decoded as they arrive -------------------------------------------------------------
//
// The same decoders, fed the run's bytes as the network brings them: an MP3 frame by frame, an
// Ogg Opus packet by packet, a FLAC through its stream reader once enough is in that it cannot
// run dry mid-frame. The samples are those of the whole run's decode (decodeStreamRun,
// decodeOpusRun), in the same order; where the segment's first one falls among them a prepared
// segment says (its `skip`).

/** A run decoded as its bytes arrive (openRunStream). */
export interface RunStream {
    /**
     * The run's next bytes (`end`: no more come): the planes of the frames they completed, in
     * order. Throws on bytes the codec does not read; the stream is then unusable.
     */
    push(bytes: Uint8Array, end: boolean): Float32Array[][];
    /** Frames decoded so far. */
    readonly frames: number;
    /** The decoded format, once known (0 before: an MP3 says it with its first samples). */
    readonly sampleRate: number;
    readonly channels: number;
}

/** Most frames per read of a FLAC stream; never more than its smallest block, so a read decodes at most one new frame. */
const FLAC_STEP = 1024;
/**
 * Bytes kept ahead of the FLAC reader besides its largest frame: dr_flac refills its cache 4 KB
 * at a time, and a read that finds less than it asks for breaks the stream.
 */
const FLAC_SLACK = 8192;

/** Planar copies of `frames` interleaved frames at `ptr`. */
function planar(x: RunExports, ptr: number, frames: number, channels: number): Float32Array[] {
    const pcm = new Float32Array(x.memory.buffer, ptr, frames * channels);
    return Array.from({ length: channels }, (_, c) => {
        const ch = new Float32Array(frames);
        for (let i = 0; i < frames; i += 1) ch[i] = pcm[i * channels + c];
        return ch;
    });
}

function concatTo(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length === 0) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

/** An MPEG Layer III frame's length from its header (the 4 bytes at `o`), or 0: not such a frame (free format included). */
export function mp3FrameBytes(b: Uint8Array, o: number): number {
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return 0;
    const version = (b[o + 1] >> 3) & 3; // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5
    const layer = (b[o + 1] >> 1) & 3; // 1 Layer III
    const bitrate = b[o + 2] >> 4;
    const rate = (b[o + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrate === 0 || bitrate === 15 || rate === 3) return 0;
    const kbps = (version === 3 ? MP3_KBPS_V1 : MP3_KBPS_V2)[bitrate];
    const hz = (version === 3 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000])[rate];
    return Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / hz) + ((b[o + 2] >> 1) & 1);
}
const MP3_KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/**
 * A run of `codec` decoded as its bytes arrive: an MP3's frames from the middle, a FLAC's frames
 * after its `header` (fLaC and STREAMINFO), an Ogg Opus file's pages (its OpusHead as `header`).
 */
export async function openRunStream(module: WebAssembly.Module, codec: 'mp3' | 'flac' | 'opus', header?: Uint8Array): Promise<RunStream> {
    const x = await instance(module);
    if (codec === 'mp3') return mp3Stream(x);
    if (codec === 'opus') return opusStream(x, header);
    return flacStream(x, header);
}

function mp3Stream(x: RunExports): RunStream {
    if (!x.rtd_mp3_raw_open || x.rtd_mp3_raw_open() !== 0) throw new Error('mp3 frame decoder unavailable');
    let pending: Uint8Array = new Uint8Array(0);
    let frames = 0;
    let sampleRate = 0;
    let channels = 0;
    return {
        get frames() { return frames; },
        get sampleRate() { return sampleRate; },
        get channels() { return channels; },
        push(bytes, end) {
            pending = concatTo(pending, bytes);
            const out: Float32Array[][] = [];
            let o = 0;
            while (pending.length - o >= 4) {
                const n = mp3FrameBytes(pending, o);
                if (n === 0) throw new Error('mp3 run: not a Layer III frame');
                if (pending.length - o < n) break;
                const p = x.rtd_mp3_raw_frame!(n);
                if (!p) throw new Error('mp3 run: frame too large');
                new Uint8Array(x.memory.buffer, p, n).set(pending.subarray(o, o + n));
                const got = x.rtd_mp3_raw_decode!(n);
                if (got < 0) throw new Error('mp3 run: a frame failed to decode');
                o += n;
                if (got === 0) continue;
                const C = x.rtd_mp3_raw_channels!();
                const rate = x.rtd_mp3_raw_rate!();
                if ((channels && C !== channels) || (sampleRate && rate !== sampleRate)) throw new Error('mp3 run: the format changes');
                channels = C;
                sampleRate = rate;
                out.push(planar(x, x.rtd_mp3_raw_pcm!(), got, C));
                frames += got;
            }
            pending = pending.slice(o);
            if (end && pending.length > 0) throw new Error('mp3 run: it ends inside a frame');
            return out;
        },
    };
}

function opusStream(x: RunExports, header?: Uint8Array): RunStream {
    if (!header) throw new Error('opus runs need the OpusHead');
    const head = opusHead(header);
    if (head.mapping !== 0 || head.channels < 1 || head.channels > 2) throw new Error('opus runs: mono or stereo only');
    if (!x.rtd_opus_raw_open || x.rtd_opus_raw_open(head.channels, head.gainQ8) !== 0) throw new Error('opus decoder unavailable');
    const C = head.channels;
    let pending: Uint8Array = new Uint8Array(0);
    let frames = 0;
    let first = true;
    // As oggPackets(): the bytes up to the end of a packet begun before the run are no packet.
    let fragment = false;
    let parts: Uint8Array[] = [];
    let page: { laces: Uint8Array; at: number } | null = null;
    return {
        get frames() { return frames; },
        sampleRate: 48000,
        channels: C,
        push(bytes, end) {
            pending = concatTo(pending, bytes);
            const out: Float32Array[][] = [];
            let o = 0;
            for (;;) {
                if (!page) {
                    if (pending.length - o < 27) break;
                    if (pending[o] !== 0x4f || pending[o + 1] !== 0x67 || pending[o + 2] !== 0x67 || pending[o + 3] !== 0x53) throw new Error('not an Ogg page');
                    const count = pending[o + 26];
                    if (pending.length - o < 27 + count) break;
                    const continued = (pending[o + 5] & 1) !== 0;
                    if (first) fragment = continued;
                    first = false;
                    if (!continued) parts = [];
                    page = { laces: pending.slice(o + 27, o + 27 + count), at: 0 };
                    o += 27 + count;
                }
                // A packet is decoded once its last lace is in, before the rest of its page.
                while (page.at < page.laces.length) {
                    const lace = page.laces[page.at];
                    if (pending.length - o < lace) break;
                    if (!fragment) parts.push(pending.slice(o, o + lace));
                    o += lace;
                    page.at += 1;
                    if (lace === 255) continue;
                    if (!fragment) {
                        const packet = parts.length === 1 ? parts[0] : concatBytes(parts);
                        const p = x.rtd_opus_raw_packet!(packet.length);
                        new Uint8Array(x.memory.buffer, p, packet.length).set(packet);
                        const n = x.rtd_opus_raw_decode!(packet.length);
                        if (n < 0) throw new Error('opus run: a packet failed to decode');
                        out.push(planar(x, x.rtd_opus_raw_pcm!(), n, C));
                        frames += n;
                    }
                    fragment = false;
                    parts = [];
                }
                if (page.at < page.laces.length) break;
                page = null;
            }
            pending = pending.slice(o);
            if (end && (page || pending.length > 0)) throw new Error('opus run: it ends inside a page');
            return out;
        },
    };
}

function flacStream(x: RunExports, header?: Uint8Array): RunStream {
    if (!header || header.length < 22) throw new Error('flac runs need the STREAMINFO');
    // STREAMINFO, after fLaC and its block header: block sizes at 8 and 10, the largest frame at 15
    // (0: unknown), channels and bits per sample in bytes 20 and 21.
    const minBlock = (header[8] << 8) | header[9];
    const maxBlock = (header[10] << 8) | header[11];
    const maxFrame = (header[15] << 16) | (header[16] << 8) | header[17];
    const streamChannels = ((header[20] >> 1) & 7) + 1;
    const bits = (((header[20] & 1) << 4) | (header[21] >> 4)) + 1;
    const step = Math.max(16, Math.min(FLAC_STEP, minBlock || FLAC_STEP));
    // The largest frame ahead; when the stream does not say, as large as a frame stored
    // uncompressed (a side channel has one bit more).
    const guard = FLAC_SLACK + (maxFrame || Math.ceil((maxBlock * streamChannels * (bits + 1)) / 8) + 64);
    let opened = false;
    let frames = 0;
    let sampleRate = 0;
    let channels = 0;
    const give = (data: Uint8Array) => {
        if (data.length === 0) return;
        const p = x.rtd_in_reserve(data.length);
        if (!p) throw new Error('decoder: out of memory');
        new Uint8Array(x.memory.buffer, p, data.length).set(data);
        x.rtd_in_commit(data.length);
    };
    give(header);
    return {
        get frames() { return frames; },
        get sampleRate() { return sampleRate; },
        get channels() { return channels; },
        push(bytes, end) {
            give(bytes);
            if (end) x.rtd_in_end();
            const out: Float32Array[][] = [];
            if (!opened) {
                if (!end && x.rtd_in_ahead() < guard) return out;
                if (x.rtd_open(FLAC, step) !== 0) throw new Error('not a flac run');
                opened = true;
                channels = x.rtd_channels();
                sampleRate = x.rtd_rate();
            }
            while (end || x.rtd_in_ahead() >= guard) {
                const n = x.rtd_read();
                if (n === 0) break;
                if (n < 0) throw new Error(`flac run: decode failed (${n})`);
                const planes = new Float32Array(x.memory.buffer, x.rtd_planes(), step * channels);
                out.push(Array.from({ length: channels }, (_, c) => planes.slice(c * step, c * step + n)));
                frames += n;
            }
            return out;
        },
    };
}

/** base64 → bytes (no Buffer, no atob dependency on the DOM's typing). */
export function base64Bytes(text: string): Uint8Array {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
}
