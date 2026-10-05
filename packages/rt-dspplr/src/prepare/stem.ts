import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { type AudioManifest, type ManifestStem } from '../core/stream/manifest';
import { parseWavFile } from '../core/stream/wavFormat';
import { DEFAULT_FRAMES_PER_PEAK } from './analysis';
import { wavDecoder, type AudioDecoder } from './decoder';
import { resamplerDesign } from './jobs';
import { resampleInParallel } from './parallelResample';
import type { JobPool } from './pool';
import { writeTimeline, type PrepareOptions, type PrepareStorage } from './prepareAudio';
import { resampleInputRange, resampleRange } from './resampler';

// ---------------------------------------------------------------------------
// Stem B on A's frame grid: the one code path behind
// prepareAudio(a, { stems: { b } }) and attachStem(). B is a processed version
// of A (denoised, restored…), at any rate, channel count and length.
//
//   1. alignment   B is decoded at its own rate; only the 8 windows of 2 s
//                  (± the search range) that the alignment needs are
//                  resampled to A's rate, and they are bit-identical to what a
//                  full resample would give there. FFT cross-correlation runs
//                  against A on each window. The offset that the windows agree
//                  on is compensated, and its confidence is stored. Low
//                  confidence throws StemAlignmentError.
//   2. adaptation  B is decoded again and converted once: downmixed when A is
//                  mono, resampled on the worker pool (parallelResample.ts,
//                  deterministic), mono → every channel of A.
//   3. grid        shifted, padded or trimmed to A's length, written as b/seg/*,
//                  b/peaks.bin, b/bands.bin, b/spectrogram.bin on A's segment
//                  boundaries (writeTimeline, as A).
//   4. pairing     correlation with A (global and per segment) → the mix law.
//                  B's loudness against A's is information only. No trim is
//                  applied unless the host passes gainDb.
// The caller writes the manifest (last, atomically).
// ---------------------------------------------------------------------------

/** B's source: a file path, a byte-stream factory (read twice), or decoded audio. */
export type StemInput =
    | string
    | (() => AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>)
    | { channels: Float32Array[]; sampleRate: number };

export interface StemOptions {
    /** Decoder for B (default: the one given to prepare, else WAV). */
    decoder?: AudioDecoder;
    /** Largest |offset| searched, seconds. Default 1. */
    maxOffsetSeconds?: number;
    /** Below this confidence (0..1) B is refused. Default 0.3. */
    minConfidence?: number;
    /** A refused B: fail the job (default) or keep A only, with the reason recorded in stems.b. */
    onLowConfidence?: 'fail' | 'warn';
    /** Use this offset (frames, B late = positive) instead of measuring. */
    offsetFrames?: number;
    /** Explicit trim for B, stored for the player (default 0: B plays at its own level). */
    gainDb?: number;
    /** Name recorded in stems.b.source. */
    name?: string;
}

export class StemAlignmentError extends Error {
    constructor(message: string, readonly alignment: ManifestStem['alignment']) {
        super(message);
        this.name = 'StemAlignmentError';
    }
}

const WINDOW_SECONDS = 2;
const WINDOWS = 8;

interface OpenedB {
    format: Promise<{ sampleRate: number; channels: number }>;
    blocks: AsyncIterator<Float32Array[]>;
    bytes(): number;
    digest(): string;
}

function bytesOf(input: string | (() => AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>)): AsyncIterable<Uint8Array> {
    if (typeof input === 'string') return fs.createReadStream(input, { highWaterMark: 1 << 20 });
    const made = input();
    if (typeof (made as ReadableStream).getReader === 'function') {
        const reader = (made as ReadableStream<Uint8Array>).getReader();
        return (async function* () {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                if (value) yield value;
            }
        })();
    }
    return made as AsyncIterable<Uint8Array>;
}

