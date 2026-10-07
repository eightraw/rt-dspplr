// ---------------------------------------------------------------------------
// The heavy part of aligning a stem with A, one window at a time: the
// cross-correlation over the search range (by FFT) and the window's power
// spectrum (for the stem's bandwidth). Pure functions of their input, run as
// 'correlate' jobs on prepare's worker pool, so the windows of a stem are
// measured in parallel and give the same numbers on any thread.
// ---------------------------------------------------------------------------

/**
 * Whether a correlation `rho` at lag index `k` beats the best so far (`top` at `at`), with
 * `centre` the index of lag 0. Peaks equal to rounding (periodic material: a loop that repeats
 * every beat correlates as well one beat away) go to the lag nearest 0, whatever order the
 * search visits them in.
 */
function better(rho: number, k: number, top: number, at: number, centre: number): boolean {
    // Nothing yet (−∞), or a value that is not one: plain comparison, never a tie.
    if (!Number.isFinite(top) || !Number.isFinite(rho)) return rho > top;
    const tie = Math.abs(rho - top) <= 1e-9 * Math.max(Math.abs(rho), Math.abs(top));
    return tie ? Math.abs(k - centre) < Math.abs(at - centre) : rho > top;
}

import { wasmLagSums, wasmRealFft } from './wasm/kernels';

/** Per FFT size: the bit-reversal permutation and the twiddles, made once. */
interface Plan {
    rev: Uint32Array;
    cos: Float64Array;
    sin: Float64Array;
}

const plans = new Map<number, Plan>();

