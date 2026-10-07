import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { type AudioManifest, type ManifestStem } from '@saitdigital/rt-dspplr/format';
import { checkFramesPerPeak } from './analysis';
import { bandwidthFrom, coarseDecimation, type CorrelateJob, type CorrelateResult } from './correlate';
import { checkAudioShape, finiteBlocks, wavDecoder, type AudioDecoder, type SourceLayout } from './decoder';
import { builtinDecoder } from './wasm/decoders';
import { resamplerDesign } from './jobs';
import { resampleInParallel } from './parallelResample';
import type { JobPool } from './pool';
import { fileNameOnly, segmentChecks, storeSource, writeTimeline, type PrepareOptions, type PrepareStorage } from './prepareAudio';
import { StemProcessorError } from './processors';
import { resampleInputRange, resampleRange } from './resampler';
import { mappable, sourceWavSink, type WavSink } from './sourceIndex';

// ---------------------------------------------------------------------------
// A named stem on A's frame grid: the one code path behind
// prepareAudio(a, { stems: { [key]: … } }) and attachStem(). The stem ("B"
// below) is a time-aligned derivative of A, made by whatever the host runs, at
// any rate, channel count and length. Output that changes timing (re-timed,
// re-synthesised or translated audio) is not a stem: alignment refuses it.
//
//   1. alignment   B is decoded at its own rate; only the 8 windows of 2 s
//                  (± the search range) that the alignment needs are
//                  resampled to A's rate, and they are bit-identical to what a
//                  full resample would give there. FFT cross-correlation runs
//                  against A on each window where both sound. The offset most
//                  windows agree on (to ±2 frames) is compensated; the share
//                  that agree is the confidence. Too few throws StemAlignmentError.
//                  The correlation's height is not a test: it is the stem's share
//                  of A (a quiet part, say a vocal's breaths, is ~0.15 when
//                  perfectly aligned), while unrelated audio peaks at random lags.
//   2. adaptation  B is decoded again and converted once: downmixed when A is
//                  mono, resampled on the worker pool (parallelResample.ts,
//                  deterministic), mono → every channel of A.
//   3. grid        shifted, padded or trimmed to A's length: <key>/r<n>/peaks.bin,
//                  bands.bin, spectrogram.bin on A's segment boundaries (writeTimeline,
//                  as A), and <key>/r<n>/source.*. A stem the player reads as it is
//                  (WAV, MP3 or Opus at A's rate, mono or A's channels) is kept as it
//                  is, its index shifted by the offset; any other is written as a
//                  16-bit WAV on A's grid. n is the manifest revision that publishes
//                  this version of the stem: a replaced stem's files stay where they
//                  are, so every URL a manifest ever listed keeps its bytes.
//   4. pairing     correlation with A (global and per segment) → the mix law.
//                  B's loudness against A's is information only. No trim is
//                  applied unless the host passes gainDb.
// The caller writes the manifest (last, atomically).
// ---------------------------------------------------------------------------

/** B's source: a file path, a byte-stream factory (spooled to a scratch file first), or decoded audio. */
export type StemInput =
    | string
    | (() => AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>)
    | { channels: Float32Array[]; sampleRate: number };

export interface StemOptions {
    /** Decoder for B (default: the one given to prepare, else the built-in WAV, FLAC and MP3 one). */
    decoder?: AudioDecoder;
    /** Largest |offset| searched, seconds. Default 1. */
    maxOffsetSeconds?: number;
    /**
     * Share of the measured windows (0..1) that must agree on the offset, at least 2 of
     * them; below it B is refused. Default 0.5. Windows where A or B is silent are not measured.
     */
    minConfidence?: number;
    /** A refused stem: fail the job (default) or publish without it, the reason recorded in its entry. */
    onLowConfidence?: 'fail' | 'warn';
    /** Use this offset (frames, B late = positive) instead of measuring. */
    offsetFrames?: number;
    /** Explicit trim for B, stored for the player (default 0: B plays at its own level). */
    gainDb?: number;
    /** Name recorded in the stem's `source.name` (its last path part only). */
    name?: string;
}