function openB(input: StemInput, decoder: AudioDecoder): OpenedB {
    const hash = createHash('sha256');
    let bytes = 0;
    if (typeof input === 'object' && 'channels' in input) {
        const { channels, sampleRate } = input;
        for (const c of channels) {
            hash.update(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
            bytes += c.byteLength;
        }
        const total = channels[0]?.length ?? 0;
        async function* blocks(): AsyncGenerator<Float32Array[]> {
            for (let o = 0; o < total; o += 65536) yield channels.map((c) => c.subarray(o, Math.min(total, o + 65536)));
        }
        return { format: Promise.resolve({ sampleRate, channels: channels.length }), blocks: blocks(), bytes: () => bytes, digest: () => hash.copy().digest('hex') };
    }
    async function* tapped(): AsyncGenerator<Uint8Array> {
        for await (const chunk of bytesOf(input as string | (() => AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>))) {
            const b = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike);
            bytes += b.length;
            hash.update(b);
            yield b;
        }
    }
    const decoded = decoder(tapped());
    return { format: decoded.format, blocks: decoded.blocks[Symbol.asyncIterator](), bytes: () => bytes, digest: () => hash.copy().digest('hex') };
}

const mono = (block: Float32Array[]): Float32Array => {
    if (block.length === 1) return block[0];
    const n = block[0]?.length ?? 0;
    const out = new Float32Array(n);
    for (const ch of block) for (let i = 0; i < n; i += 1) out[i] += ch[i] / block.length;
    return out;
};

/** In-place complex radix-2 FFT (inverse with sign = +1, unscaled). */
function fft(re: Float64Array, im: Float64Array, sign: number): void {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i += 1) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (sign * 2 * Math.PI) / len;
        const wr0 = Math.cos(ang);
        const wi0 = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let wr = 1;
            let wi = 0;
            for (let k = 0; k < len / 2; k += 1) {
                const a = i + k;
                const b = a + len / 2;
                const tr = re[b] * wr - im[b] * wi;
                const ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                const t = wr * wr0 - wi * wi0;
                wi = wr * wi0 + wi * wr0;
                wr = t;
            }
        }
    }
}

/** Best lag of `b` (window + ±maxLag around it) against `a`, and the normalised correlation there. */
export function crossCorrelate(a: Float32Array, b: Float32Array, maxLag: number): { lag: number; rho: number } {
    const W = a.length;
    let n = 1;
    while (n < W + b.length) n <<= 1;
    const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
    ar.set(a);
    br.set(b);
    fft(ar, ai, -1);
    fft(br, bi, -1);
    // conj(A)·B → c[k] = Σ a[i]·b[i + k]
    for (let k = 0; k < n; k += 1) {
        const r = ar[k] * br[k] + ai[k] * bi[k];
        const i = ar[k] * bi[k] - ai[k] * br[k];
        ar[k] = r;
        ai[k] = i;
    }
    fft(ar, ai, 1);
    let ea = 0;
    for (let i = 0; i < W; i += 1) ea += a[i] * a[i];
    const prefix = new Float64Array(b.length + 1);
    for (let i = 0; i < b.length; i += 1) prefix[i + 1] = prefix[i] + b[i] * b[i];
    let best = -Infinity;
    let bestK = maxLag;
    for (let k = 0; k <= 2 * maxLag && k + W <= b.length; k += 1) {
        const eb = prefix[k + W] - prefix[k];
        const rho = ar[k] / n / Math.sqrt(ea * eb + 1e-30);
        if (rho > best) {
            best = rho;
            bestK = k;
        }
    }
    return { lag: bestK - maxLag, rho: best };
}