function plan(n: number): Plan {
    let p = plans.get(n);
    if (p) return p;
    const bits = Math.round(Math.log2(n));
    if (1 << bits !== n) throw new Error(`FFT size ${n} is not a power of two`);
    const rev = new Uint32Array(n);
    for (let i = 1; i < n; i += 1) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
    const half = n >> 1;
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    for (let k = 0; k < half; k += 1) {
        cos[k] = Math.cos((2 * Math.PI * k) / n);
        sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    p = { rev, cos, sin };
    plans.set(n, p);
    return p;
}

/** In-place complex radix-2 FFT (sign −1 forward, +1 inverse, unscaled). */
export function fft(re: Float64Array, im: Float64Array, sign: number): void {
    const n = re.length;
    const { rev, cos, sin } = plan(n);
    for (let i = 0; i < n; i += 1) {
        const j = rev[i];
        if (i < j) {
            const r = re[i];
            re[i] = re[j];
            re[j] = r;
            const m = im[i];
            im[i] = im[j];
            im[j] = m;
        }
    }
    // Two radix-2 stages per pass, every butterfly as before; the stages up to FFT_BLOCK block by block
    // (a block's data stays in cache), then the rest over the whole array. Butterflies of one stage are
    // independent, so their order does not change a number.
    const B = Math.min(FFT_BLOCK, n);
    let after = 2;
    for (let lo = 0; lo < n; lo += B) {
        let len = 2;
        for (; len * 2 <= B; len <<= 2) stagePair64(re, im, cos, sin, n, len, sign, lo, lo + B);
        if (len <= B) {
            stage64(re, im, cos, sin, n, len, sign, lo, lo + B);
            len <<= 1;
        }
        after = len;
    }
    let len = after;
    for (; len * 2 <= n; len <<= 2) stagePair64(re, im, cos, sin, n, len, sign, 0, n);
    if (len <= n) stage64(re, im, cos, sin, n, len, sign, 0, n);
}

const FFT_BLOCK = 4096;

function stage64(re: Float64Array, im: Float64Array, cos: Float64Array, sin: Float64Array, n: number, len: number, sign: number, lo: number, hi: number): void {
    const half = len >> 1;
    const step = n / len;
    for (let k = 0; k < half; k += 1) {
        const t = k * step;
        const wr = cos[t];
        const wi = sign * sin[t];
        for (let a = lo + k; a < hi; a += len) {
            const b = a + half;
            const tr = re[b] * wr - im[b] * wi;
            const ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr;
            im[b] = im[a] - ti;
            re[a] += tr;
            im[a] += ti;
        }
    }
}

/** Stages L1 and 2·L1 in one pass: every butterfly with stage64()'s arithmetic, the intermediate values kept in registers. */
function stagePair64(re: Float64Array, im: Float64Array, cos: Float64Array, sin: Float64Array, n: number, L1: number, sign: number, lo: number, hi: number): void {
    const span1 = L1 >> 1;
    const L2 = L1 << 1;
    const step1 = n / L1;
    const step2 = n / L2;
    for (let k = 0; k < span1; k += 1) {
        const c1 = cos[k * step1], s1 = sign * sin[k * step1];
        const c2 = cos[k * step2], s2 = sign * sin[k * step2];
        const c3 = cos[(k + span1) * step2], s3 = sign * sin[(k + span1) * step2];
        for (let i0 = lo + k; i0 < hi; i0 += L2) {
            const i1 = i0 + span1, i2 = i0 + L1, i3 = i2 + span1;
            const r0 = re[i0], m0 = im[i0], r1 = re[i1], m1 = im[i1], r2 = re[i2], m2 = im[i2], r3 = re[i3], m3 = im[i3];
            let tr = r1 * c1 - m1 * s1;
            let ti = r1 * s1 + m1 * c1;
            const R1 = r0 - tr, M1 = m0 - ti, R0 = r0 + tr, M0 = m0 + ti;
            tr = r3 * c1 - m3 * s1;
            ti = r3 * s1 + m3 * c1;
            const R3 = r2 - tr, M3 = m2 - ti, R2 = r2 + tr, M2 = m2 + ti;
            tr = R2 * c2 - M2 * s2;
            ti = R2 * s2 + M2 * c2;
            re[i2] = R0 - tr;
            im[i2] = M0 - ti;
            re[i0] = R0 + tr;
            im[i0] = M0 + ti;
            tr = R3 * c3 - M3 * s3;
            ti = R3 * s3 + M3 * c3;
            re[i3] = R1 - tr;
            im[i3] = M1 - ti;
            re[i1] = R1 + tr;
            im[i1] = M1 + ti;
        }
    }
}

/** Work buffers per size (a worker measures window after window of the same size). */
const buffers = new Map<number, Float64Array[]>();

function scratch(n: number): Float64Array[] {
    let b = buffers.get(n);
    if (!b) {
        b = [new Float64Array(n), new Float64Array(n), new Float64Array(n >> 1), new Float64Array(n >> 1), new Float64Array(n >> 1), new Float64Array(n >> 1)];
        buffers.set(n, b);
    }
    return b;
}

/**
 * Best lag of `b` (A's window ± maxLag around it) against `a`, and the
 * normalised correlation there. One complex FFT carries both real signals
 * (a + i·b, split by symmetry), and the correlation, being real, comes back
 * through a half-size inverse.
 */
export function crossCorrelate(a: Float32Array, b: Float32Array, maxLag: number): { lag: number; rho: number } {
    const W = a.length;
    // Circular correlation: lags 0..b.length − W read b[i + k] with i + k < b.length, so no wrap when n ≥ b.length.
    let n = 2;
    while (n < b.length) n <<= 1;
    const [xr, xi, zr, zi] = scratch(n);
    xr.fill(0);
    xi.fill(0);
    xr.set(a);
    xi.set(b);
    fft(xr, xi, -1);
    // C[k] = conj(A[k])·B[k], A[k] = (X[k] + conj X[n−k]) / 2, B[k] = (X[k] − conj X[n−k]) / 2i;
    // then the half-size spectrum of c's even and odd samples:
    // Z[k] = (C[k] + C[k+M]) / 2 + i·(C[k] − C[k+M])·e^{2πik/n} / 2.
    const M = n >> 1;
    const { cos, sin } = plan(n);
    const mask = n - 1;
    for (let k = 0; k < M; k += 1) {
        let c0r: number, c0i: number, c1r: number, c1i: number;
        {
            const j = (n - k) & mask;
            const yr = xr[j], yi = -xi[j];
            const pr = (xr[k] + yr) / 2, pi = (xi[k] + yi) / 2;
            const qr = (xi[k] - yi) / 2, qi = (yr - xr[k]) / 2;
            c0r = pr * qr + pi * qi;
            c0i = pr * qi - pi * qr;
        }
        {
            const k1 = k + M;
            const j = (n - k1) & mask;
            const yr = xr[j], yi = -xi[j];
            const pr = (xr[k1] + yr) / 2, pi = (xi[k1] + yi) / 2;
            const qr = (xi[k1] - yi) / 2, qi = (yr - xr[k1]) / 2;
            c1r = pr * qr + pi * qi;
            c1i = pr * qi - pi * qr;
        }
        const er = (c0r + c1r) / 2, ei = (c0i + c1i) / 2;
        const dr = (c0r - c1r) / 2, di = (c0i - c1i) / 2;
        // o = d·e^{2πik/n}
        const or = dr * cos[k] - di * sin[k];
        const oi = dr * sin[k] + di * cos[k];
        zr[k] = er - oi;
        zi[k] = ei + or;
    }
    fft(zr, zi, 1);
    // c[2m] = Re z[m], c[2m+1] = Im z[m], at the scale of an M-point inverse.
    let ea = 0;
    for (let i = 0; i < W; i += 1) ea += a[i] * a[i];
    const count = Math.min(2 * maxLag, b.length - W) + 1;
    const prefix = new Float64Array(b.length + 1);
    for (let i = 0; i < b.length; i += 1) prefix[i + 1] = prefix[i] + b[i] * b[i];
    let best = -Infinity;
    let bestK = maxLag;
    for (let k = 0; k < count; k += 1) {
        const eb = prefix[k + W] - prefix[k];
        const c = (k & 1 ? zi[k >> 1] : zr[k >> 1]) / M;
        const rho = c / Math.sqrt(ea * eb + 1e-30);
        if (better(rho, k, best, bestK, maxLag)) {
            best = rho;
            bestK = k;
        }
    }
    return { lag: bestK - maxLag, rho: best };
}

/**
 * The best lags of two correlations of `b` against `a` from one forward FFT:
 * the plain one, and the pre-emphasised one (both signals' first difference:
 * the cross-spectrum times |1 − e^{−iω}|² = 2 − 2·cos ω). The plain one is
 * what the full-rate search maximises; the pre-emphasised one keeps a quiet
 * broadband part under a loud low one (a vocal's breaths under its voice),
 * which the decimation's low-pass otherwise buries.
 */
function coarseLags(a: Float32Array, b: Float32Array, maxLag: number): number[] {
    const fast = coarseLagsWasm(a, b, maxLag);
    if (fast) return fast;
    const W = a.length;
    // One more than b: the first difference of the zero-padded b reaches b.length.
    let n = 2;
    while (n < b.length + 1) n <<= 1;
    const [xr, xi, zr, zi, ur, ui] = scratch(n);
    xr.fill(0);
    xi.fill(0);
    xr.set(a);
    xi.set(b);
    fft(xr, xi, -1);
    const M = n >> 1;
    const { cos, sin } = plan(n);
    coarseSpectra(xr, xi, n, M, cos, sin, zr, zi, ur, ui);
    fft(zr, zi, 1);
    fft(ur, ui, 1);
    const count = Math.min(2 * maxLag, b.length - W) + 1;
    return [coarseBest(zr, zi, a, b, W, count, maxLag), coarseBest(ur, ui, firstDifference(a), firstDifference(b), W + 1, count, maxLag)];
}

/** coarseLags' cross-spectra (plain into z, pre-emphasised into u): its closures and tuples inlined, the same arithmetic. */
function coarseSpectra(xr: Float64Array, xi: Float64Array, n: number, M: number, cos: Float64Array, sin: Float64Array, zr: Float64Array, zi: Float64Array, ur: Float64Array, ui: Float64Array): void {
    const mask = n - 1;
    for (let k = 0; k < M; k += 1) {
        let c0r: number, c0i: number, c1r: number, c1i: number;
        {
            const j = (n - k) & mask;
            const yr = xr[j], yi = -xi[j];
            const pr = (xr[k] + yr) / 2, pi = (xi[k] + yi) / 2;
            const qr = (xi[k] - yi) / 2, qi = (yr - xr[k]) / 2;
            c0r = pr * qr + pi * qi;
            c0i = pr * qi - pi * qr;
        }
        {
            const k1 = k + M;
            const j = (n - k1) & mask;
            const yr = xr[j], yi = -xi[j];
            const pr = (xr[k1] + yr) / 2, pi = (xi[k1] + yi) / 2;
            const qr = (xi[k1] - yi) / 2, qi = (yr - xr[k1]) / 2;
            c1r = pr * qr + pi * qi;
            c1i = pr * qi - pi * qr;
        }
        const ck = cos[k], sk = sin[k];
        {
            const er = (c0r + c1r) / 2, ei = (c0i + c1i) / 2;
            const dr = (c0r - c1r) / 2, di = (c0i - c1i) / 2;
            const or = dr * ck - di * sk;
            const oi = dr * sk + di * ck;
            zr[k] = er - oi;
            zi[k] = ei + or;
        }
        // |1 − e^{−iω}|² at k and at k + M (cos flips sign there).
        const w0 = 2 - 2 * ck;
        const w1 = 2 + 2 * ck;
        {
            const a0r = c0r * w0, a0i = c0i * w0, a1r = c1r * w1, a1i = c1i * w1;
            const er = (a0r + a1r) / 2, ei = (a0i + a1i) / 2;
            const dr = (a0r - a1r) / 2, di = (a0i - a1i) / 2;
            const or = dr * ck - di * sk;
            const oi = dr * sk + di * ck;
            ur[k] = er - oi;
            ui[k] = ei + or;
        }
    }
}

/**
 * coarseLags() on pffft (WebAssembly SIMD, double): real FFTs of a and b, the plain and the
 * pre-emphasised cross-spectra, two real inverses. The same correlations to rounding. Null
 * when WebAssembly is not there.
 */
function coarseLagsWasm(a: Float32Array, b: Float32Array, maxLag: number): number[] | null {
    const W = a.length;
    // One more than b: the first difference of the zero-padded b reaches b.length.
    let n = 32;
    while (n < b.length + 1) n <<= 1;
    const [ra, rb, sa, sb, c1, c2] = wasmScratch(n);
    ra.fill(0);
    ra.set(a);
    if (!wasmRealFft(n, ra, sa)) return null;
    rb.fill(0);
    rb.set(b);
    wasmRealFft(n, rb, sb);
    const { cos } = plan(n);
    crossSpectra(sa, sb, cos, n, c1, c2);
    wasmRealFft(n, c1, ra, true);
    wasmRealFft(n, c2, rb, true);
    const count = Math.min(2 * maxLag, b.length - W) + 1;
    return [linearBest(ra, n, a, b, W, count, maxLag), linearBest(rb, n, firstDifference(a), firstDifference(b), W + 1, count, maxLag)];
}

const wasmBuffers = new Map<number, Float64Array[]>();
function wasmScratch(n: number): Float64Array[] {
    let b = wasmBuffers.get(n);
    if (!b) {
        b = Array.from({ length: 6 }, () => new Float64Array(n));
        wasmBuffers.set(n, b);
    }
    return b;
}

/**
 * conj(A)·B in pffft's ordered real layout ([X0, X(n/2), Re X1, Im X1, …]) into c1, and the same
 * times |1 − e^{−iω}|² = 2 − 2·cos ω (the pre-emphasis) into c2.
 */
function crossSpectra(sa: Float64Array, sb: Float64Array, cos: Float64Array, n: number, c1: Float64Array, c2: Float64Array): void {
    c1[0] = sa[0] * sb[0];
    c1[1] = sa[1] * sb[1];
    c2[0] = 0;
    c2[1] = c1[1] * 4;
    const half = n >> 1;
    for (let k = 1; k < half; k += 1) {
        const ar = sa[2 * k], ai = sa[2 * k + 1], br = sb[2 * k], bi = sb[2 * k + 1];
        const cr = ar * br + ai * bi;
        const ci = ar * bi - ai * br;
        const w = 2 - 2 * cos[k];
        c1[2 * k] = cr;
        c1[2 * k + 1] = ci;
        c2[2 * k] = cr * w;
        c2[2 * k + 1] = ci * w;
    }
}

/** coarseBest() on a correlation laid out lag by lag, unscaled by n (a real inverse FFT's). */
let prefixBuffer = new Float64Array(0);
function linearBest(c: Float64Array, n: number, x: Float32Array, y: Float32Array, len: number, count: number, maxLag: number): number {
    let ex = 0;
    for (let i = 0; i < len; i += 1) ex += x[i] * x[i];
    if (prefixBuffer.length < y.length + 1) prefixBuffer = new Float64Array(y.length + 1);
    const prefix = prefixBuffer;
    prefix[0] = 0;
    for (let i = 0; i < y.length; i += 1) prefix[i + 1] = prefix[i] + y[i] * y[i];
    let top = -Infinity;
    let at = 0;
    for (let k = 0; k < count; k += 1) {
        // A lag whose correlation is not positive cannot beat (or tie) a positive best.
        if (!(c[k] > 0) && top > 0) continue;
        const rho = c[k] / n / Math.sqrt(ex * (prefix[Math.min(y.length, k + len)] - prefix[k]) + 1e-30);
        if (better(rho, k, top, at, maxLag)) {
            top = rho;
            at = k;
        }
    }
    return at - maxLag;
}

/** x, y: the signals whose correlation this is (energies for the normalisation), len: the window's length. */
function coarseBest(re: Float64Array, im: Float64Array, x: Float32Array, y: Float32Array, len: number, count: number, maxLag: number): number {
    let ex = 0;
    for (let i = 0; i < len; i += 1) ex += x[i] * x[i];
    const prefix = new Float64Array(y.length + 1);
    for (let i = 0; i < y.length; i += 1) prefix[i + 1] = prefix[i] + y[i] * y[i];
    let top = -Infinity;
    let at = 0;
    for (let k = 0; k < count; k += 1) {
        const c = k & 1 ? im[k >> 1] : re[k >> 1];
        const rho = c / Math.sqrt(ex * (prefix[Math.min(y.length, k + len)] - prefix[k]) + 1e-30);
        if (better(rho, k, top, at, maxLag)) {
            top = rho;
            at = k;
        }
    }
    return at - maxLag;
}

function firstDifference(x: Float32Array): Float32Array {
    const out = new Float32Array(x.length + 1);
    out[0] = x[0];
    for (let i = 1; i < x.length; i += 1) out[i] = x[i] - x[i - 1];
    out[x.length] = -x[x.length - 1];
    return out;
}

/** decimate()'s inside for d = 4, outputs [from, to): taps 1 2 3 4 3 2 1 around 4m. */
function decimate4(x: Float32Array, out: Float32Array, from: number, to: number, norm: number): void {
    for (let m = from; m < to; m += 1) {
        const b = 4 * m - 3;
        let s = 0;
        s += 1 * x[b];
        s += 2 * x[b + 1];
        s += 3 * x[b + 2];
        s += 4 * x[b + 3];
        s += 3 * x[b + 4];
        s += 2 * x[b + 5];
        s += 1 * x[b + 6];
        out[m] = s * norm;
    }
}

/** Every `d`-th sample after a triangular (box ∗ box) low-pass of 2d − 1 taps: a cheap anti-alias filter, the same for A and the stem. */
function decimate(x: Float32Array, d: number): Float32Array {
    const out = new Float32Array(Math.floor(x.length / d));
    const norm = 1 / (d * d);
    const taps = 2 * d - 1;
    const w = new Float64Array(taps);
    for (let t = -(d - 1); t <= d - 1; t += 1) w[t + d - 1] = d - Math.abs(t);
    // d = 4 (44.1 to 96 kHz): the inside unrolled, the same products in the same order.
    const inside = d === 4 ? Math.min(out.length, Math.floor((x.length - 4) / 4) + 1) : 0;
    if (inside > 1) decimate4(x, out, 1, inside, norm);
    for (let m = 0; m < out.length; m += 1) {
        if (m === 1 && inside > 1) m = inside;
        if (m >= out.length) break;
        const centre = m * d;
        let s = 0;
        if (centre - (d - 1) >= 0 && centre + (d - 1) < x.length) {
            // Inside: every tap is there; the same products, summed in the same order.
            const base = centre - (d - 1);
            for (let t = 0; t < taps; t += 1) s += w[t] * x[base + t];
        } else {
            for (let t = -(d - 1); t <= d - 1; t += 1) {
                const i = centre + t;
                if (i >= 0 && i < x.length) s += (d - Math.abs(t)) * x[i];
            }
        }
        out[m] = s * norm;
    }
    return out;
}

/** Σ a[i]·b[i + k], normalised by both windows' energies, at the lags k in [from, to]: the best of them. */
function refine(a: Float32Array, b: Float32Array, from: number, to: number, centre: number): { k: number; rho: number } {
    const W = a.length;
    let ea = 0;
    for (let i = 0; i < W; i += 1) ea += a[i] * a[i];
    // b's energy under the window, slid from lag to lag (the full sum once, then what enters and leaves).
    let eb = 0;
    for (let i = 0; i < W; i += 1) eb += b[i + from] * b[i + from];
    let best = -Infinity;
    let bestK = from;
    // WebAssembly: four lags per pass, pairs of samples per lane; else four lags per pass in JS,
    // each in the order a single sum takes.
    const fromWasm = wasmLagSums(a, b, from, to);
    const sums = fromWasm ?? new Float64Array(to - from + 1);
    let k0 = fromWasm ? to + 1 : from;
    for (; k0 + 3 <= to; k0 += 4) {
        let c0 = 0, c1 = 0, c2 = 0, c3 = 0;
        for (let i = 0; i < W; i += 1) {
            const x = a[i];
            const j = i + k0;
            c0 += x * b[j];
            c1 += x * b[j + 1];
            c2 += x * b[j + 2];
            c3 += x * b[j + 3];
        }
        sums[k0 - from] = c0;
        sums[k0 - from + 1] = c1;
        sums[k0 - from + 2] = c2;
        sums[k0 - from + 3] = c3;
    }
    for (; !fromWasm && k0 <= to; k0 += 1) {
        let c = 0;
        for (let i = 0; i < W; i += 1) c += a[i] * b[i + k0];
        sums[k0 - from] = c;
    }
    for (let k = from; k <= to; k += 1) {
        if (k > from) eb += b[k + W - 1] * b[k + W - 1] - b[k - 1] * b[k - 1];
        const c = sums[k - from];
        const rho = c / Math.sqrt(ea * Math.max(0, eb) + 1e-30);
        if (better(rho, k, best, bestK, centre)) {
            best = rho;
            bestK = k;
        }
    }
    return { k: bestK, rho: best };
}

/**
 * The lag of `b` against `a` like crossCorrelate(), at a fraction of the cost:
 * candidates are found on both signals decimated by `d` (an FFT d times
 * smaller; the plain and the pre-emphasised correlation), each is located to
 * the sample at the full rate among the lags around it, and the one with the
 * higher full-rate correlation wins - the full search's own criterion.
 */
export function alignWindow(a: Float32Array, b: Float32Array, maxLag: number, d: number): { lag: number; rho: number } {
    if (d <= 1) return crossCorrelate(a, b, maxLag);
    const last = Math.min(2 * maxLag, b.length - a.length);
    // The coarse candidates, and lag 0 always: a stem whose maker kept it in time (the usual case)
    // is checked where it should be.
    const ranges = [...coarseLags(decimate(a, d), decimate(b, d), Math.floor(maxLag / d)), 0]
        .map((lag) => Math.round(lag * d) + maxLag)
        .map((centre): [number, number] => [Math.max(0, centre - 2 * d), Math.min(last, centre + 2 * d)])
        .sort((x, y) => x[0] - y[0]);
    // Candidates whose ranges meet are searched once, as one range.
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
        const prev = merged[merged.length - 1];
        if (prev && r[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], r[1]);
        else merged.push([r[0], r[1]]);
    }
    let best = { k: maxLag, rho: -Infinity };
    for (const [from, to] of merged) {
        const r = refine(a, b, from, to, maxLag);
        if (better(r.rho, r.k, best.rho, best.k, maxLag)) best = r;
    }
    return { lag: best.k - maxLag, rho: best.rho };
}