export class StemAlignmentError extends Error {
    constructor(message: string, readonly alignment: ManifestStem['alignment']) {
        super(message);
        this.name = 'StemAlignmentError';
    }
}

const aWindowCache = new WeakMap<object, Map<string, Promise<Float32Array>>>();

const WINDOW_SECONDS = 2;
const WINDOWS = 8;

interface OpenedB {
    format: Promise<{ sampleRate: number; channels: number; layout?: SourceLayout }>;
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

/** Decoded PCM of the stem kept from the first pass, up to this many bytes (Float32, its own channels): a short stem is decoded once. */
const KEEP_DECODED_BYTES = 64 * 1024 * 1024;

/** `hashing.on`: whether the source bytes still go into the digest (a pass whose digest is not used turns it off). */
function openB(input: StemInput, decoder: AudioDecoder, signal: AbortSignal, nonFinite: { replaced: number }, hashing = { on: true }): OpenedB {
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
        return { format: Promise.resolve({ sampleRate, channels: channels.length }), blocks: finiteBlocks(blocks(), nonFinite), bytes: () => bytes, digest: () => hash.copy().digest('hex') };
    }
    // A read that failed is B's error, whatever the decoder makes of it (one that swallows it would
    // end B early, and the grid would pad it with silence).
    let readError: { error: unknown } | null = null;
    async function* tapped(): AsyncGenerator<Uint8Array> {
        try {
            for await (const chunk of bytesOf(input as string | (() => AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>))) {
                const b = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike);
                bytes += b.length;
                if (hashing.on) hash.update(b);
                yield b;
            }
        } catch (error) {
            readError = { error };
            throw error;
        }
    }
    const decoded = decoder(tapped(), { signal });
    decoded.format.catch(() => undefined); // awaited only after the first block, which may fail first
    async function* checked(): AsyncGenerator<Float32Array[]> {
        try {
            yield* finiteBlocks(decoded.blocks, nonFinite, decoded.format);
        } catch (error) {
            throw readError ? readError.error : error;
        }
        if (readError) throw readError.error;
    }
    return { format: decoded.format, blocks: checked(), bytes: () => bytes, digest: () => hash.copy().digest('hex') };
}

/** out[o + i] += ch[s + i] / count, i < n (kernel: module level, sync, monomorphic). */
function addDivided(out: Float32Array, o: number, ch: Float32Array, s: number, n: number, count: number): void {
    if ((count & (count - 1)) === 0) {
        // A power of two: x / count and x · (1 / count) are the same number (both exact scalings, rounded alike).
        const inv = 1 / count;
        for (let i = 0; i < n; i += 1) out[o + i] += ch[s + i] * inv;
        return;
    }
    for (let i = 0; i < n; i += 1) out[o + i] += ch[s + i] / count;
}

/** Two channels into a zeroed out[o, o + n): addDivided() twice in one pass, the same numbers (the first sum stored as float32). */
function addHalves(out: Float32Array, o: number, a: Float32Array, b: Float32Array, s: number, n: number): void {
    for (let i = 0; i < n; i += 1) out[o + i] = Math.fround(a[s + i] * 0.5) + b[s + i] * 0.5;
}

const mono = (block: Float32Array[]): Float32Array => {
    if (block.length === 1) return block[0];
    const n = block[0]?.length ?? 0;
    const out = new Float32Array(n);
    if (block.length === 2) addHalves(out, 0, block[0], block[1], 0, n);
    else for (const ch of block) addDivided(out, 0, ch, 0, n, block.length);
    return out;
};

function rmsOf(x: Float32Array): number {
    let e = 0;
    for (let i = 0; i < x.length; i += 1) e += x[i] * x[i];
    return Math.sqrt(e / Math.max(1, x.length));
}

/** A's segment against the stem's: Σab, Σaa, Σbb into out[0..2]. */
function pairSums(a: Float32Array[], b: Float32Array[], channels: number, frames: number, out: Float64Array): void {
    let ab = 0, aa = 0, bb = 0;
    for (let c = 0; c < channels; c += 1) {
        const x = a[Math.min(c, a.length - 1)];
        const y = b[c];
        for (let i = 0; i < frames; i += 1) {
            const bv = y[i];
            ab += x[i] * bv;
            aa += x[i] * x[i];
            bb += bv * bv;
        }
    }
    out[0] = ab;
    out[1] = aa;
    out[2] = bb;
}

