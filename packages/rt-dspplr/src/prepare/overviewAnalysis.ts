import { computeHighPassCoefficients, HIGH_PASS_SECTION_Q } from '../core/dsp/highPass';
import { DEFAULT_BAND_CUTOFFS, DEFAULT_FRAMES_PER_BAND_BIN, type BandsFile } from '../core/stream/bandsFile';
import type { SpectrogramFile } from '../core/stream/spectrogramFile';
import { frameRows, planBands, PYRAMID_BANDS, quantizeRows } from '../core/spectrogram/spectral';

// ---------------------------------------------------------------------------
// Streaming analyses for the overview previews, fed the playback signal:
//   BandEnergyAnalyzer   bands.bin   — low-passed energies for the HP preview
//   SpectrogramAnalyzer  spectrogram.bin — the overview spectrogram
// Both work on the mono downmix and hold O(output) memory only.
// ---------------------------------------------------------------------------

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** RBJ low-pass section; two with HIGH_PASS_SECTION_Q make the 4th-order Butterworth twin of the player's high-pass. */
export function lowPassSection(sampleRate: number, hz: number, q: number): Biquad {
    const w = (2 * Math.PI * Math.min(hz, sampleRate * 0.45)) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    return { b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/**
 * High-passed energies per bin, through the player's own 4th-order
 * Butterworth high-pass at each cutoff — measured directly, never as a
 * difference, so a bin where the high-pass removes nearly everything (hum,
 * rumble) still gets an accurate small number.
 *
 * Cheaply: the signal is split at ≈ 4.8 kHz into a low band (4th-order
 * low-pass, decimated to ≈ 12 kHz, where the cutoffs' high-passes run) and a
 * high band (4th-order high-pass at the full rate, energy only). A Butterworth
 * low/high pair is power-complementary, so
 *   E_hp(fc) ≈ E[ HP_fc(low band) ] + E[ high band ]   (fc ≤ 566 Hz ≪ fs).
 * What aliases into the low band from 7–12 kHz is already 40+ dB down.
 */
export class BandEnergyAnalyzer {
    readonly cutoffs: number[];
    readonly framesPerBin: number;
    readonly decimation: number;
    private readonly _sampleRate: number;
    private readonly _channels: number;
    private readonly _pre: Biquad[];
    private readonly _preState = new Float64Array(8);
    private readonly _top: Biquad[];
    private readonly _topState = new Float64Array(8);
    private _accTop = 0;
    private readonly _sections: Biquad[];
    /** Per section: x1, x2, y1, y2. */
    private readonly _state: Float64Array;
    private readonly _acc: Float64Array;
    private _accN = 0;
    private _accLowN = 0;
    private _frame = 0;
    private _values: Float32Array;
    private _bins = 0;

    constructor(channels: number, sampleRate: number, cutoffs: readonly number[] = DEFAULT_BAND_CUTOFFS, framesPerBin = DEFAULT_FRAMES_PER_BAND_BIN, expectedFrames = 0) {
        this._channels = channels;
        this._sampleRate = sampleRate;
        this.framesPerBin = framesPerBin;
        this.decimation = Math.max(1, Math.floor(sampleRate / 12000));
        const lowRate = sampleRate / this.decimation;
        this.cutoffs = cutoffs.filter((c) => c < lowRate * 0.3);
        this._pre = this.decimation > 1 ? HIGH_PASS_SECTION_Q.map((q) => lowPassSection(sampleRate, lowRate * 0.4, q)) : [];
        this._top = this.decimation > 1 ? HIGH_PASS_SECTION_Q.map((q) => computeHighPassCoefficients(sampleRate, lowRate * 0.4, q)) : [];
        this._sections = this.cutoffs.flatMap((c) => HIGH_PASS_SECTION_Q.map((q) => computeHighPassCoefficients(lowRate, c, q)));
        this._state = new Float64Array(this._sections.length * 4);
        this._acc = new Float64Array(1 + this.cutoffs.length);
        this._values = new Float32Array(Math.max(16, Math.ceil(expectedFrames / framesPerBin) + 1) * (1 + this.cutoffs.length));
    }

    push(block: Float32Array[]): void {
        const n = block[0]?.length ?? 0;
        const C = this._channels;
        const K = this.cutoffs.length;
        const s = this._sections;
        const st = this._state;
        const acc = this._acc;
        const inv = 1 / C;
        const D = this.decimation;
        const pre = this._pre;
        const ps = this._preState;
        for (let i = 0; i < n; i += 1) {
            let x = 0;
            for (let c = 0; c < C; c += 1) x += block[c][i];
            x *= inv;
            acc[0] += x * x;
            this._accN += 1;
            let t = x;
            for (let j = 0; j < this._top.length; j += 1) {
                const f = this._top[j];
                const o = j * 4;
                const ts = this._topState;
                const y = f.b0 * t + f.b1 * ts[o] + f.b2 * ts[o + 1] - f.a1 * ts[o + 2] - f.a2 * ts[o + 3];
                ts[o + 1] = ts[o];
                ts[o] = t;
                ts[o + 3] = ts[o + 2];
                ts[o + 2] = y;
                t = y;
            }
            if (this._top.length) this._accTop += t * t;
            let v = x;
            for (let j = 0; j < pre.length; j += 1) {
                const f = pre[j];
                const o = j * 4;
                const y = f.b0 * v + f.b1 * ps[o] + f.b2 * ps[o + 1] - f.a1 * ps[o + 2] - f.a2 * ps[o + 3];
                ps[o + 1] = ps[o];
                ps[o] = v;
                ps[o + 3] = ps[o + 2];
                ps[o + 2] = y;
                v = y;
            }
            if (this._frame % D === 0) {
                const input = v;
                for (let k = 0; k < K; k += 1) {
                    let u = input;
                    for (let j = 0; j < 2; j += 1) {
                        const f = s[2 * k + j];
                        const o = (2 * k + j) * 4;
                        const y = f.b0 * u + f.b1 * st[o] + f.b2 * st[o + 1] - f.a1 * st[o + 2] - f.a2 * st[o + 3];
                        st[o + 1] = st[o];
                        st[o] = u;
                        st[o + 3] = st[o + 2];
                        st[o + 2] = y;
                        u = y;
                    }
                    acc[1 + k] += u * u;
                }
                this._accLowN += 1;
            }
            this._frame += 1;
            if (this._accN === this.framesPerBin) this._close();
        }
    }

    /**
     * Discard what was measured so far but keep the filters' state: the warm-up
     * of a parallel job, so its first bin sees settled filters.
     */
    /** Absolute timeline frame of the next sample pushed (keeps the decimation phase of parallel jobs). */
    setFramePosition(frame: number): void {
        this._frame = frame;
    }

    startMeasuring(): void {
        this._acc.fill(0);
        this._accTop = 0;
        this._accN = 0;
        this._accLowN = 0;
        this._bins = 0;
    }

    private _close(): void {
        const width = 1 + this.cutoffs.length;
        if ((this._bins + 1) * width > this._values.length) {
            const next = new Float32Array(this._values.length * 2);
            next.set(this._values);
            this._values = next;
        }
        this._values[this._bins * width] = this._acc[0] / Math.max(1, this._accN);
        this._acc[0] = 0;
        const top = this._accTop / Math.max(1, this._accN);
        for (let k = 1; k < width; k += 1) {
            this._values[this._bins * width + k] = this._acc[k] / Math.max(1, this._accLowN) + top;
            this._acc[k] = 0;
        }
        this._accTop = 0;
        this._bins += 1;
        this._accN = 0;
        this._accLowN = 0;
    }

    finish(): BandsFile {
        if (this._accN > 0) this._close();
        const width = 1 + this.cutoffs.length;
        return {
            sampleRate: this._sampleRate,
            framesPerBin: this.framesPerBin,
            bins: this._bins,
            cutoffs: [...this.cutoffs],
            meanSquares: this._values.slice(0, this._bins * width),
        };
    }
}

export const SPECTROGRAM_ROWS = 128;
/** Absolute 8-bit scale: 255 at +60 dB (above a full-scale sine at the 2048-point scale, ≈ +54 dB), 0.47 dB per step. */
export const SPECTROGRAM_TOP_DB = 60;
export const SPECTROGRAM_RANGE_DB = 120;
export const SPECTROGRAM_LEVEL_STEP = 8;

export interface SpectrogramAnalyzerOptions {
    rows?: number;
    minHz?: number;
    maxHz?: number;
    /** Frames per column of the finest level. Default 4096 at 44.1/48 kHz (≈ 85–93 ms). */
    hop?: number;
}

export class OverviewSpectrogramAnalyzer {
    readonly rows: number;
    readonly hop: number;
    readonly minHz: number;
    readonly maxHz: number;
    private readonly _sampleRate: number;
    private readonly _channels: number;
    private readonly _layout: ReturnType<typeof planBands>;
    private readonly _reach: number;
    /** Mono Int16 samples kept; _buf[0] is timeline frame _base. */
    private _buf: Int16Array;
    private _len = 0;
    private _base = 0;
    private _received = 0;
    private _next = 0;
    private _out: Uint8Array;
    private readonly _sum: Float32Array;
    private _reference = 0;

    constructor(channels: number, sampleRate: number, options: SpectrogramAnalyzerOptions = {}, expectedFrames = 0) {
        this._channels = channels;
        this._sampleRate = sampleRate;
        this.rows = options.rows ?? SPECTROGRAM_ROWS;
        this.minHz = options.minHz ?? 30;
        this.maxHz = Math.min(options.maxHz ?? 16000, sampleRate / 2);
        this.hop = options.hop ?? (sampleRate >= 44100 ? 4096 : 2048);
        this._layout = planBands(sampleRate, this.rows, this.minHz, this.maxHz, PYRAMID_BANDS);
        this._reach = Math.max(...PYRAMID_BANDS.map((b) => b.fftSize)) / 2 + 1;
        this._buf = new Int16Array(this.hop * 4 + this._reach * 2);
        this._out = new Uint8Array(Math.max(16, Math.ceil(expectedFrames / this.hop) + 1) * this.rows);
        this._sum = new Float32Array(this.rows);
    }

    push(block: Float32Array[]): void {
        const n = block[0]?.length ?? 0;
        if (this._len + n > this._buf.length) {
            const next = new Int16Array(Math.max(this._buf.length * 2, this._len + n));
            next.set(this._buf.subarray(0, this._len));
            this._buf = next;
        }
        // The spectrogram worker's downmix: mean of the channels, 16-bit.
        const scale = 32767 / Math.max(1, this._channels);
        for (let i = 0; i < n; i += 1) {
            let s = 0;
            for (let c = 0; c < this._channels; c += 1) s += block[c][i];
            const v = Math.round(s * scale);
            this._buf[this._len + i] = v > 32767 ? 32767 : v < -32767 ? -32767 : v;
        }
        this._len += n;
        this._received += n;
        this._run(false);
    }

    private _run(final: boolean): void {
        const columns = final ? Math.max(1, Math.ceil(this._received / this.hop)) : Infinity;
        const view = () => this._buf.subarray(0, this._len);
        while (this._next < columns) {
            const centre = (this._next + 0.5) * this.hop;
            if (!final && centre + this._reach > this._received) break;
            if ((this._next + 1) * this.rows > this._out.length) {
                const grown = new Uint8Array(this._out.length * 2);
                grown.set(this._out);
                this._out = grown;
            }
            // Beyond what has been received the worker sees zeros; so does this (loadFrame bounds).
            frameRows(view(), centre - this._base, this._layout, this._sum);
            // The loudest bin of the 2048-point band: the worker's reference scale.
            const reference = this._layout.bands.find((b) => b.fft.size === 2048)?.fft.spectrum;
            if (reference) for (let k = 0; k < reference.length; k += 1) if (reference[k] > this._reference) this._reference = reference[k];
            quantizeRows(this._sum, SPECTROGRAM_TOP_DB, SPECTROGRAM_RANGE_DB, this._out, this._next * this.rows);
            this._next += 1;
        }
        // Drop samples no frame will need again.
        const keepFrom = Math.floor((this._next + 0.5) * this.hop - this._reach) - 1;
        const drop = Math.min(this._len, Math.max(0, keepFrom - this._base));
        if (drop > 0) {
            this._buf.copyWithin(0, drop, this._len);
            this._len -= drop;
            this._base += drop;
        }
    }

    finish(): SpectrogramFile {
        this._run(true);
        const rows = this.rows;
        const levels = spectrogramLevels(this._out.slice(0, this._next * rows), this._next, rows, this.hop);
        return {
            sampleRate: this._sampleRate,
            rows,
            frames: this._received,
            minHz: this.minHz,
            maxHz: this.maxHz,
            topDb: SPECTROGRAM_TOP_DB,
            rangeDb: SPECTROGRAM_RANGE_DB,
            referenceMax: this._reference,
            levels,
        };
    }
}

/** The finest level and its ×8 pooled levels (the louder of each group, row by row), down to ≤ 512 columns. */
export function spectrogramLevels(finest: Uint8Array, columns: number, rows: number, hop: number): SpectrogramFile['levels'] {
    const levels: SpectrogramFile['levels'] = [{ hop, columns, a: finest }];
    while (levels[levels.length - 1].columns > 512) {
        const prev = levels[levels.length - 1];
        const count = Math.ceil(prev.columns / SPECTROGRAM_LEVEL_STEP);
        const a = new Uint8Array(count * rows);
        for (let c = 0; c < count; c += 1) {
            const to = Math.min(prev.columns, (c + 1) * SPECTROGRAM_LEVEL_STEP);
            for (let f = c * SPECTROGRAM_LEVEL_STEP; f < to; f += 1) {
                for (let r = 0; r < rows; r += 1) {
                    const v = prev.a![f * rows + r];
                    if (v > a[c * rows + r]) a[c * rows + r] = v;
                }
            }
        }
        levels.push({ hop: prev.hop * SPECTROGRAM_LEVEL_STEP, columns: count, a });
    }
    return levels;
}