/** The decimation for the coarse search: to about 11-12 kHz (none below 16 kHz). */
export function coarseDecimation(sampleRate: number): number {
    return sampleRate >= 32000 ? 4 : sampleRate >= 16000 ? 2 : 1;
}

const SPECTRUM_SIZE = 4096;
let hann: Float64Array | null = null;

/** Summed power of Hann-windowed 4096-point frames, every eighth one (enough for the stem's bandwidth). */
export function powerSpectrum(w: Float32Array): Float64Array {
    const N = SPECTRUM_SIZE;
    if (!hann) {
        hann = new Float64Array(N);
        for (let i = 0; i < N; i += 1) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    }
    const power = new Float64Array(N / 2);
    const [re, im] = scratch(N);
    for (let o = 0; o + N <= w.length; o += 8 * N) {
        for (let i = 0; i < N; i += 1) re[i] = w[o + i] * hann[i];
        // pffft's ordered real layout: X0, X(N/2), then Re, Im of X1 … X(N/2 − 1).
        if (wasmRealFft(N, re, im)) {
            power[0] += im[0] * im[0];
            for (let k = 1; k < N / 2; k += 1) power[k] += im[2 * k] * im[2 * k] + im[2 * k + 1] * im[2 * k + 1];
            continue;
        }
        im.fill(0);
        fft(re, im, -1);
        for (let k = 0; k < N / 2; k += 1) power[k] += re[k] * re[k] + im[k] * im[k];
    }
    return power;
}