export interface BuildStemContext {
    storage: PrepareStorage;
    /** A's segment `index`, decoded from its source as the player decodes it (sourceReader): shared by the stems of one job. */
    readA: (index: number) => Promise<Float32Array[]>;
    /** A scratch folder for the stem's files before they are stored (the caller removes it). */
    scratch: () => Promise<string>;
    /** A's manifest (written or about to be). */
    manifest: AudioManifest;
    /** The stem's key (its files go under `<key>/r<revision>/`). */
    stem: string;
    /** The manifest revision that will publish this version of the stem (it names the folder of its files). */
    revision: number;
    input: StemInput;
    options: StemOptions;
    /** prepare's options (concurrency, decoder, bands/spectrogram switches). */
    prepare: PrepareOptions;
    pool: JobPool;
    signal: AbortSignal;
    processor?: ManifestStem['processor'];
    onProgress?: (stage: 'aligning' | 'writing', fraction: number) => void;
    /** Something the host's log should know (non-finite samples replaced). */
    onWarning?: (message: string) => void;
}

/** The stem's decoded blocks kept from the first pass, read again as if decoded. */
function keptB(kept: { blocks: Float32Array[][]; format: { sampleRate: number; channels: number; layout?: SourceLayout }; bytes: number; digest: string }): OpenedB {
    async function* blocks(): AsyncGenerator<Float32Array[]> {
        yield* kept.blocks;
    }
    return { format: Promise.resolve(kept.format), blocks: blocks(), bytes: () => kept.bytes, digest: () => kept.digest };
}

