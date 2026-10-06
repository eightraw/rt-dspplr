// ---------------------------------------------------------------------------
// MP3, Ogg Opus and FLAC in process: dr_mp3, opusfile + libopus and dr_flac
// compiled to WebAssembly (wasm/decoders.c), one instance per stream. The
// built-in decoder looks at the first bytes and reads WAV, MP3, Opus or FLAC
// itself; anything else needs a decoder passed in (ffmpegDecoder()).
// ---------------------------------------------------------------------------

import { looksLikeWav } from '@saitdigital/rt-dspplr/format';
import { UnsupportedFormatError, wavDecoder, type AudioDecoder, type SourceFormat } from '../decoder';
import { DECODERS_WASM } from './embedded';

interface DecoderExports {
    memory: WebAssembly.Memory;
    _initialize(): void;
    rtd_in_reserve(n: number): number;
    rtd_in_commit(n: number): void;
    rtd_in_end(): void;
    rtd_in_ahead(): number;
    rtd_open(kind: number, blockFrames: number): number;
    rtd_channels(): number;
    rtd_rate(): number;
    rtd_bits(): number;
    rtd_total_frames(): number;
    rtd_mp3_delay(): number;
    rtd_read(): number;
    rtd_planes(): number;
}

const FLAC = 1;
const MP3 = 2;
const OPUS = 3;
const END = 0;
const STARVED = -2;
/** Bytes kept ahead of the decoder: more than the largest frame a FLAC block of BLOCK_FRAMES can need. */
const LOOKAHEAD = 4 << 20;
const BLOCK_FRAMES = 32768;
/** A header (cover art, say) larger than this is not read. */
const MAX_HEADER = 256 << 20;

let module: WebAssembly.Module | undefined;
/** The decoders' WebAssembly, compiled once (also for the runs of a source: sourceReader.ts). */
export function decodersModule(): WebAssembly.Module {
    return (module ??= new WebAssembly.Module(Buffer.from(DECODERS_WASM, 'base64')));
}
function instance(): DecoderExports {
    // wasi-libc links random_get; nothing here calls it.
    const x = new WebAssembly.Instance(decodersModule(), { wasi_snapshot_preview1: { random_get: () => 0 } }).exports as unknown as DecoderExports;
    x._initialize();
    return x;
}

const asBytes = (chunk: Uint8Array | ArrayBufferLike): Uint8Array => (chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));

function wasmDecoder(kind: number, name: 'FLAC' | 'MP3' | 'Opus'): AudioDecoder {
    return (bytes, options) => {
        let resolveFormat!: (format: SourceFormat) => void;
        let rejectFormat!: (error: unknown) => void;
        const format = new Promise<SourceFormat>((resolve, reject) => {
            resolveFormat = resolve;
            rejectFormat = reject;
        });
        format.catch(() => undefined);
        const signal = options?.signal;

        async function* blocks(): AsyncGenerator<Float32Array[]> {
            const source = bytes[Symbol.asyncIterator]();
            let x = instance();
            let ended = false;
            const give = (chunk: Uint8Array) => {
                const p = x.rtd_in_reserve(chunk.length);
                if (!p) throw new Error(`${name}: out of memory`);
                new Uint8Array(x.memory.buffer, p, chunk.length).set(chunk);
                x.rtd_in_commit(chunk.length);
            };
            const pull = async (): Promise<Uint8Array | null> => {
                const r = await source.next();
                if (r.done) {
                    ended = true;
                    x.rtd_in_end();
                    return null;
                }
                const chunk = asBytes(r.value);
                give(chunk);
                return chunk;
            };
            try {
                // Opened with LOOKAHEAD bytes in. A header longer than that (cover art in an ID3 tag
                // or a FLAC picture block) starves the open: it starts over with twice as much.
                const head: Uint8Array[] = [];
                let headBytes = 0;
                for (let want = LOOKAHEAD; ; want *= 2) {
                    while (!ended && headBytes < want) {
                        const chunk = await pull();
                        if (chunk) {
                            head.push(chunk);
                            headBytes += chunk.length;
                        }
                    }
                    const opened = x.rtd_open(kind, BLOCK_FRAMES);
                    if (opened === 0) break;
                    if (opened !== STARVED || want >= MAX_HEADER) throw new UnsupportedFormatError(`Input is not a ${name} stream this decoder reads`);
                    x = instance();
                    for (const chunk of head) give(chunk);
                    if (ended) x.rtd_in_end();
                }
                head.length = 0;
                const channels = x.rtd_channels();
                const total = x.rtd_total_frames();
                resolveFormat({
                    sampleRate: x.rtd_rate(), channels, encoding: name.toLowerCase(), bitsPerSample: x.rtd_bits() || 32 /* lossy: the decoder's float32 */, frames: total >= 0 ? total : null,
                    layout: kind === MP3 ? { kind: 'mp3', delay: x.rtd_mp3_delay() } : kind === OPUS ? { kind: 'opus' } : { kind: 'flac' },
                });
                for (;;) {
                    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
                    while (!ended && x.rtd_in_ahead() < LOOKAHEAD) await pull();
                    const n = x.rtd_read();
                    if (n === END) return;
                    if (n < 0) throw new Error(n === STARVED ? `${name}: a frame larger than ${LOOKAHEAD} bytes` : `${name} stream is broken`);
                    const planes = new Float32Array(x.memory.buffer, x.rtd_planes(), BLOCK_FRAMES * channels);
                    const block: Float32Array[] = [];
                    for (let c = 0; c < channels; c += 1) block.push(planes.slice(c * BLOCK_FRAMES, c * BLOCK_FRAMES + n));
                    yield block;
                }
            } catch (error) {
                rejectFormat(error);
                throw error;
            } finally {
                await source.return?.();
            }
        }
        return { format, blocks: blocks() };
    };
}

