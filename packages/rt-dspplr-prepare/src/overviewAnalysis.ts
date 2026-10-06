import { computeHighPassCoefficients, HIGH_PASS_SECTION_Q } from '@saitdigital/rt-dspplr/format';
import { wasmCutoffPairs, wasmMonoI16Stereo, wasmSplitBands } from './wasm/kernels';
import { DEFAULT_BAND_CUTOFFS, DEFAULT_FRAMES_PER_BAND_BIN, type BandsFile } from '@saitdigital/rt-dspplr/format';
import type { SpectrogramFile } from '@saitdigital/rt-dspplr/format';
import { frameRows, planBands, PYRAMID_BANDS, quantizeRows } from '@saitdigital/rt-dspplr/format';

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
/** Sections' coefficients side by side: b0, b1, b2, a1, a2 each. */
function flat(sections: Biquad[]): Float64Array {
    const out = new Float64Array(sections.length * 5);
    sections.forEach((f, j) => out.set([f.b0, f.b1, f.b2, f.a1, f.a2], j * 5));
    return out;
}

/** Section `j` of `coef` over src[from, to) into dst (may be src), its state (x1, x2, y1, y2 at 4j) kept in `state`. */
function cascade(coef: Float64Array, j: number, state: Float64Array, src: Float64Array, dst: Float64Array, from: number, to: number): void {
    const f = j * 5;
    const o = j * 4;
    const b0 = coef[f], b1 = coef[f + 1], b2 = coef[f + 2], a1 = coef[f + 3], a2 = coef[f + 4];
    let x1 = state[o], x2 = state[o + 1], y1 = state[o + 2], y2 = state[o + 3];
    for (let i = from; i < to; i += 1) {
        const x = src[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        dst[i] = y;
    }
    state[o] = x1;
    state[o + 1] = x2;
    state[o + 2] = y1;
    state[o + 3] = y2;
}

/** Sections j and j + 1 of `coef` in series over src[from, to) into dst (may be src), in one pass. */
function cascade2(coef: Float64Array, j: number, state: Float64Array, src: Float64Array, dst: Float64Array, from: number, to: number): void {
    const f = j * 5, g = f + 5;
    const o = j * 4, p = o + 4;
    const b0 = coef[f], b1 = coef[f + 1], b2 = coef[f + 2], a1 = coef[f + 3], a2 = coef[f + 4];
    const d0 = coef[g], d1 = coef[g + 1], d2 = coef[g + 2], e1 = coef[g + 3], e2 = coef[g + 4];
    let x1 = state[o], x2 = state[o + 1], y1 = state[o + 2], y2 = state[o + 3];
    let u1 = state[p], u2 = state[p + 1], v1 = state[p + 2], v2 = state[p + 3];
    for (let i = from; i < to; i += 1) {
        const x = src[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        const v = d0 * y + d1 * u1 + d2 * u2 - e1 * v1 - e2 * v2;
        u2 = u1;
        u1 = y;
        v2 = v1;
        v1 = v;
        dst[i] = v;
    }
    state[o] = x1;
    state[o + 1] = x2;
    state[o + 2] = y1;
    state[o + 3] = y2;
    state[p] = u1;
    state[p + 1] = u2;
    state[p + 2] = v1;
    state[p + 3] = v2;
}

/**
 * Σx² (into sums[0]), the top band's energy (its two sections, into sums[1]) and the low band
 * (the pre sections, into dst) over x[from, to) in one pass: three independent dependency chains
 * the CPU overlaps. Each value is computed with the exact expressions of cascade2() and the
 * energy loops, in the same order, so every number is the same.
 */
function splitBands(top: Float64Array, ts: Float64Array, pre: Float64Array, ps: Float64Array, x: Float64Array, dst: Float64Array, from: number, to: number, sums: Float64Array): void {
    const tb0 = top[0], tb1 = top[1], tb2 = top[2], ta1 = top[3], ta2 = top[4];
    const td0 = top[5], td1 = top[6], td2 = top[7], te1 = top[8], te2 = top[9];
    const pb0 = pre[0], pb1 = pre[1], pb2 = pre[2], pa1 = pre[3], pa2 = pre[4];
    const pd0 = pre[5], pd1 = pre[6], pd2 = pre[7], pe1 = pre[8], pe2 = pre[9];
    let tx1 = ts[0], tx2 = ts[1], ty1 = ts[2], ty2 = ts[3], tu1 = ts[4], tu2 = ts[5], tv1 = ts[6], tv2 = ts[7];
    let px1 = ps[0], px2 = ps[1], py1 = ps[2], py2 = ps[3], pu1 = ps[4], pu2 = ps[5], pv1 = ps[6], pv2 = ps[7];
    let e = sums[0];
    let t = sums[1];
    for (let i = from; i < to; i += 1) {
        const xv = x[i];
        e += xv * xv;
        // top: cascade2(topCoef, 0, …) then t += w[i] * w[i]
        const ty = tb0 * xv + tb1 * tx1 + tb2 * tx2 - ta1 * ty1 - ta2 * ty2;
        tx2 = tx1;
        tx1 = xv;
        ty2 = ty1;
        ty1 = ty;
        const tv = td0 * ty + td1 * tu1 + td2 * tu2 - te1 * tv1 - te2 * tv2;
        tu2 = tu1;
        tu1 = ty;
        tv2 = tv1;
        tv1 = tv;
        t += tv * tv;
        // pre: cascade2(preCoef, 0, …) into dst
        const py = pb0 * xv + pb1 * px1 + pb2 * px2 - pa1 * py1 - pa2 * py2;
        px2 = px1;
        px1 = xv;
        py2 = py1;
        py1 = py;
        const pv = pd0 * py + pd1 * pu1 + pd2 * pu2 - pe1 * pv1 - pe2 * pv2;
        pu2 = pu1;
        pu1 = py;
        pv2 = pv1;
        pv1 = pv;
        dst[i] = pv;
    }
    ts[0] = tx1; ts[1] = tx2; ts[2] = ty1; ts[3] = ty2; ts[4] = tu1; ts[5] = tu2; ts[6] = tv1; ts[7] = tv2;
    ps[0] = px1; ps[1] = px2; ps[2] = py1; ps[3] = py2; ps[4] = pu1; ps[5] = pu2; ps[6] = pv1; ps[7] = pv2;
    sums[0] = e;
    sums[1] = t;
}

/** Two cutoffs (sections j…j+3 of coef) over d[0, m), their energies added to acc[ak], acc[ak + 1]: cascade2's arithmetic, two chains per pass. */
function cutoffPair(coef: Float64Array, j: number, state: Float64Array, d: Float64Array, m: number, acc: Float64Array, ak: number): void {
    const f = j * 5;
    const o = j * 4;
    const ab0 = coef[f], ab1 = coef[f + 1], ab2 = coef[f + 2], aa1 = coef[f + 3], aa2 = coef[f + 4];
    const ad0 = coef[f + 5], ad1 = coef[f + 6], ad2 = coef[f + 7], ae1 = coef[f + 8], ae2 = coef[f + 9];
    const bb0 = coef[f + 10], bb1 = coef[f + 11], bb2 = coef[f + 12], ba1 = coef[f + 13], ba2 = coef[f + 14];
    const bd0 = coef[f + 15], bd1 = coef[f + 16], bd2 = coef[f + 17], be1 = coef[f + 18], be2 = coef[f + 19];
    let ax1 = state[o], ax2 = state[o + 1], ay1 = state[o + 2], ay2 = state[o + 3];
    let au1 = state[o + 4], au2 = state[o + 5], av1 = state[o + 6], av2 = state[o + 7];
    let bx1 = state[o + 8], bx2 = state[o + 9], by1 = state[o + 10], by2 = state[o + 11];
    let bu1 = state[o + 12], bu2 = state[o + 13], bv1 = state[o + 14], bv2 = state[o + 15];
    let ea = acc[ak];
    let eb = acc[ak + 1];
    for (let i = 0; i < m; i += 1) {
        const xv = d[i];
        const ay = ab0 * xv + ab1 * ax1 + ab2 * ax2 - aa1 * ay1 - aa2 * ay2;
        ax2 = ax1;
        ax1 = xv;
        ay2 = ay1;
        ay1 = ay;
        const av = ad0 * ay + ad1 * au1 + ad2 * au2 - ae1 * av1 - ae2 * av2;
        au2 = au1;
        au1 = ay;
        av2 = av1;
        av1 = av;
        ea += av * av;
        const by = bb0 * xv + bb1 * bx1 + bb2 * bx2 - ba1 * by1 - ba2 * by2;
        bx2 = bx1;
        bx1 = xv;
        by2 = by1;
        by1 = by;
        const bv = bd0 * by + bd1 * bu1 + bd2 * bu2 - be1 * bv1 - be2 * bv2;
        bu2 = bu1;
        bu1 = by;
        bv2 = bv1;
        bv1 = bv;
        eb += bv * bv;
    }
    state[o] = ax1; state[o + 1] = ax2; state[o + 2] = ay1; state[o + 3] = ay2;
    state[o + 4] = au1; state[o + 5] = au2; state[o + 6] = av1; state[o + 7] = av2;
    state[o + 8] = bx1; state[o + 9] = bx2; state[o + 10] = by1; state[o + 11] = by2;
    state[o + 12] = bu1; state[o + 13] = bu2; state[o + 14] = bv1; state[o + 15] = bv2;
    acc[ak] = ea;
    acc[ak + 1] = eb;
}

/** One cutoff (sections j, j+1) over d[0, m), its energy added to acc[ak]. */
function cutoffOne(coef: Float64Array, j: number, state: Float64Array, d: Float64Array, m: number, acc: Float64Array, ak: number): void {
    const f = j * 5;
    const o = j * 4;
    const ab0 = coef[f], ab1 = coef[f + 1], ab2 = coef[f + 2], aa1 = coef[f + 3], aa2 = coef[f + 4];
    const ad0 = coef[f + 5], ad1 = coef[f + 6], ad2 = coef[f + 7], ae1 = coef[f + 8], ae2 = coef[f + 9];
    let ax1 = state[o], ax2 = state[o + 1], ay1 = state[o + 2], ay2 = state[o + 3];
    let au1 = state[o + 4], au2 = state[o + 5], av1 = state[o + 6], av2 = state[o + 7];
    let ea = acc[ak];
    for (let i = 0; i < m; i += 1) {
        const xv = d[i];
        const ay = ab0 * xv + ab1 * ax1 + ab2 * ax2 - aa1 * ay1 - aa2 * ay2;
        ax2 = ax1;
        ax1 = xv;
        ay2 = ay1;
        ay1 = ay;
        const av = ad0 * ay + ad1 * au1 + ad2 * au2 - ae1 * av1 - ae2 * av2;
        au2 = au1;
        au1 = ay;
        av2 = av1;
        av1 = av;
        ea += av * av;
    }
    state[o] = ax1; state[o + 1] = ax2; state[o + 2] = ay1; state[o + 3] = ay2;
    state[o + 4] = au1; state[o + 5] = au2; state[o + 6] = av1; state[o + 7] = av2;
    acc[ak] = ea;
}

/** All sections of `coef` in series (pairs in one pass). */
function series(coef: Float64Array, state: Float64Array, src: Float64Array, dst: Float64Array, from: number, to: number): void {
    const n = coef.length / 5;
    let j = 0;
    let input = src;
    for (; j + 1 < n; j += 2) {
        cascade2(coef, j, state, input, dst, from, to);
        input = dst;
    }
    if (j < n) cascade(coef, j, state, input, dst, from, to);
}

// ---- downmix kernels (module level, sync, monomorphic; the per-sample arithmetic of the loops they replace:
// a running sum from 0 over the channels in order, then the scale) ----
function monoF64x1(a: Float32Array, n: number, inv: number, x: Float64Array): void {
    for (let i = 0; i < n; i += 1) {
        let v = 0;
        v += a[i];
        x[i] = v * inv;
    }
}
function monoF64x2(a: Float32Array, b: Float32Array, n: number, inv: number, x: Float64Array): void {
    for (let i = 0; i < n; i += 1) {
        let v = 0;
        v += a[i];
        v += b[i];
        x[i] = v * inv;
    }
}
function monoF64(block: Float32Array[], n: number, C: number, inv: number, x: Float64Array): void {
    for (let i = 0; i < n; i += 1) {
        let v = 0;
        for (let c = 0; c < C; c += 1) v += block[c][i];
        x[i] = v * inv;
    }
}
function monoI16x1(a: Float32Array, n: number, scale: number, buf: Int16Array, o: number): void {
    for (let i = 0; i < n; i += 1) {
        let s = 0;
        s += a[i];
        const y = s * scale;
        const r = Math.ceil(y);
        const v = r - +(r - 0.5 > y); // Math.round(y), branch-free
        buf[o + i] = v > 32767 ? 32767 : v < -32767 ? -32767 : v;
    }
}
function monoI16x2(a: Float32Array, b: Float32Array, n: number, scale: number, buf: Int16Array, o: number): void {
    for (let i = 0; i < n; i += 1) {
        let s = 0;
        s += a[i];
        s += b[i];
        const y = s * scale;
        const r = Math.ceil(y);
        const v = r - +(r - 0.5 > y); // Math.round(y), branch-free
        buf[o + i] = v > 32767 ? 32767 : v < -32767 ? -32767 : v;
    }
}
function monoI16(block: Float32Array[], n: number, C: number, scale: number, buf: Int16Array, o: number): void {
    for (let i = 0; i < n; i += 1) {
        let s = 0;
        for (let c = 0; c < C; c += 1) s += block[c][i];
        const y = s * scale;
        const r = Math.ceil(y);
        const v = r - +(r - 0.5 > y); // Math.round(y), branch-free
        buf[o + i] = v > 32767 ? 32767 : v < -32767 ? -32767 : v;
    }
}

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
    private readonly _preCoef: Float64Array;
    private readonly _topCoef: Float64Array;
    private readonly _sectionCoef: Float64Array;
    /** Per section: x1, x2, y1, y2. */
    private readonly _state: Float64Array;
    private readonly _acc: Float64Array;
    private _accN = 0;
    private _accLowN = 0;
    private _frame = 0;
    private _values: Float32Array;
    private _bins = 0;
    private _mono = new Float64Array(0);
    private _work = new Float64Array(0);
    private _lowBuf = new Float64Array(0);
    private _lowWork = new Float64Array(0);
    private readonly _sums = new Float64Array(2);

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
        this._preCoef = flat(this._pre);
        this._topCoef = flat(this._top);
        this._sectionCoef = flat(this._sections);
        this._acc = new Float64Array(1 + this.cutoffs.length);
        this._values = new Float32Array(Math.max(16, Math.ceil(expectedFrames / framesPerBin) + 1) * (1 + this.cutoffs.length));
    }

    push(block: Float32Array[]): void {
        const n = block[0]?.length ?? 0;
        if (n === 0) return;
        const C = this._channels;
        const inv = 1 / C;
        // The mono mix, as doubles (the arithmetic of a per-sample mix exactly).
        if (this._mono.length < n) {
            this._mono = new Float64Array(n);
            this._work = new Float64Array(n);
        }
        const x = this._mono;
        if (C === 1) monoF64x1(block[0], n, inv, x);
        else if (C === 2) monoF64x2(block[0], block[1], n, inv, x);
        else monoF64(block, n, C, inv, x);
        // Stretch by stretch up to each bin's end: every accumulator sees its samples in the
        // same order as sample by sample, so the sums are the same numbers.
        for (let from = 0; from < n;) {
            const to = Math.min(n, from + this.framesPerBin - this._accN);
            this._stretch(x, from, to);
            from = to;
            if (this._accN === this.framesPerBin) this._close();
        }
    }

    /** Samples [from, to) of the mono mix through every filter, into the open bin. */
    private _stretch(x: Float64Array, from: number, to: number): void {
        const acc = this._acc;
        const w = this._work;
        if (this._topCoef.length === 10 && this._preCoef.length === 10) {
            // Fused: Σx², the top band's energy and the low band into w, in one pass (independent chains).
            const sums = this._sums;
            sums[0] = acc[0];
            sums[1] = this._accTop;
            // WebAssembly (the two chains in two lanes, the same numbers), else the JS below.
            if (!wasmSplitBands(this._topCoef, this._topState, this._preCoef, this._preState, x, w, from, to, sums)) {
                splitBands(this._topCoef, this._topState, this._preCoef, this._preState, x, w, from, to, sums);
            }
            acc[0] = sums[0];
            this._accTop = sums[1];
            const D = this.decimation;
            const first = from + ((D - (this._frame % D)) % D);
            let m = 0;
            const d = this._lowBuf.length >= to - from ? this._lowBuf : (this._lowBuf = new Float64Array(to - from));
            for (let i = first; i < to; i += D) d[m++] = w[i];
            // The cutoffs two by two: two independent filter chains per pass.
            const K = this.cutoffs.length;
            let k = 0;
            if (wasmCutoffPairs(this._sectionCoef, this._state, d, m, acc, Math.floor(K / 2))) k = 2 * Math.floor(K / 2);
            for (; k + 1 < K; k += 2) cutoffPair(this._sectionCoef, 2 * k, this._state, d, m, acc, 1 + k);
            for (; k < K; k += 1) cutoffOne(this._sectionCoef, 2 * k, this._state, d, m, acc, 1 + k);
            this._accLowN += m;
            this._accN += to - from;
            this._frame += to - from;
            return;
        }
        let e = acc[0];
        for (let i = from; i < to; i += 1) e += x[i] * x[i];
        acc[0] = e;
        // The top band (high-pass at the split): its energy.
        if (this._topCoef.length) {
            series(this._topCoef, this._topState, x, w, from, to);
            let t = this._accTop;
            for (let i = from; i < to; i += 1) t += w[i] * w[i];
            this._accTop = t;
        }
        // The low band (low-pass at the split), every D-th sample of it at the low rate.
        let low: Float64Array = x;
        if (this._preCoef.length) {
            series(this._preCoef, this._preState, x, w, from, to);
            low = w;
        }
        const D = this.decimation;
        const first = from + ((D - (this._frame % D)) % D);
        let m = 0;
        const d = this._lowBuf.length >= to - from ? this._lowBuf : (this._lowBuf = new Float64Array(to - from));
        for (let i = first; i < to; i += D) d[m++] = low[i];
        // Each cutoff: its two high-pass sections over the decimated samples, then the energy.
        const u = this._lowWork.length >= m ? this._lowWork : (this._lowWork = new Float64Array(m));
        for (let k = 0; k < this.cutoffs.length; k += 1) {
            cascade2(this._sectionCoef, 2 * k, this._state, d, u, 0, m);
            let energy = acc[1 + k];
            for (let i = 0; i < m; i += 1) energy += u[i] * u[i];
            acc[1 + k] = energy;
        }
        this._accLowN += m;
        this._accN += to - from;
        this._frame += to - from;
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
        if (this._channels === 1) monoI16x1(block[0], n, scale, this._buf, this._len);
        else if (this._channels === 2) {
            if (!wasmMonoI16Stereo(block[0], block[1], n, scale, this._buf, this._len)) monoI16x2(block[0], block[1], n, scale, this._buf, this._len);
        }
        else monoI16(block, n, this._channels, scale, this._buf, this._len);
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
