import { decodeInterleaved, looksLikeWav, MAX_CHANNELS, MAX_SAMPLE_RATE, MIN_SAMPLE_RATE, parseWavHeader, WavFormatError, type WavFormat } from '@saitdigital/rt-dspplr/format';

// ---------------------------------------------------------------------------
// Decoder hook. A decoder turns the source's bytes into planar Float32 blocks.
// The WAV reader here takes integer PCM 8/16/24/32 and float 32/64, any
// channel count and rate, without holding more than one input chunk; the
// built-in decoder (wasm/decoders.ts, the default) uses it for WAV and reads
// MP3, Opus and FLAC itself. Other formats need a decoder passed in:
// `prepareAudio(input, { decoder: ffmpegDecoder() })`, or your own.
// ---------------------------------------------------------------------------

export interface SourceFormat {
    sampleRate: number;
    channels: number;
    /** e.g. 'pcm-int', 'pcm-float'. */
    encoding: string;
    bitsPerSample: number;
    /** Expected frames when known up front (for progress and preallocation). */
    frames: number | null;
    /**
     * Where the input file keeps its samples, for its index (manifest v4: the player reads the
     * file itself). Set by the built-in readers; absent, the source is written once as a WAV.
     */
    layout?: SourceLayout;
}

export type SourceLayout =
    | { kind: 'wav'; dataOffset: number; blockAlign: number; encoding: 'int' | 'float'; bitsPerSample: number }
    | { kind: 'mp3'; delay: number }
    | { kind: 'flac' }
    | { kind: 'opus' };

export interface DecodedStream {
    /** Resolves once the format is known (before the first block). */
    format: Promise<SourceFormat>;
    /** Planar blocks, all channels the same length. */
    blocks: AsyncIterable<Float32Array[]>;
}

export interface DecoderOptions {
    /** The job's cancellation: a decoder that runs a process stops it on abort. */
    signal?: AbortSignal;
}

export type AudioDecoder = (bytes: AsyncIterable<Uint8Array>, options?: DecoderOptions) => DecodedStream;

export class UnsupportedFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsupportedFormatError';
    }
}

// What the player plays: the limits its manifest check holds a timeline to.
export { MAX_CHANNELS, MAX_SAMPLE_RATE, MIN_SAMPLE_RATE };

/**
 * A decoded input's channels, and its rate when it is the timeline's (A's: a stem at any other
 * rate is converted to A's), checked against what the player plays, before any work is done.
 */
