import { designResampler, resampleRange, type ResamplerOptions } from './resampler';
import { runCorrelate, type CorrelateJob, type CorrelateResult } from './correlate';
import { quantizePeak } from './analysis';
import { BandEnergyAnalyzer, OverviewSpectrogramAnalyzer } from './overviewAnalysis';
import { installSpectralBackend } from './wasm/spectral';
import { wasmPeaksStereo } from './wasm/kernels';

// The spectrogram's FFT on pffft, here and in every worker (this module is the jobs' code in both).
installSpectralBackend();

// ---------------------------------------------------------------------------
// The analyses of prepare (peaks, band energies, overview spectrogram) cut
// into fixed JOBS of the timeline, so they run in parallel (worker_threads)
// beside the single decode pass.
//
// The cut does not depend on the concurrency: a job always covers the same
// frames, aligned to every bin size involved (finest peak, band bin,
// spectrogram hop), and gets the same warm-up before it. The output is a
// pure function of the jobs, so 1 thread and N threads write byte-identical
// files (tested).
//
//   peaks        bins are aligned: no overlap needed.
//   spectrogram  a frame centred in the job only reads samples inside it
//                (window ≤ hop): no overlap needed.
//   bands        IIR filters: each job first runs WARMUP frames of the audio
//                before it through freshly reset filters (≈ 1 s, ≫ their decay
//                time at 25 Hz), then measures.
// ---------------------------------------------------------------------------

/** Frames of filter warm-up before a job (a multiple of every bin size). */
export const WARMUP_FRAMES = 49152;

export interface JobSpec {
    index: number;
    /** Timeline frame of the job's first measured sample. */
    startFrame: number;
    /** Frames measured (the last job may be shorter). */
    frames: number;
    /** Warm-up frames in `channels` before startFrame. */
    warmup: number;
    final: boolean;
    sampleRate: number;
    framesPerPeak: number;
    bands: boolean;
    spectrogram: boolean;
    /** warmup + frames samples per channel. */
    channels: Float32Array[];
}

export interface JobResult {
    index: number;
    /** Finest bins of framesPerPeak frames each (the timeline's last one may hold fewer). */
    peaks: { min: Int16Array[]; max: Int16Array[]; sumSq: Float64Array[]; peak: number[] };
    bands: { meanSquares: Float32Array; bins: number; cutoffs: number[]; framesPerBin: number } | null;
    spectrogram: { a: Uint8Array; columns: number; reference: number; hop: number; rows: number; minHz: number; maxHz: number } | null;
}

/** Frames per job: a multiple of every bin size, ≥ ~0.6 M frames (≈ 12.8 s at 48 kHz). */
export function jobFrames(framesPerPeak: number, bandBin: number, hop: number): number {
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    const lcm = [framesPerPeak, bandBin, hop].reduce((a, b) => (a * b) / gcd(a, b), 1);
    return lcm * Math.max(1, Math.ceil(614400 / lcm));
}