/** Highest frequency carrying energy within 60 dB of the strongest, from summed 4096-point power. */
export function bandwidthFrom(power: Float64Array, rate: number, cap: number): number {
    const N = SPECTRUM_SIZE;
    let top = 0;
    for (const p of power) if (p > top) top = p;
    let k = N / 2 - 1;
    while (k > 0 && power[k] < top * 1e-6) k -= 1;
    return Math.min(cap, Math.round(((k + 1) * rate) / N));
}

/** One window of a stem's alignment: correlate it with A's (when A sounds there) and take its power spectrum. */
export interface CorrelateJob {
    kind: 'correlate';
    index: number;
    /** A's window, or null where the window is only measured for the bandwidth. */
    a: Float32Array | null;
    /** The stem around it: A's window ± maxLag. */
    b: Float32Array;
    maxLag: number;
    /** Decimation of the coarse search (coarseDecimation()). */
    decimation: number;
}

export interface CorrelateResult {
    kind: 'correlate';
    index: number;
    lag: number;
    rho: number;
    power: Float64Array;
}

export function runCorrelate(job: CorrelateJob): CorrelateResult {
    const c = job.a ? alignWindow(job.a, job.b, job.maxLag, job.decimation) : { lag: 0, rho: 0 };
    return { kind: 'correlate', index: job.index, lag: c.lag, rho: c.rho, power: powerSpectrum(job.b) };
}