/** Align, adapt and write a stem on A's grid; returns its ready entry (the caller writes the manifest). */
export async function buildStem(ctx: BuildStemContext): Promise<ManifestStem> {
    const { storage, manifest, stem, options, pool, signal, readA } = ctx;
    const rate = manifest.sampleRate;
    const channels = manifest.channels;
    const fps = manifest.segments.framesPerSegment;
    const decoder = options.decoder ?? ctx.prepare.decoder ?? builtinDecoder;
    // A byte-stream factory is read into a file once: B is read more than once, and may be kept as it is.
    let input = ctx.input;
    if (typeof input === 'function') {
        const file = path.join(await ctx.scratch(), `${stem}.input`);
        await pipeline(bytesOf(input), fs.createWriteStream(file), { signal });
        input = file;
    }
    const freshBlocks = (decoder === builtinDecoder || decoder === wavDecoder) && !(typeof input === 'object' && 'channels' in input);

    // A's mono windows, shared by the stems of one job (same starts, same W): keyed by the shared reader.
    let windows = aWindowCache.get(readA);
    if (!windows) aWindowCache.set(readA, (windows = new Map()));
    const monoOfA = (from: number, frames: number): Promise<Float32Array> => {
        const key = from + ':' + frames;
        let w = windows!.get(key);
        if (!w) windows!.set(key, (w = monoOfAOnce(from, frames)));
        return w;
    };
    const monoOfAOnce = async (from: number, frames: number): Promise<Float32Array> => {
        const out = new Float32Array(frames);
        let done = 0;
        while (done < frames) {
            const frame = from + done;
            const index = Math.min(manifest.segments.list.length - 1, Math.floor(frame / fps));
            const chs = await readA(index);
            const start = frame - manifest.segments.list[index].startFrame;
            const take = Math.min(frames - done, chs[0].length - start);
            if (take <= 0) break;
            if (chs.length === 2) addHalves(out, done, chs[0], chs[1], start, take);
            else for (const ch of chs) addDivided(out, done, ch, start, take, chs.length);
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
    // A short stem is decoded once: the first pass keeps its blocks (and reads to the end, so the
    // digest and the non-finite count are complete), and the second pass reads them back.
    let kept: { blocks: Float32Array[][]; format: { sampleRate: number; channels: number; layout?: SourceLayout }; bytes: number; digest: string; replaced: number } | null = null;
    {
        const firstCount = { replaced: 0 };
        const hashing = { on: true };
        const opened = openB(input, decoder, signal, firstCount, hashing);
        let first = await opened.blocks.next();
        const format = await opened.format;
        checkAudioShape(format, `stems.${stem}`, false);
        bRate = format.sampleRate;
        let keeping: Float32Array[][] | null = [];
        let keptBytes = 0;
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
        while (!first.done && (pos < lastNeeded || keeping)) {
            if (signal.aborted) throw signal.reason ?? new Error('aborted');
            const block = first.value;
            const n = block[0]?.length ?? 0;
            if (keeping) {
                keptBytes += n * block.length * 4;
                if (keptBytes > KEEP_DECODED_BYTES) {
                    // Too long to keep: the second pass decodes it again, and hashes it then.
                    keeping = null;
                    hashing.on = false;
                } else {
                    // Copies: a decoder may hand out the same arrays block after block (the built-in one never does).
                    keeping.push(freshBlocks ? block : block.map((c) => c.slice()));
                }
            }
            if (pos < lastNeeded) {
                const x = mono(block);
                for (const r of regions) {
                    const a = Math.max(pos, r.from);
                    const b = Math.min(pos + n, r.to);
                    if (b > a) r.buf.set(x.subarray(a - pos, b - pos), a - r.from);
                }
            }
            pos += n;
            first = await opened.blocks.next();
        }
        const ended = !!first.done;
        if (keeping && ended) kept = { blocks: keeping, format, bytes: opened.bytes(), digest: opened.digest(), replaced: firstCount.replaced };
        await opened.blocks.return?.();
        const inFrames = ended ? pos : Infinity;
        bWindows = regions.map((r) => {
            if (!design) return r.buf.subarray(0, r.n1 - r.n0);
            return resampleRange(design, [r.buf], r.from, inFrames, r.n0, r.n1)[0];
        });
    }
    // Each window on the pool: its lag against A (coarse, then to the sample) where both sound,
    // and its power spectrum, for the stem's bandwidth.
    const decimation = coarseDecimation(rate);
    const measureWindows = (aWins: Array<Float32Array | null>): Promise<CorrelateResult[]> => Promise.all(bWindows.map((b, index) => {
        const padded = b.length >= W + 2 * L ? b : (() => { const p = new Float32Array(W + 2 * L); p.set(b); return p; })();
        const job: CorrelateJob = { kind: 'correlate', index, a: aWins[index], b: padded, maxLag: L, decimation };
        return pool.run(job) as Promise<CorrelateResult>;
    }));
    let measured: CorrelateResult[] = [];
    if (options.offsetFrames === undefined) {
        const aWins = await Promise.all(starts.map((s) => monoOfA(s, W)));
        const rms = rmsOf;
        // Measured: windows where A sounds and B does too, under A's window (a stem that stops
        // inside the search range has nothing under the window). A stem silent for a stretch (a
        // song's vocal between verses: digital silence, dither, a separator's residue more than
        // 50 dB under its loudest window) has no offset there to agree on.
        const bLevels = bWindows.map((b) => rms(b.subarray(L, L + W)));
        const bTop = Math.max(0, ...bLevels);
        const live = aWins.map((a, i) => rms(a) > 1e-3 && bLevels[i] > 1e-6 && bLevels[i] >= bTop * 10 ** (-50 / 20));
        measured = await measureWindows(aWins.map((a, i) => (live[i] ? a : null)));
        const results = measured.filter((_, i) => live[i]);
        const lags = results.map((r) => r.lag).sort((x, y) => x - y);
        const median = lags[Math.floor(lags.length / 2)] ?? 0;
        const agreeing = results.filter((r) => Math.abs(r.lag - median) <= 2);
        const confidence = results.length ? agreeing.length / results.length : 0;
        offset = median;
        alignment = {
            offsetFrames: offset,
            offsetMs: Math.round((offset / rate) * 1e5) / 100,
            confidence: Math.round(confidence * 1000) / 1000,
            windows: results.length,
            agreeing: agreeing.length,
        };
        if (results.length === 0) {
            throw new StemAlignmentError(`stems.${stem} is silent wherever A sounds: there is nothing to align. A stem must be a time-aligned `
                + 'derivative of A, on the same timeline.', alignment);
        }
        if (agreeing.length < 2 || confidence < (options.minConfidence ?? 0.5)) {
            throw new StemAlignmentError(`stems.${stem} does not line up with A: ${agreeing.length} of ${results.length} windows agree on an offset `
                + `(${offset} frames). A stem must be a time-aligned derivative of A, on the same timeline. `
                + 'Output that changes timing (stretched, re-timed, re-synthesised or translated audio) cannot be blended with A: '
                + 'publish it as a separate clip with its own manifest.', alignment);
        }
    } else {
        alignment = { offsetFrames: offset, offsetMs: Math.round((offset / rate) * 1e5) / 100, confidence: 1, windows: 0, agreeing: 0 };
        measured = await measureWindows(bWindows.map(() => null));
    }
    // The stem's bandwidth, from the windows' power spectra.
    const power = new Float64Array(measured[0]?.power.length ?? 2048);
    for (const r of measured) for (let k = 0; k < power.length; k += 1) power[k] += r.power[k];
    const bandwidthHz = bandwidthFrom(power, rate, bRate / 2) || Math.round(bRate / 2);

    // ---- 2–3. B on A's grid: kept as it is with a shifted index, or converted once to a WAV ----
    ctx.onProgress?.('writing', 0);
    const nonFinite = { replaced: kept?.replaced ?? 0 };
    const opened: OpenedB = kept ? keptB(kept) : openB(input, decoder, signal, nonFinite);
    const firstBlock = await opened.blocks.next();
    const format = await opened.format;
    const bChannels = format.channels;
    // The player reads B itself when it is a file of a format it decodes, at A's rate, with A's
    // channels or one (played on all of them).
    const direct = typeof input === 'string' && mappable(format.layout) && format.sampleRate === rate && (bChannels === channels || bChannels === 1);
    /** B decoded, at A's rate, shifted, padded or trimmed to A's frames, with A's channels. */
    const onGrid = (b: OpenedB, first: IteratorResult<Float32Array[]>, bFormat: { sampleRate: number; channels: number }) => {
        // Resample as few channels as needed: mono A or mono B → one channel.
        const rc = channels === 1 || bFormat.channels === 1 ? 1 : bFormat.channels;
        let frames = 0;
        async function* native(): AsyncGenerator<Float32Array[]> {
            let n = first;
            while (!n.done) {
                if (signal.aborted) throw signal.reason ?? new Error('aborted');
                frames += n.value[0]?.length ?? 0;
                yield rc === 1 && n.value.length > 1 ? [mono(n.value)] : n.value;
                n = await b.blocks.next();
            }
        }
        const atRate = bFormat.sampleRate === rate ? native() : resampleInParallel(native(), bFormat.sampleRate, rate, pool, ctx.prepare.resampler);
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
        return { blocks: aligned(), frames: () => frames };
    };
    const prefix = `${stem}/r${ctx.revision}/`;
    const wavFile = path.join(await ctx.scratch(), `${stem}.wav`);
    let wav: WavSink | null = direct ? null : await sourceWavSink(wavFile, channels, rate);
    try {
        let sab = 0, saa = 0, sbb = 0;
        const sums = new Float64Array(3);
        const perSegment: number[] = [];
        const checks = segmentChecks();
        const grid = onGrid(opened, firstBlock, format);
        const timeline = await writeTimeline({
            source: grid.blocks,
            channels,
            rate,
            storage,
            options: ctx.prepare,
            pool,
            // A's finest level, whatever it is: the player draws A and the stem from the same levels.
            framesPerPeak: checkFramesPerPeak(Math.min(...manifest.peaks.levels.map((l) => l.framesPerPeak))),
            segmentSeconds: fps / rate,
            signal,
            prefix,
            onBlock: wav ? (block) => wav!.write(block) : undefined,
            onSegment: async (index, planes, frames) => {
                if (direct) checks.keep(index, planes, frames);
                const a = await readA(index);
                pairSums(a, planes, channels, frames, sums);
                const ab = sums[0], aa = sums[1], bb = sums[2];
                sab += ab; saa += aa; sbb += bb;
                perSegment.push(Math.round((ab / Math.sqrt(aa * bb + 1e-30)) * 1000) / 1000);
                ctx.onProgress?.('writing', (index + 1) / manifest.segments.list.length);
            },
        });
        if (timeline.totalFrames !== manifest.frames) throw new Error(`stem ${stem}: B came out ${timeline.totalFrames} frames, A has ${manifest.frames}`);
        if (nonFinite.replaced) ctx.onWarning?.(`stems.${stem}: ${nonFinite.replaced} non-finite samples replaced (NaN → 0, ±Infinity → ±1)`);
        const stored = await storeSource({
            storage,
            prefix,
            what: `stems.${stem}`,
            // Non-finite samples were replaced in what was analysed: the file that holds them is not kept.
            file: direct && !nonFinite.replaced ? (input as string) : null,
            layout: format.layout,
            sampleRate: format.sampleRate,
            channels: bChannels,
            sourceFrames: grid.frames(),
            frames: manifest.frames,
            framesPerSegment: fps,
            offset,
            timeline: { rate, channels },
            checks: checks.list(),
            wav,
            wavFile,
            // The index did not read back right: B on A's grid again, into a WAV.
            rewrite: async (sink) => {
                const again = kept ? keptB(kept) : openB(input, decoder, signal, { replaced: 0 }, { on: false });
                const first = await again.blocks.next();
                for await (const block of onGrid(again, first, await again.format).blocks) await sink.write(block);
            },
            onWarning: (message) => ctx.onWarning?.(message),
        });
        wav = null; // ended by storeSource
        const global = sab / Math.sqrt(saa * sbb + 1e-30);
        return {
            status: 'ready',
            updatedAt: new Date().toISOString(),
            aSourceId: manifest.id,
            ...(ctx.processor ? { processor: ctx.processor } : {}),
            id: `sha256:${opened.digest()}`,
            source: {
                name: fileNameOnly(options.name ?? (typeof ctx.input === 'string' ? ctx.input : null)),
                bytes: opened.bytes(),
                sampleRate: format.sampleRate,
                channels: bChannels,
                frames: grid.frames(),
                bandwidthHz,
            },
            alignment,
            correlation: { global: Math.round(global * 1000) / 1000, perSegment },
            mixLaw: global >= 0.5 ? 'crossfade' : 'equal-power',
            loudnessDeltaDb: Math.round((timeline.loudness.gatedRmsDb - manifest.loudness.gatedRmsDb) * 100) / 100,
            gainDb: options.gainDb ?? 0,
            loudness: timeline.loudness,
            segments: { framesPerSegment: fps, source: stored.source, list: stored.list },
            peaks: timeline.peaks,
            ...(timeline.bands ? { bands: timeline.bands } : {}),
            ...(timeline.spectrogram ? { spectrogram: timeline.spectrogram } : {}),
        };
    } finally {
        await wav?.close();
    }
}

/**
 * What a manifest says about a failed stem: the alignment's own reason (it
 * holds only what was measured), a processor's short public message, or the
 * caller's text. Never stderr, URLs or response bodies: those are for the
 * server's log.
 */
function publicStemError(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error instanceof StemAlignmentError) return error.message;
    if (error instanceof StemProcessorError) return error.publicMessage;
    return 'stem could not be made';
}

/** The entry of a stem that was not attached (a public reason, and what was measured). */
export function failedStem(manifest: AudioManifest, error: unknown, extra: Partial<ManifestStem> = {}): ManifestStem {
    return {
        status: 'failed',
        error: publicStemError(error),
        updatedAt: new Date().toISOString(),
        aSourceId: manifest.id,
        ...(error instanceof StemAlignmentError ? { alignment: error.alignment } : {}),
        ...extra,
    };
}
