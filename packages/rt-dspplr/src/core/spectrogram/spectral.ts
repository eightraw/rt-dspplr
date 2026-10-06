// Spectral analysis shared by the spectrogram worker and the Node prepare step:
// a Hann-windowed real FFT, the logarithmic row plan, multi-resolution bands and
// 8-bit frames. Pure functions over typed arrays (no DOM, no worker scope).

import type { SpectralLevel } from './protocol';

/** FFT length used for the clip-wide reference level. */
export const REFERENCE_FFT = 2048;

// ---- FFT ---------------------------------------------------------------------
//
// A real FFT of size N through one complex FFT of size N/2, with a Hann
// window. Tables are kept per size, since a multi-resolution request uses two.

export interface Fft {
    size: number;
    half: number;
    /** Brings magnitudes to the scale of a 2048-point FFT, so bands of different lengths meet. */
    norm: number;
    hann: Float32Array;
    bitReverse: Uint32Array;
    cos: Float32Array;
    sin: Float32Array;
    splitCos: Float32Array;
    splitSin: Float32Array;
    re: Float32Array;
    im: Float32Array;
    frame: Float32Array;
    spectrum: Float32Array;
}

export const ffts = new Map<number, Fft>();

export function fftOf(size: number): Fft {
    const known = ffts.get(size);
    if (known) return known;
    const half = size >> 1;
    const hann = new Float32Array(size);
    // Symmetric Hann window, zero at both ends.
    for (let n = 0; n < size; n += 1) hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (size - 1));
    const bits = Math.log2(half);
    const bitReverse = new Uint32Array(half);
    for (let i = 0; i < half; i += 1) {
        let r = 0;
        for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b);
        bitReverse[i] = r;
    }
    const cos = new Float32Array(half >> 1);
    const sin = new Float32Array(half >> 1);
    for (let i = 0; i < half >> 1; i += 1) {
        cos[i] = Math.cos((2 * Math.PI * i) / half);
        sin[i] = Math.sin((2 * Math.PI * i) / half);
    }
    const splitCos = new Float32Array(half + 1);
    const splitSin = new Float32Array(half + 1);
    for (let k = 0; k <= half; k += 1) {
        splitCos[k] = Math.cos((2 * Math.PI * k) / size);
        splitSin[k] = Math.sin((2 * Math.PI * k) / size);
    }
    const fft: Fft = {
        size, half, norm: REFERENCE_FFT / size, hann, bitReverse, cos, sin, splitCos, splitSin,
        re: new Float32Array(half),
        im: new Float32Array(half),
        frame: new Float32Array(size),
        spectrum: new Float32Array(half + 1),
    };
    ffts.set(size, fft);
    return fft;
}

export const FROM_INT16 = 1 / 32767;

/** Load the frame of `stem` centred on sample `centre` (zeros outside the clip). */
export function loadFrame(fft: Fft, stem: Int16Array, centre: number): void {
    const start = Math.round(centre - fft.size / 2);
    const frame = fft.frame;
    for (let n = 0; n < fft.size; n += 1) {
        const at = start + n;
        frame[n] = at >= 0 && at < stem.length ? stem[at] * FROM_INT16 : 0;
    }
}

/** One radix-2 stage of `size` over the half-size complex arrays (twiddle outer). */
function stage(re: Float32Array, im: Float32Array, cos: Float32Array, sin: Float32Array, half: number, size: number): void {
    const step = half / size;
    const span = size >> 1;
    for (let k = 0; k < span; k += 1) {
        const c = cos[k * step];
        const s = -sin[k * step];
        for (let a = k; a < half; a += size) {
            const b = a + span;
            const tr = re[b] * c - im[b] * s;
            const ti = re[b] * s + im[b] * c;
            re[b] = re[a] - tr;
            im[b] = im[a] - ti;
            re[a] += tr;
            im[a] += ti;
        }
    }
}