/** Highest frequency carrying energy within 60 dB of the strongest (averaged 4096-point spectra). */
function bandwidthOf(windows: Float32Array[], rate: number, cap: number): number {
    const N = 4096;
    const power = new Float64Array(N / 2);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (const w of windows) {
        for (let o = 0; o + N <= w.length; o += N) {
            for (let i = 0; i < N; i += 1) {
                re[i] = w[o + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
                im[i] = 0;
            }
            fft(re, im, -1);
            for (let k = 0; k < N / 2; k += 1) power[k] += re[k] * re[k] + im[k] * im[k];
        }
    }
    const top = Math.max(...power);
    let k = N / 2 - 1;
    while (k > 0 && power[k] < top * 1e-6) k -= 1;
    return Math.min(cap, Math.round(((k + 1) * rate) / N));
}

export interface BuildStemContext {
    storage: PrepareStorage;
    /** Reads back what the storage holds (A's segments). */
    read(key: string): Promise<Uint8Array | null>;
    /** A's manifest (written or about to be). */
    manifest: AudioManifest;
    stem: 'b';
    input: StemInput;
    options: StemOptions;
    /** prepare's options (concurrency, decoder, bands/spectrogram switches). */
    prepare: PrepareOptions;
    pool: JobPool;
    signal: AbortSignal;
    processor?: ManifestStem['processor'];
    onProgress?: (stage: 'aligning' | 'writing', fraction: number) => void;
}

/** Align, adapt and write stem B on A's grid; returns the ready stems.b entry (the caller writes the manifest). */
export async function buildStem(ctx: BuildStemContext): Promise<ManifestStem> {
    const { storage, read, manifest, stem, input, options, pool, signal } = ctx;
    const rate = manifest.sampleRate;
    const channels = manifest.channels;
    const fps = manifest.segments.framesPerSegment;
    const decoder = options.decoder ?? ctx.prepare.decoder ?? wavDecoder;

    const readA = async (index: number): Promise<Float32Array[]> => {
        const seg = manifest.segments.list[index];
        const bytes = await read(seg.url);
        if (!bytes) throw new Error(`stem ${stem}: A segment ${seg.url} cannot be read back`);
        return parseWavFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer).channels;
    };
    const monoOfA = async (from: number, frames: number): Promise<Float32Array> => {
        const out = new Float32Array(frames);
        let done = 0;
        while (done < frames) {
            const frame = from + done;
            const index = Math.min(manifest.segments.list.length - 1, Math.floor(frame / fps));
            const chs = await readA(index);
            const start = frame - manifest.segments.list[index].startFrame;
            const take = Math.min(frames - done, chs[0].length - start);
            if (take <= 0) break;
            for (const ch of chs) for (let i = 0; i < take; i += 1) out[done + i] += ch[start + i] / chs.length;
            done += take;
        }
        return out;
    };

    // ---- 1. alignment: only the windows are resampled ------------------------------------
    const W = Math.min(Math.round(WINDOW_SECONDS * rate), Math.floor(manifest.frames / 2));
    const L = Math.min(Math.round((options.maxOffsetSeconds ?? 1) * rate), Math.floor(W / 2));
    let offset = options.offsetFrames ?? 0;
    let alignment: ManifestStem['alignment'];
    let bWindows: Float32Array[] = [];
    let bRate = 0;
    ctx.onProgress?.('aligning', 0);
    const starts: number[] = [];
    for (let k = 0; k < WINDOWS; k += 1) {
        const s = Math.round(((k + 0.5) / WINDOWS) * (manifest.frames - W - 2 * L)) + L;
        if (s - L >= 0 && s + W + L <= manifest.frames) starts.push(s);
    }
    {
        const opened = openB(input, decoder);
        let first = await opened.blocks.next();
        const format = await opened.format;
        bRate = format.sampleRate;
        const same = bRate === rate;
        const design = same ? null : resamplerDesign(bRate, rate, ctx.prepare.resampler);
        // Each window's output range [s − L, s + W + L) at A's rate, and the native input it reads.
        const regions = starts.map((s) => {
            const n0 = s - L;
            const n1 = s + W + L;
            const [ia, ib] = design ? resampleInputRange(design.info, design.half, n0, n1) : [n0, n1];
            const from = Math.max(0, ia);
            return { n0, n1, from, to: ib, buf: new Float32Array(Math.max(0, ib - from)) };
        });
        const lastNeeded = Math.max(0, ...regions.map((r) => r.to));
        let pos = 0;
        while (!first.done && pos < lastNeeded) {
            if (signal.aborted) throw signal.reason ?? new Error('aborted');
            const x = mono(first.value);
            const n = x.length;
            for (const r of regions) {
                const a = Math.max(pos, r.from);
                const b = Math.min(pos + n, r.to);
                for (let f = a; f < b; f += 1) r.buf[f - r.from] = x[f - pos];
            }
            pos += n;
            first = await opened.blocks.next();
        }
        const ended = !!first.done;
        await opened.blocks.return?.();
        const inFrames = ended ? pos : Infinity;
        bWindows = regions.map((r) => {
            if (!design) return r.buf.subarray(0, r.n1 - r.n0);
            return resampleRange(design, [r.buf], r.from, inFrames, r.n0, r.n1)[0];
        });
    }
    if (options.offsetFrames === undefined) {
        const aWins = await Promise.all(starts.map((s) => monoOfA(s, W)));
        const live = aWins.map((a, i) => ({ a, b: bWindows[i] })).filter(({ a }) => {
            let e = 0;
            for (const v of a) e += v * v;
            return Math.sqrt(e / a.length) > 1e-3;
        });
        const results = live.map(({ a, b }) => crossCorrelate(a, b.length >= W + 2 * L ? b : (() => { const p = new Float32Array(W + 2 * L); p.set(b); return p; })(), L));
        const lags = results.map((r) => r.lag).sort((x, y) => x - y);
        const median = lags[Math.floor(lags.length / 2)] ?? 0;
        const agreeing = results.filter((r) => Math.abs(r.lag - median) <= 2);
        const rhos = agreeing.map((r) => r.rho).sort((x, y) => x - y);
        const confidence = rhos.length ? rhos[Math.floor(rhos.length / 2)] : 0;
        offset = median;
        alignment = {
            offsetFrames: offset,
            offsetMs: Math.round((offset / rate) * 1e5) / 100,
            confidence: Math.round(confidence * 1000) / 1000,
            windows: results.length,
            agreeing: agreeing.length,
        };
        const low = results.length === 0 || agreeing.length < Math.max(2, Math.ceil(results.length / 2)) || confidence < (options.minConfidence ?? 0.3);
        if (low) throw new StemAlignmentError(`stem ${stem}: B does not line up with A (offset ${offset} frames, confidence ${confidence.toFixed(2)}, ${agreeing.length}/${results.length} windows agree)`, alignment);
    } else {
        alignment = { offsetFrames: offset, offsetMs: Math.round((offset / rate) * 1e5) / 100, confidence: 1, windows: 0, agreeing: 0 };
    }

    // ---- 2–3. B converted once, on A's grid -----------------------------------------------
    ctx.onProgress?.('writing', 0);
    const opened = openB(input, decoder);
    const firstBlock = await opened.blocks.next();
    const format = await opened.format;
    const bChannels = format.channels;
    // Resample as few channels as needed: mono A or mono B → one channel.
    const rc = channels === 1 || bChannels === 1 ? 1 : bChannels;
    let bFrames = 0;
    async function* native(): AsyncGenerator<Float32Array[]> {
        let n = firstBlock;
        while (!n.done) {
            if (signal.aborted) throw signal.reason ?? new Error('aborted');
            bFrames += n.value[0]?.length ?? 0;
            yield rc === 1 && n.value.length > 1 ? [mono(n.value)] : n.value;
            n = await opened.blocks.next();
        }
    }
    const atRate = format.sampleRate === rate ? native() : resampleInParallel(native(), format.sampleRate, rate, pool, ctx.prepare.resampler);
    const toA = (block: Float32Array[]): Float32Array[] => (block.length === channels ? block : Array.from({ length: channels }, (_, c) => block[c % block.length]));
    async function* aligned(): AsyncGenerator<Float32Array[]> {
        let skip = Math.max(0, offset);
        let pad = Math.max(0, -offset);
        let written = 0;
        while (pad > 0 && written < manifest.frames) {
            const n = Math.min(pad, 65536, manifest.frames - written);
            yield Array.from({ length: channels }, () => new Float32Array(n));
            pad -= n;
            written += n;
        }
        for await (let block of atRate) {
            if (skip > 0) {
                const drop = Math.min(skip, block[0].length);
                skip -= drop;
                block = block.map((c) => c.subarray(drop));
            }
            const n = Math.min(block[0].length, manifest.frames - written);
            if (n <= 0) continue;
            yield toA(block.map((c) => c.subarray(0, n)));
            written += n;
        }
        while (written < manifest.frames) {
            const n = Math.min(65536, manifest.frames - written);
            yield Array.from({ length: channels }, () => new Float32Array(n));
            written += n;
        }
    }
    let sab = 0, saa = 0, sbb = 0;
    const perSegment: number[] = [];
    const timeline = await writeTimeline({
        source: aligned(),
        channels,
        rate,
        storage,
        options: ctx.prepare,
        pool,
        framesPerPeak: manifest.peaks.levels.reduce((m, l) => Math.min(m, l.framesPerPeak), DEFAULT_FRAMES_PER_PEAK),
        segmentSeconds: fps / rate,
        signal,
        prefix: `${stem}/`,
        onSegment: async (index, pcm, frames) => {
            const a = await readA(index);
            let ab = 0, aa = 0, bb = 0;
            for (let c = 0; c < channels; c += 1) {
                const x = a[Math.min(c, a.length - 1)];
                for (let i = 0; i < frames; i += 1) {
                    const bv = pcm[i * channels + c] / 32768;
                    ab += x[i] * bv;
                    aa += x[i] * x[i];
                    bb += bv * bv;
                }
            }
            sab += ab; saa += aa; sbb += bb;
            perSegment.push(Math.round((ab / Math.sqrt(aa * bb + 1e-30)) * 1000) / 1000);
            ctx.onProgress?.('writing', (index + 1) / manifest.segments.list.length);
        },
    });
    if (timeline.totalFrames !== manifest.frames) throw new Error(`stem ${stem}: B came out ${timeline.totalFrames} frames, A has ${manifest.frames}`);
    const global = sab / Math.sqrt(saa * sbb + 1e-30);
    return {
        status: 'ready',
        updatedAt: new Date().toISOString(),
        aSourceId: manifest.id,
        ...(ctx.processor ? { processor: ctx.processor } : {}),
        id: `sha256:${opened.digest()}`,
        source: {
            name: options.name ?? (typeof input === 'string' ? input.split(/[\\/]/).pop() ?? null : null),
            bytes: opened.bytes(),
            sampleRate: format.sampleRate,
            channels: bChannels,
            frames: bFrames,
            bandwidthHz: bandwidthOf(bWindows, rate, format.sampleRate / 2) || Math.round(format.sampleRate / 2),
        },
        alignment,
        correlation: { global: Math.round(global * 1000) / 1000, perSegment },
        mixLaw: global >= 0.5 ? 'crossfade' : 'equal-power',
        loudnessDeltaDb: Math.round((timeline.loudness.gatedRmsDb - manifest.loudness.gatedRmsDb) * 100) / 100,
        gainDb: options.gainDb ?? 0,
        loudness: timeline.loudness,
        segments: { codec: 'wav-pcm16', framesPerSegment: timeline.framesPerSegment, list: timeline.segments },
        peaks: timeline.peaks,
        ...(timeline.bands ? { bands: timeline.bands } : {}),
        ...(timeline.spectrogram ? { spectrogram: timeline.spectrogram } : {}),
    };
}

/** The stems.b entry of a B that was not attached (the reason, and what was measured). */
export function failedStem(manifest: AudioManifest, error: unknown, extra: Partial<ManifestStem> = {}): ManifestStem {
    return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
        aSourceId: manifest.id,
        ...(error instanceof StemAlignmentError ? { alignment: error.alignment } : {}),
        ...extra,
    };
}
