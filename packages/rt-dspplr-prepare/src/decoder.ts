import { decodeInterleaved, looksLikeWav, parseWavHeader, WavFormatError, type WavFormat } from '@saitdigital/rt-dspplr/format';

// ---------------------------------------------------------------------------
// Decoder hook. A decoder turns the source's bytes into planar Float32 blocks.
// The built-in one reads WAV (integer PCM 8/16/24/32, float 32/64, any
// channel count and rate) without holding more than one input chunk. Other
// formats need ffmpeg, which is not part of this experiment: plug it in with
// `prepareAudio(input, { decoder })` — e.g. spawn `ffmpeg -i - -f f32le -`
// and yield its output (see docs/long-audio-experiment.md).
// ---------------------------------------------------------------------------

export interface SourceFormat {
    sampleRate: number;
    channels: number;
    /** e.g. 'pcm-int', 'pcm-float'. */
    encoding: string;
    bitsPerSample: number;
    /** Expected frames when known up front (for progress and preallocation). */
    frames: number | null;
}

export interface DecodedStream {
    /** Resolves once the format is known (before the first block). */
    format: Promise<SourceFormat>;
    /** Planar blocks, all channels the same length. */
    blocks: AsyncIterable<Float32Array[]>;
}

export type AudioDecoder = (bytes: AsyncIterable<Uint8Array>) => DecodedStream;

export class UnsupportedFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsupportedFormatError';
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
                        throw new UnsupportedFormatError('Input is not a WAV file. Other formats need ffmpeg, '
                            + 'which is not part of this experiment: pass a `decoder` to prepareAudio() to plug one in.');
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