/** Stages L1 and 2·L1 in one pass: every butterfly as stage() computes it, the first stage's results rounded to float32 (Math.fround) as its stores would. */
function stagePair(re: Float32Array, im: Float32Array, cos: Float32Array, sin: Float32Array, half: number, L1: number): void {
    const fr = Math.fround;
    const span1 = L1 >> 1;
    const L2 = L1 << 1;
    const step1 = half / L1;
    const step2 = half / L2;
    for (let k = 0; k < span1; k += 1) {
        const c1 = cos[k * step1], s1 = -sin[k * step1];
        const c2 = cos[k * step2], s2 = -sin[k * step2];
        const c3 = cos[(k + span1) * step2], s3 = -sin[(k + span1) * step2];
        for (let i0 = k; i0 < half; i0 += L2) {
            const i1 = i0 + span1, i2 = i0 + L1, i3 = i2 + span1;
            const r0 = re[i0], m0 = im[i0], r1 = re[i1], m1 = im[i1], r2 = re[i2], m2 = im[i2], r3 = re[i3], m3 = im[i3];
            let tr = r1 * c1 - m1 * s1;
            let ti = r1 * s1 + m1 * c1;
            const R1 = fr(r0 - tr), M1 = fr(m0 - ti), R0 = fr(r0 + tr), M0 = fr(m0 + ti);
            tr = r3 * c1 - m3 * s1;
            ti = r3 * s1 + m3 * c1;
            const R3 = fr(r2 - tr), M3 = fr(m2 - ti), R2 = fr(r2 + tr), M2 = fr(m2 + ti);
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

/**
 * Another real FFT behind transform(): `fn(fft)` writes |X[k]|·fft.norm (k = 0 … N/2) of
 * fft.frame windowed by fft.hann into fft.spectrum and returns it. Null: the JS one. Set by
 * a host that has a faster one - the Node prepare step plugs pffft (WebAssembly SIMD) in -
 * before it analyses anything, so one run never mixes the two.
 */
export function setSpectralBackend(fn: ((fft: Fft) => Float32Array) | null): void {
    backend = fn;
}

let backend: ((fft: Fft) => Float32Array) | null = null;

/** |X[k]| for k = 0 … N/2 of the windowed frame, into `fft.spectrum`. */
export function transform(fft: Fft): Float32Array {
    return backend ? backend(fft) : transformJs(fft);
}

/** transform() in JS: a real FFT through a complex one of half the size (what a backend can fall back to). */
export function transformJs(fft: Fft): Float32Array {
    const { half, norm, hann, bitReverse, re, im, frame, cos, sin, splitCos, splitSin, spectrum } = fft;
    for (let n = 0; n < half; n += 1) {
        const j = bitReverse[n];
        re[j] = frame[2 * n] * hann[2 * n];
        im[j] = frame[2 * n + 1] * hann[2 * n + 1];
    }
    // Two radix-2 stages per pass (each butterfly as before; Math.fround stands for the float32 store between them).
    let size = 2;
    for (; size * 2 <= half; size <<= 2) stagePair(re, im, cos, sin, half, size);
    if (size <= half) stage(re, im, cos, sin, half, size);
    for (let k = 0; k <= half; k += 1) {
        const a = k === half ? 0 : k; // k % half
        const b = k === 0 ? 0 : half - k; // (half - k) % half
        const er = (re[a] + re[b]) * 0.5;
        const ei = (im[a] - im[b]) * 0.5;
        const or = (re[a] - re[b]) * 0.5;
        const oi = (im[a] + im[b]) * 0.5;
        // (odd part) / i, times e^(-2πik/N)
        const tr = oi;
        const ti = -or;
        const c = splitCos[k];
        const s = splitSin[k];
        const xr = er + tr * c + ti * s;
        const xi = ei + ti * c - tr * s;
        spectrum[k] = Math.sqrt(xr * xr + xi * xi) * norm;
    }
    return spectrum;
}

// ---- Frequency rows ------------------------------------------------------------
//
// Rows on a geometric scale; a row wider than two bins takes the loudest of them,
// so a thin harmonic cannot fall between rows, and a narrower one is
// interpolated in dB between the two nearest bins.

export interface RowPlan {
    lo: Int32Array;
    hi: Int32Array;
    below: Int32Array;
    weight: Float32Array;
    /** Centre of each output row in Hz (row 0 = top). */
    hz: Float32Array;
}

export function planRows(fft: Fft, sampleRate: number, rows: number, minHz: number, maxHz: number): RowPlan {
    const bins = fft.half + 1;
    const plan: RowPlan = {
        lo: new Int32Array(rows),
        hi: new Int32Array(rows),
        below: new Int32Array(rows),
        weight: new Float32Array(rows),
        hz: new Float32Array(rows),
    };
    const toBin = fft.size / sampleRate;
    const ratio = maxHz / minHz;
    for (let r = 0; r < rows; r += 1) {
        const centreHz = minHz * Math.pow(ratio, rows > 1 ? r / (rows - 1) : 0);
        const centre = centreHz * toBin;
        const lowEdge = minHz * Math.pow(ratio, r / rows) * toBin;
        const highEdge = minHz * Math.pow(ratio, (r + 1) / rows) * toBin;
        const lo = Math.floor(lowEdge);
        const hi = Math.ceil(highEdge);
        // Row 0 of the output is the top of the picture, the highest frequency.
        const row = rows - 1 - r;
        plan.hz[row] = centreHz;
        if (hi - lo >= 2) {
            plan.lo[row] = Math.min(lo, bins - 1);
            plan.hi[row] = Math.min(hi, bins);
            plan.below[row] = -1;
        } else {
            const below = Math.max(0, Math.min(Math.floor(centre), bins - 2));
            plan.below[row] = below;
            plan.weight[row] = centre - below;
        }
    }
    return plan;
}

export function rowValue(spectrum: Float32Array, plan: RowPlan, row: number): number {
    const below = plan.below[row];
    if (below < 0) {
        let value = 0;
        for (let bin = plan.lo[row]; bin < plan.hi[row]; bin += 1) {
            if (spectrum[bin] > value) value = spectrum[bin];
        }
        return value;
    }
    const k = plan.weight[row];
    const db = 20 * Math.log10(spectrum[below] + 1e-9) * (1 - k)
        + 20 * Math.log10(spectrum[below + 1] + 1e-9) * k;
    return Math.pow(10, db / 20);
}

/** A quarter of an octave on each side of a band edge is a blend of the two bands. */
export const BLEND = Math.pow(2, 0.25);

export interface Band {
    fft: Fft;
    plan: RowPlan;
    /** Rows this band draws (its own range plus the blends at its edges). */
    rows: Int32Array;
}

/**
 * Bands of the frequency axis, each with its own FFT: long windows for the
 * bass, where a harmonic needs the frequency resolution, short ones for the
 * top, where attacks need the time resolution.
 */
export function planBands(
    sampleRate: number,
    rows: number,
    minHz: number,
    maxHz: number,
    bands: { fftSize: number; fromHz: number }[],
): { bands: Band[]; weights: Float32Array[] } {
    const planned: Band[] = [];
    const weights: Float32Array[] = [];
    bands.forEach((band, index) => {
        const fft = fftOf(band.fftSize);
        const plan = planRows(fft, sampleRate, rows, minHz, maxHz);
        const low = index === 0 ? 0 : band.fromHz;
        const high = index === bands.length - 1 ? Infinity : bands[index + 1].fromHz;
        const weight = new Float32Array(rows);
        const own: number[] = [];
        for (let row = 0; row < rows; row += 1) {
            const hz = plan.hz[row];
            // 1 inside the band, fading to 0 across a blend region at each edge.
            const up = low <= 0 ? 1 : Math.min(1, Math.max(0, Math.log(hz / (low / BLEND)) / Math.log(BLEND * BLEND)));
            const down = high === Infinity ? 1 : Math.min(1, Math.max(0, Math.log((high * BLEND) / hz) / Math.log(BLEND * BLEND)));
            weight[row] = Math.min(up, down);
            if (weight[row] > 0) own.push(row);
        }
        planned.push({ fft, plan, rows: Int32Array.from(own) });
        weights.push(weight);
    });
    return { bands: planned, weights };
}

export const PYRAMID_MIN_HOP = 512;
export const PYRAMID_MAX_FRAMES = 8192;
export const PYRAMID_BANDS = [
    { fftSize: 4096, fromHz: 0 },
    { fftSize: 2048, fromHz: 300 },
    { fftSize: 1024, fromHz: 3000 },
];

/** Row magnitudes of the frame of `stem` centred on `centre` (all bands, blended), into `sum`. */
export function frameRows(
    stem: Int16Array,
    centre: number,
    layout: { bands: Band[]; weights: Float32Array[] },
    sum: Float32Array,
): Float32Array {
    sum.fill(0);
    layout.bands.forEach((band, index) => {
        loadFrame(band.fft, stem, centre);
        const spectrum = transform(band.fft);
        const weight = layout.weights[index];
        for (const row of band.rows) sum[row] += weight[row] * rowValue(spectrum, band.plan, row);
    });
    return sum;
}

/** 8-bit levels of one frame: 0 at `topDb - rangeDb` and below, 255 at `topDb`. */
export function quantizeRows(sum: Float32Array, topDb: number, rangeDb: number, out: Uint8Array, offset: number): void {
    const floorDb = topDb - rangeDb;
    const scale = 255 / rangeDb;
    for (let row = 0; row < sum.length; row += 1) {
        const level = (20 * Math.log10(sum[row] + 1e-12) - floorDb) * scale;
        out[offset + row] = level <= 0 ? 0 : level >= 255 ? 255 : Math.round(level);
    }
}

export function framesOfStem(
    stem: Int16Array,
    frames: number,
    hop: number,
    layout: { bands: Band[]; weights: Float32Array[] },
    rows: number,
    topDb: number,
    rangeDb: number,
): Uint8Array {
    const out = new Uint8Array(frames * rows);
    const sum = new Float32Array(rows);
    for (let frame = 0; frame < frames; frame += 1) {
        frameRows(stem, (frame + 0.5) * hop, layout, sum);
        quantizeRows(sum, topDb, rangeDb, out, frame * rows);
    }
    return out;
}

/** The next level up: each frame the louder of two, row by row. */
export function halve(level: SpectralLevel, rows: number): SpectralLevel {
    const frames = Math.ceil(level.frames / 2);
    const pool = (source: Uint8Array) => {
        const out = new Uint8Array(frames * rows);
        for (let frame = 0; frame < frames; frame += 1) {
            const left = 2 * frame * rows;
            const right = left + rows;
            const hasRight = 2 * frame + 1 < level.frames;
            for (let row = 0; row < rows; row += 1) {
                const a = source[left + row];
                const b = hasRight ? source[right + row] : 0;
                out[frame * rows + row] = a > b ? a : b;
            }
        }
        return out;
    };
    return { binSize: level.binSize * 2, frames, a: pool(level.a), b: level.b ? pool(level.b) : null };
}