export function checkAudioShape(format: { sampleRate: number; channels: number }, what: string, timeline: boolean): void {
    const { sampleRate, channels } = format;
    if (!Number.isInteger(channels) || channels < 1 || channels > MAX_CHANNELS) {
        throw new UnsupportedFormatError(`${what} has ${channels} channels: the player plays 1 to ${MAX_CHANNELS}`);
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new UnsupportedFormatError(`${what} says its rate is ${sampleRate} Hz`);
    if (timeline && (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE)) {
        throw new UnsupportedFormatError(`${what} is at ${sampleRate} Hz: the player plays ${MIN_SAMPLE_RATE} to ${MAX_SAMPLE_RATE} Hz, so convert it first`);
    }
}

/**
 * The blocks with every non-finite sample replaced (NaN → 0, ±Infinity → ±1),
 * as a float WAV or a custom decoder may hold them. A channel is copied only
 * when it has one; `counter.replaced` counts them. Whatever the decoder,
 * prepare runs its blocks through this before anything else sees them.
 */
/** Index of the first non-finite sample, or −1. */
function firstNonFinite(x: Float32Array): number {
    for (let i = 0; i < x.length; i += 1) {
        const v = x[i];
        if (v - v !== 0) return i;
    }
    return -1;
}

/** NaN → 0, ±Infinity → ±1 in place; returns how many. */
function replaceNonFinite(y: Float32Array): number {
    let n = 0;
    for (let i = 0; i < y.length; i += 1) {
        const v = y[i];
        if (v - v === 0) continue;
        y[i] = v !== v ? 0 : v > 0 ? 1 : -1;
        n += 1;
    }
    return n;
}

/** Encodings whose samples are finite by construction (integers, and what the built-in FLAC, MP3 and Opus decoders make of them). */
const FINITE_ENCODINGS = new Set(['pcm-int', 'flac', 'mp3', 'opus']);

export async function* finiteBlocks(blocks: AsyncIterable<Float32Array[]>, counter: { replaced: number }, format?: Promise<SourceFormat>): AsyncGenerator<Float32Array[]> {
    // Integer PCM (and FLAC, MP3, Opus) cannot hold anything but finite samples: nothing to look at. The format is
    // known once the decoder has produced its first block (the WAV reader learns it from the
    // header it reads for that block), so it is looked at there, never before: awaiting it
    // first would wait for a read that nobody starts.
    let integer: boolean | null = null;
    for await (const block of blocks) {
        if (integer === null) integer = format ? FINITE_ENCODINGS.has((await format.catch(() => null))?.encoding ?? '') : false;
        if (integer) {
            yield block;
            continue;
        }
        let out = block;
        for (let c = 0; c < block.length; c += 1) {
            const x = block[c];
            if (firstNonFinite(x) < 0) continue;
            const y = x.slice();
            if (out === block) out = block.slice();
            out[c] = y;
            counter.replaced += replaceNonFinite(y);
        }
        yield out;
    }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length === 0) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

/** The built-in streaming WAV decoder. */
export const wavDecoder: AudioDecoder = (bytes) => {
    let resolveFormat!: (format: SourceFormat) => void;
    let rejectFormat!: (error: unknown) => void;
    const format = new Promise<SourceFormat>((resolve, reject) => {
        resolveFormat = resolve;
        rejectFormat = reject;
    });
    // Callers that only iterate blocks must not see an unhandled rejection.
    format.catch(() => undefined);

    async function* blocks(): AsyncGenerator<Float32Array[]> {
        let pending = new Uint8Array(0);
        let wav: WavFormat | null = null;
        let remaining = Infinity;
        try {
            for await (const raw of bytes) {
                let chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike);
                if (!wav) {
                    pending = concat(pending, chunk);
                    if (pending.length >= 12 && !looksLikeWav(pending)) {
                        throw new UnsupportedFormatError('Input is not a WAV file. The default decoder also reads MP3, Opus and FLAC; '
                            + 'other formats need ffmpeg or another decoder: pass a `decoder` to prepareAudio().');
                    }
                    if (pending.length > 16 * 1024 * 1024) throw new WavFormatError('WAV header larger than 16 MiB');
                    wav = parseWavHeader(pending);
                    if (!wav) continue;
                    remaining = wav.dataBytes ?? Infinity;
                    resolveFormat({
                        sampleRate: wav.sampleRate,
                        channels: wav.channels,
                        encoding: wav.encoding === 'float' ? 'pcm-float' : 'pcm-int',
                        bitsPerSample: wav.bitsPerSample,
                        frames: wav.dataBytes === null ? null : Math.floor(wav.dataBytes / wav.blockAlign),
                        layout: { kind: 'wav', dataOffset: wav.dataOffset, blockAlign: wav.blockAlign, encoding: wav.encoding, bitsPerSample: wav.bitsPerSample },
                    });
                    chunk = pending.subarray(wav.dataOffset);
                    pending = new Uint8Array(0);
                }
                if (remaining <= 0) continue; // trailing chunks (LIST, id3...) after data
                if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
                remaining -= chunk.length;
                const data = pending.length ? concat(pending, chunk) : chunk;
                const frames = Math.floor(data.length / wav.blockAlign);
                const used = frames * wav.blockAlign;
                // Keep the partial frame for the next chunk (copied: the chunk may be reused).
                pending = data.slice(used);
                if (frames > 0) yield decodeInterleaved(wav, data.subarray(0, used), frames);
            }
            if (!wav) {
                throw new WavFormatError(pending.length >= 12 ? 'WAV has no "data" chunk' : 'Input is empty or truncated');
            }
        } catch (error) {
            rejectFormat(error);
            throw error;
        }
    }
    return { format, blocks: blocks() };
};