/** FLAC (native FLAC, not Ogg), in process. */
export const flacDecoder: AudioDecoder = wasmDecoder(FLAC, 'FLAC');
/** MP3 (MPEG-1/2 layers I-III), in process, gapless when the LAME header says so. */
export const mp3Decoder: AudioDecoder = wasmDecoder(MP3, 'MP3');
/** Opus in Ogg (.opus, .ogg), in process: 48 kHz, gapless (the pre-skip and the last granule position trim it). */
export const opusDecoder: AudioDecoder = wasmDecoder(OPUS, 'Opus');

const syncsafe = (h: Uint8Array, at: number) => ((h[at] & 0x7f) << 21) | ((h[at + 1] & 0x7f) << 14) | ((h[at + 2] & 0x7f) << 7) | (h[at + 3] & 0x7f);

/** Which reader the first bytes call for; 'more' when they do not tell yet. */
function sniff(h: Uint8Array, ended: boolean): AudioDecoder | 'more' | null {
    if (h.length < 12 && !ended) return 'more';
    if (looksLikeWav(h)) return wavDecoder;
    if (h[0] === 0x66 && h[1] === 0x4c && h[2] === 0x61 && h[3] === 0x43) return flacDecoder; // fLaC
    if (h[0] === 0x4f && h[1] === 0x67 && h[2] === 0x67 && h[3] === 0x53) {
        // OggS: Opus when the first page's packet is OpusHead (Vorbis or FLAC in Ogg: not read here).
        if (h.length < 27) return ended ? null : 'more';
        const at = 27 + h[26];
        if (h.length < at + 8) return ended ? null : 'more';
        return String.fromCharCode(...h.subarray(at, at + 8)) === 'OpusHead' ? opusDecoder : null;
    }
    if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33 && h.length >= 10) {
        // ID3v2 before either an MP3 or (now and then) a FLAC stream: what follows the tag tells.
        const end = 10 + syncsafe(h, 6) + (h[5] & 0x10 ? 10 : 0);
        if (h.length < end + 4) return ended || end > MAX_HEADER ? null : 'more';
        return h[end] === 0x66 && h[end + 1] === 0x4c && h[end + 2] === 0x61 && h[end + 3] === 0x43 ? flacDecoder : mp3Decoder;
    }
    // An MPEG audio frame: 11 sync bits, a version that is not "reserved", a layer that is not 0 (as ADTS's is).
    if (h[0] === 0xff && (h[1] & 0xe0) === 0xe0 && ((h[1] >> 3) & 3) !== 1 && ((h[1] >> 1) & 3) !== 0) return mp3Decoder;
    return null;
}

/**
 * The default decoder: WAV, MP3, Ogg Opus and FLAC, told apart by their first bytes. Other formats need a
 * decoder passed in, e.g. ffmpegDecoder().
 */
export const builtinDecoder: AudioDecoder = (bytes, options) => {
    let resolveFormat!: (format: SourceFormat) => void;
    let rejectFormat!: (error: unknown) => void;
    const format = new Promise<SourceFormat>((resolve, reject) => {
        resolveFormat = resolve;
        rejectFormat = reject;
    });
    format.catch(() => undefined);

    async function* blocks(): AsyncGenerator<Float32Array[]> {
        const source = bytes[Symbol.asyncIterator]();
        const head: Uint8Array[] = [];
        let seen = new Uint8Array(0);
        let ended = false;
        let chosen: AudioDecoder | 'more' | null = 'more';
        try {
            while (chosen === 'more') {
                const r = await source.next();
                if (r.done) ended = true;
                else {
                    const chunk = asBytes(r.value);
                    head.push(chunk);
                    const all = new Uint8Array(seen.length + chunk.length);
                    all.set(seen);
                    all.set(chunk, seen.length);
                    seen = all;
                }
                chosen = sniff(seen, ended);
            }
            if (!chosen) {
                throw new UnsupportedFormatError(seen.length === 0
                    ? 'Input is empty'
                    : 'Input is not WAV, MP3, Opus or FLAC: pass a `decoder` (e.g. ffmpegDecoder()) to read other formats');
            }
        } catch (error) {
            rejectFormat(error);
            await source.return?.();
            throw error;
        }
        seen = new Uint8Array(0);
        async function* replay(): AsyncGenerator<Uint8Array> {
            try {
                yield* head.splice(0);
                if (ended) return;
                for (;;) {
                    const r = await source.next();
                    if (r.done) return;
                    yield asBytes(r.value);
                }
            } finally {
                await source.return?.();
            }
        }
        const inner = chosen(replay(), options);
        inner.format.then(resolveFormat, rejectFormat);
        yield* inner.blocks;
    }
    return { format, blocks: blocks() };
};