/** One channel's finest peaks (min, max, Σx² per bin); returns its peak |x|. */
function peakBins(x: Float32Array, warmup: number, frames: number, fpp: number, bins: number, min: Int16Array, max: Int16Array, sumSq: Float64Array): number {
    let p = 0;
    for (let b = 0; b < bins; b += 1) {
        const from = warmup + b * fpp;
        const to = Math.min(warmup + frames, from + fpp);
        let lo = Infinity;
        let hi = -Infinity;
        let sq = 0;
        for (let i = from; i < to; i += 1) {
            const v = x[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
            sq += v * v;
        }
        min[b] = quantizePeak(lo);
        max[b] = quantizePeak(hi);
        sumSq[b] = sq;
        const a = Math.max(-lo, hi);
        if (a > p) p = a;
    }
    return p;
}

/** peakBins()'s outputs for two channels from wasmPeaksStereo()'s lanes (lo, hi, Σx² per bin, each l then r). */
function peaksFromLanes(v: Float64Array, bins: number, min: Int16Array[], max: Int16Array[], sumSq: Float64Array[], peak: number[]): void {
    for (let b = 0; b < bins; b += 1) {
        const o = 6 * b;
        for (let c = 0; c < 2; c += 1) {
            const lo = v[o + c];
            const hi = v[o + 2 + c];
            min[c][b] = quantizePeak(lo);
            max[c][b] = quantizePeak(hi);
            sumSq[c][b] = v[o + 4 + c];
            const a = Math.max(-lo, hi);
            if (a > peak[c]) peak[c] = a;
        }
    }
}

/**
 * channels[from, to) into an analyzer in chunks of PUSH_CHUNK frames. Both analyzers are
 * chunk-invariant (their sums see the samples in the same order), and a chunk keeps their
 * scratch buffers small and in cache instead of job-sized (2 × 4.9 MB of Float64 per job).
 */
const PUSH_CHUNK = 16384;
function pushChunked(analyzer: { push(block: Float32Array[]): void }, channels: Float32Array[], from: number, to: number): void {
    for (let o = from; o < to; o += PUSH_CHUNK) {
        const e = Math.min(to, o + PUSH_CHUNK);
        analyzer.push(channels.map((x) => x.subarray(o, e)));
    }
}

export function analyzeJob(job: JobSpec): JobResult {
    const { channels, warmup, frames, framesPerPeak: fpp } = job;
    const C = channels.length;
    // ---- peaks (finest level) --------------------------------------------------------
    const bins = Math.ceil(frames / fpp);
    const min = Array.from({ length: C }, () => new Int16Array(bins));
    const max = Array.from({ length: C }, () => new Int16Array(bins));
    const sumSq = Array.from({ length: C }, () => new Float64Array(bins));
    const peak = new Array<number>(C).fill(0);
    // Two channels in WebAssembly (both at once, the same numbers), else channel by channel.
    const both = C === 2 ? wasmPeaksStereo(channels[0].subarray(warmup), channels[1].subarray(warmup), frames, fpp) : null;
    if (both) peaksFromLanes(both, bins, min, max, sumSq, peak);
    else for (let c = 0; c < C; c += 1) peak[c] = peakBins(channels[c], warmup, frames, fpp, bins, min[c], max[c], sumSq[c]);

    // ---- band energies ----------------------------------------------------------------
    let bands: JobResult['bands'] = null;
    if (job.bands) {
        const analyzer = new BandEnergyAnalyzer(C, job.sampleRate, undefined, undefined, frames);
        analyzer.setFramePosition(job.startFrame - warmup);
        if (warmup > 0) {
            pushChunked(analyzer, channels, 0, warmup);
            analyzer.startMeasuring();
        }
        pushChunked(analyzer, channels, warmup, warmup + frames);
        const file = analyzer.finish();
        bands = { meanSquares: file.meanSquares, bins: file.bins, cutoffs: file.cutoffs, framesPerBin: file.framesPerBin };
    }

    // ---- overview spectrogram (finest level) ----------------------------------------------
    let spectrogram: JobResult['spectrogram'] = null;
    if (job.spectrogram) {
        const analyzer = new OverviewSpectrogramAnalyzer(C, job.sampleRate, {}, frames);
        pushChunked(analyzer, channels, warmup, warmup + frames);
        const file = analyzer.finish();
        const level = file.levels[0];
        spectrogram = {
            a: level.a!,
            columns: level.columns,
            reference: file.referenceMax,
            hop: level.hop,
            rows: file.rows,
            minHz: file.minHz,
            maxHz: file.maxHz,
        };
    }

    return { index: job.index, peaks: { min, max, sumSq, peak }, bands, spectrogram };
}

/** Transferable buffers of a result (zero-copy back to the main thread). */
export function resultTransfers(r: JobResult): ArrayBuffer[] {
    const out: ArrayBuffer[] = [];
    for (const a of [...r.peaks.min, ...r.peaks.max, ...r.peaks.sumSq]) out.push(a.buffer as ArrayBuffer);
    if (r.bands) out.push(r.bands.meanSquares.buffer as ArrayBuffer);
    if (r.spectrogram) out.push(r.spectrogram.a.buffer as ArrayBuffer);
    return [...new Set(out)];
}

// ---- resampling jobs ---------------------------------------------------------------------
// A chunk of the timeline resampled from its slice of the input (with the
// filter's half-length of context on each side): bit-identical to the
// streaming resampler (resampleRange), so any chunking / thread count gives
// the same bytes.

export interface ResampleJob {
    kind: 'resample';
    index: number;
    from: number;
    to: number;
    options?: ResamplerOptions;
    /** Input index of channels[c][0]. */
    xStart: number;
    /** Total input frames when known (zeros beyond), else Infinity. */
    inFrames: number;
    n0: number;
    n1: number;
    channels: Float32Array[];
}

export interface ResampleResult {
    kind: 'resample';
    index: number;
    channels: Float32Array[];
}

export type AnyJob = JobSpec | ResampleJob | CorrelateJob;
export type AnyResult = JobResult | ResampleResult | CorrelateResult;

const designs = new Map<string, ReturnType<typeof designResampler>>();

export function resamplerDesign(from: number, to: number, options?: ResamplerOptions): ReturnType<typeof designResampler> {
    const key = `${from}:${to}:${options?.passbandHz ?? ''}:${options?.stopbandHz ?? ''}:${options?.stopbandDb ?? ''}`;
    let d = designs.get(key);
    if (!d) {
        d = designResampler(from, to, options);
        designs.set(key, d);
    }
    return d;
}

export function runJob(job: AnyJob): AnyResult {
    if ((job as CorrelateJob).kind === 'correlate') return runCorrelate(job as CorrelateJob);
    if ((job as ResampleJob).kind === 'resample') {
        const r = job as ResampleJob;
        return { kind: 'resample', index: r.index, channels: resampleRange(resamplerDesign(r.from, r.to, r.options), r.channels, r.xStart, r.inFrames, r.n0, r.n1) };
    }
    return analyzeJob(job as JobSpec);
}

/** What a job hands over to its worker: its channels (a correlate job's windows are copied, they are small). */
export function jobTransfers(job: AnyJob): ArrayBuffer[] {
    if ((job as CorrelateJob).kind === 'correlate') return [];
    return (job as JobSpec | ResampleJob).channels.map((c) => c.buffer as ArrayBuffer);
}

export function anyResultTransfers(r: AnyResult): ArrayBuffer[] {
    if ((r as CorrelateResult).kind === 'correlate') return [(r as CorrelateResult).power.buffer as ArrayBuffer];
    if ((r as ResampleResult).kind === 'resample') return (r as ResampleResult).channels.map((c) => c.buffer as ArrayBuffer);
    return resultTransfers(r as JobResult);
}
