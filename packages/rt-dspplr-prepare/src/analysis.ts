import type { ManifestLoudness } from '@saitdigital/rt-dspplr/format';
import type { PeakChannelData, PeakLevelData } from '@saitdigital/rt-dspplr/format';

// ---------------------------------------------------------------------------
// Streaming peaks + loudness over planar Float32 blocks of the playback signal.
// Memory: the finest level (6 bytes per channel per 256 frames, ≈ 4 MB for an
// hour of mono at 48 kHz) plus one Float64 sum-of-squares per finest peak.
// ---------------------------------------------------------------------------

export const DEFAULT_FRAMES_PER_PEAK = 256;
export const LEVEL_STEP = 8;
export const MAX_COARSEST_PEAKS = 2048;

/**
 * framesPerPeak, checked: a power of two from 16 to 65536. The analysis jobs
 * are cut on a common multiple of it, the band bin and the spectrogram hop
 * (powers of two too), so anything else would make them huge.
 */
export function checkFramesPerPeak(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 16 || value > 65536 || (value & (value - 1)) !== 0) {
        throw new Error(`framesPerPeak must be a power of two from 16 to 65536, got ${String(value)}`);
    }
    return value;
}

function quantize(value: number): number {
    const v = Math.round(value * 32768);
    return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

const toDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

/** The level ladder for `frames`: finest × 8 until at most MAX_COARSEST_PEAKS peaks. */
export function levelLadder(frames: number, finest = DEFAULT_FRAMES_PER_PEAK, step = LEVEL_STEP, maxCoarsest = MAX_COARSEST_PEAKS): Array<{ framesPerPeak: number; peaks: number }> {
    const out: Array<{ framesPerPeak: number; peaks: number }> = [];
    let fpp = finest;
    for (;;) {
        const peaks = Math.max(1, Math.ceil(frames / fpp));
        out.push({ framesPerPeak: fpp, peaks });
        if (peaks <= maxCoarsest) break;
        fpp *= step;
    }
    return out;
}

export class PeakAnalyzer {
    private readonly _channels: number;
    private readonly _fpp: number;
    private _cap: number;
    private _min: Int16Array[];
    private _max: Int16Array[];
    private _sumSq: Float64Array[];
    /** Finest peaks completed (or started). */
    private _count = 0;
    private _framesInBin = 0;
    private _binMin: Float64Array;
    private _binMax: Float64Array;
    private _binSq: Float64Array;
    private _frames = 0;
    /** Frames in the last finest peak when it is partial (0 = full). */
    private _partialLast = 0;

    // loudness
    private _peak: Float64Array;
    private _sq: Float64Array;
    private readonly _blockFrames: number;
    private _blockSq = 0;
    private _blockN = 0;
    private _blocks: number[] = [];

    constructor(channels: number, sampleRate: number, framesPerPeak = DEFAULT_FRAMES_PER_PEAK, expectedFrames = 0) {
        this._channels = channels;
        this._fpp = framesPerPeak;
        this._cap = Math.max(1024, Math.ceil(expectedFrames / framesPerPeak) + 1);
        this._min = Array.from({ length: channels }, () => new Int16Array(this._cap));
        this._max = Array.from({ length: channels }, () => new Int16Array(this._cap));
        this._sumSq = Array.from({ length: channels }, () => new Float64Array(this._cap));
        this._binMin = new Float64Array(channels).fill(Infinity);
        this._binMax = new Float64Array(channels).fill(-Infinity);
        this._binSq = new Float64Array(channels);
        this._peak = new Float64Array(channels);
        this._sq = new Float64Array(channels);
        this._blockFrames = Math.round(sampleRate * 0.4);
    }

    get frames(): number {
        return this._frames;
    }

    push(block: Float32Array[]): void {
        const n = block[0]?.length ?? 0;
        const C = this._channels;
        const fpp = this._fpp;
        for (let i = 0; i < n; i += 1) {
            let frameSq = 0;
            for (let c = 0; c < C; c += 1) {
                const v = block[c][i];
                if (v < this._binMin[c]) this._binMin[c] = v;
                if (v > this._binMax[c]) this._binMax[c] = v;
                const s = v * v;
                this._binSq[c] += s;
                frameSq += s;
                const a = v < 0 ? -v : v;
                if (a > this._peak[c]) this._peak[c] = a;
            }
            this._blockSq += frameSq;
            this._blockN += 1;
            if (this._blockN === this._blockFrames) this._closeBlock();
            this._framesInBin += 1;
            if (this._framesInBin === fpp) this._closeBin();
        }
        this._frames += n;
    }

    private _closeBlock(): void {
        this._blocks.push(this._blockSq / (this._blockN * this._channels));
        this._blockSq = 0;
        this._blockN = 0;
    }

    private _closeBin(): void {
        if (this._count === this._cap) this._grow();
        const i = this._count;
        for (let c = 0; c < this._channels; c += 1) {
            this._min[c][i] = quantize(this._binMin[c]);
            this._max[c][i] = quantize(this._binMax[c]);
            this._sumSq[c][i] = this._binSq[c];
            this._sq[c] += this._binSq[c];
            this._binMin[c] = Infinity;
            this._binMax[c] = -Infinity;
            this._binSq[c] = 0;
        }
        this._count += 1;
        this._framesInBin = 0;
    }

    private _grow(): void {
        const cap = this._cap * 2;
        const grow16 = (a: Int16Array) => { const b = new Int16Array(cap); b.set(a); return b; };
        const grow64 = (a: Float64Array) => { const b = new Float64Array(cap); b.set(a); return b; };
        this._min = this._min.map(grow16);
        this._max = this._max.map(grow16);
        this._sumSq = this._sumSq.map(grow64);
        this._cap = cap;
    }

    /** Close the last partial peak and build every level. */
    finish(): { levels: PeakLevelData[]; loudness: ManifestLoudness } {
        if (this._framesInBin > 0) {
            // A partial last peak: RMS over the frames it has.
            const frames = this._framesInBin;
            this._closeBin();
            this._partialLast = frames;
        }
        if (this._blockN > 0 && this._blockN >= this._blockFrames / 4) this._closeBlock();
        const frames = new Float64Array(this._count).fill(this._fpp);
        if (this._partialLast) frames[this._count - 1] = this._partialLast;
        const levels = levelsFromFinest(this._channels, this._fpp, this._frames, {
            min: this._min.map((x) => x.subarray(0, this._count)),
            max: this._max.map((x) => x.subarray(0, this._count)),
            sumSq: this._sumSq.map((x) => x.subarray(0, this._count)),
            frames,
        });
        return { levels, loudness: this._loudness() };
    }

    private _loudness(): ManifestLoudness {
        return loudnessFrom(Array.from(this._peak), Array.from(this._sq), this._blocks, this._frames, this._channels);
    }
}

/** Finest-level data of one or more consecutive ranges, concatenated (per channel). */
export interface FinestPeaks {
    min: Int16Array[];
    max: Int16Array[];
    sumSq: Float64Array[];
    /** Frames in each finest peak (fpp, or fewer for the last one). */
    frames: Float64Array;
}

/** Every level of the ladder from the finest one (coarser levels pool the finer ones exactly). */
export function levelsFromFinest(channelCount: number, fpp: number, totalFrames: number, finest: FinestPeaks): PeakLevelData[] {
    const ladder = levelLadder(totalFrames, fpp);
    const levels: PeakLevelData[] = [];
    let prev: FinestPeaks | null = null;
    for (const { framesPerPeak, peaks } of ladder) {
        const channels: PeakChannelData[] = [];
        let cur: FinestPeaks;
        if (!prev) {
            cur = {
                min: finest.min.map((a) => a.subarray(0, peaks)),
                max: finest.max.map((a) => a.subarray(0, peaks)),
                sumSq: finest.sumSq.map((a) => a.subarray(0, peaks)),
                frames: finest.frames.subarray(0, peaks),
            };
        } else {
            const ratio = framesPerPeak / levels[levels.length - 1].framesPerPeak;
            const p: FinestPeaks = prev;
            const frames = new Float64Array(peaks);
            const min = p.min.map(() => new Int16Array(peaks));
            const max = p.max.map(() => new Int16Array(peaks));
            const sumSq = p.sumSq.map(() => new Float64Array(peaks));
            for (let i = 0; i < peaks; i += 1) {
                const from = i * ratio;
                const to = Math.min(p.frames.length, from + ratio);
                for (let j = from; j < to; j += 1) frames[i] += p.frames[j];
                for (let c = 0; c < channelCount; c += 1) {
                    let lo = 32767;
                    let hi = -32768;
                    let sq = 0;
                    for (let j = from; j < to; j += 1) {
                        if (p.min[c][j] < lo) lo = p.min[c][j];
                        if (p.max[c][j] > hi) hi = p.max[c][j];
                        sq += p.sumSq[c][j];
                    }
                    min[c][i] = lo;
                    max[c][i] = hi;
                    sumSq[c][i] = sq;
                }
            }
            cur = { min, max, sumSq, frames };
        }
        for (let c = 0; c < channelCount; c += 1) {
            const rms = new Int16Array(peaks);
            for (let i = 0; i < peaks; i += 1) rms[i] = quantize(Math.sqrt(cur.sumSq[c][i] / Math.max(1, cur.frames[i])));
            channels.push({ min: cur.min[c], max: cur.max[c], rms });
        }
        levels.push({ framesPerPeak, peaks, channels });
        prev = cur;
    }
    return levels;
}

/** Loudness summary from per-channel peaks and sums of squares and 400 ms block mean squares. */
export function loudnessFrom(peaks: number[], sq: number[], blocks: number[], frames: number, channelCount: number): ManifestLoudness {
    const n = Math.max(1, frames);
    const perChannel = peaks.map((p, c) => ({ peakDb: toDb(p), rmsDb: toDb(Math.sqrt(sq[c] / n)) }));
    const peak = Math.max(...peaks);
    const totalSq = sq.reduce((a, b) => a + b, 0);
    const absGate = 10 ** (-70 / 10);
    const above = blocks.filter((ms) => ms > absGate);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const relGate = mean(above) * 10 ** (-10 / 10);
    const gated = above.filter((ms) => ms > relGate);
    const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : -999);
    return {
        peak: Math.round(peak * 1e6) / 1e6,
        peakDb: round(toDb(peak)),
        rmsDb: round(toDb(Math.sqrt(totalSq / (n * channelCount)))),
        gatedRmsDb: round(10 * Math.log10(mean(gated) || 1e-30)),
        perChannel: perChannel.map((ch) => ({ peakDb: round(ch.peakDb), rmsDb: round(ch.rmsDb) })),
    };
}

/** quantize() for callers outside this module. */
export const quantizePeak = quantize;
