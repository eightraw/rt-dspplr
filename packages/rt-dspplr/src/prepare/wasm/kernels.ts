// ---------------------------------------------------------------------------
// prepare's WebAssembly: our kernels (wasm/kernels.wat) and pffft in double
// precision, instantiated once per thread on first use. Each function returns
// null (or does nothing it would not do in JS) when WebAssembly SIMD is not
// there, and the callers keep their JS code for that case. Inputs are copied
// into the module's memory per call; the memory grows as needed (views are
// taken after every allocation, since growing detaches the old buffer).
// ---------------------------------------------------------------------------

import { KERNELS_WASM, PFFFTD_WASM } from './embedded';

interface KernelExports {
    memory: WebAssembly.Memory;
    cutoff_pair(coef: number, state: number, d: number, m: number, acc: number): void;
    split_bands(coef: number, state: number, x: number, dst: number, from: number, to: number, sums: number): void;
    dot4(a: number, b: number, w: number, k: number, out: number): void;
    int16_stereo(l: number, r: number, n: number, dst: number): void;
    int16_mono(x: number, n: number, dst: number): void;
    mono_i16_stereo(a: number, b: number, n: number, scale: number, dst: number): void;
    peaks_stereo(l: number, r: number, n: number, fpp: number, out: number): void;
}

interface PffftExports {
    memory: WebAssembly.Memory;
    _initialize(): void;
    pffftd_new_setup(n: number, transform: number): number;
    pffftd_aligned_malloc(bytes: number): number;
    pffftd_transform_ordered(setup: number, input: number, output: number, work: number, direction: number): void;
}

function instantiate<T>(base64: string): T | null {
    try {
        return new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(base64, 'base64')), {}).exports as unknown as T;
    } catch {
        return null; // no SIMD (or no WebAssembly): the JS code runs
    }
}

let kernels: KernelExports | null | undefined;
function k(): KernelExports | null {
    if (kernels === undefined) kernels = instantiate<KernelExports>(KERNELS_WASM);
    return kernels;
}

/** The kernel memory, at least `bytes` long. */
function room(mem: WebAssembly.Memory, bytes: number): ArrayBuffer {
    const need = bytes - mem.buffer.byteLength;
    if (need > 0) mem.grow(Math.ceil(need / 65536));
    return mem.buffer;
}

// ---- the bands' filter chains -------------------------------------------------------------

/** Two chains' coefficients (10 each) and states (8 each), lane 0 and lane 1, into f64 views at c and s. */
function interleave(view: Float64Array, c: number, a: Float64Array, ao: number, b: Float64Array, bo: number, count: number): void {
    for (let i = 0; i < count; i += 1) {
        view[c + 2 * i] = a[ao + i];
        view[c + 2 * i + 1] = b[bo + i];
    }
}

function deinterleave(view: Float64Array, s: number, a: Float64Array, ao: number, b: Float64Array, bo: number, count: number): void {
    for (let i = 0; i < count; i += 1) {
        a[ao + i] = view[s + 2 * i];
        b[bo + i] = view[s + 2 * i + 1];
    }
}

// Layout (bytes): coef 0..160, state 160..288, sums/acc 288..304, data from 304 (8-aligned; v128 needs no alignment).
const COEF = 0;
const STATE = 160;
const SUMS = 288;
const DATA = 304;

/**
 * The bands analyser's split, as splitBands() in overviewAnalysis.ts (the same numbers):
 * Σx² and the top chain's energy into sums[0], sums[1], the pre chain's output into dst.
 * False when WebAssembly is not there.
 */
export function wasmSplitBands(top: Float64Array, ts: Float64Array, pre: Float64Array, ps: Float64Array, x: Float64Array, dst: Float64Array, from: number, to: number, sums: Float64Array): boolean {
    const K = k();
    if (!K) return false;
    const n = to - from;
    const xAt = DATA;
    const dAt = DATA + n * 8;
    const v = new Float64Array(room(K.memory, dAt + n * 8));
    interleave(v, COEF / 8, top, 0, pre, 0, 10);
    interleave(v, STATE / 8, ts, 0, ps, 0, 8);
    v[SUMS / 8] = sums[0];
    v[SUMS / 8 + 1] = sums[1];
    v.set(x.subarray(from, to), xAt / 8);
    K.split_bands(COEF, STATE, xAt, dAt, 0, n, SUMS);
    deinterleave(v, STATE / 8, ts, 0, ps, 0, 8);
    sums[0] = v[SUMS / 8];
    sums[1] = v[SUMS / 8 + 1];
    dst.set(v.subarray(dAt / 8, dAt / 8 + n), from);
    return true;
}

/**
 * The cutoffs two by two, as cutoffPair() in overviewAnalysis.ts (the same numbers): sections
 * 2k…2k+3 over d[0, m), energies into acc[1 + k], acc[2 + k], for k = 0, 2, … below `pairs` × 2.
 * False when WebAssembly is not there.
 */
export function wasmCutoffPairs(coef: Float64Array, state: Float64Array, d: Float64Array, m: number, acc: Float64Array, pairs: number): boolean {
    const K = k();
    if (!K) return false;
    const v = new Float64Array(room(K.memory, DATA + m * 8));
    v.set(d.subarray(0, m), DATA / 8);
    for (let p = 0; p < pairs; p += 1) {
        const j = 4 * p; // sections j, j+1 (cutoff 2p) and j+2, j+3 (cutoff 2p+1)
        interleave(v, COEF / 8, coef, j * 5, coef, (j + 2) * 5, 10);
        interleave(v, STATE / 8, state, j * 4, state, (j + 2) * 4, 8);
        v[SUMS / 8] = acc[1 + 2 * p];
        v[SUMS / 8 + 1] = acc[2 + 2 * p];
        K.cutoff_pair(COEF, STATE, DATA, m, SUMS);
        deinterleave(v, STATE / 8, state, j * 4, state, (j + 2) * 4, 8);
        acc[1 + 2 * p] = v[SUMS / 8];
        acc[2 + 2 * p] = v[SUMS / 8 + 1];
    }
    return true;
}

// ---- the alignment's lag sums ----------------------------------------------------------------

let loaded: { a: Float32Array; b: Float32Array; aAt: number; bAt: number } | null = null;

/**
 * Σ a[i]·b[i + k] for k in [from, to] (doubles; pairs of i per lane, so the last bits differ
 * from a single running sum). Null when WebAssembly is not there. The windows stay in the
 * module between calls with the same a and b.
 */
export function wasmLagSums(a: Float32Array, b: Float32Array, from: number, to: number): Float64Array | null {
    const K = k();
    if (!K) return null;
    const count = to - from + 1;
    // b's region has room for the last group of four lags reading three past its end.
    if (!loaded || loaded.a !== a || loaded.b !== b) {
        const aAt = DATA;
        const bAt = aAt + ((a.length * 4 + 15) & ~15);
        const outAt = bAt + ((b.length * 4 + 16 + 15) & ~15);
        const buf = room(K.memory, outAt + (count + 4) * 8);
        new Float32Array(buf, aAt, a.length).set(a);
        const bv = new Float32Array(buf, bAt, b.length + 4);
        bv.set(b);
        bv.fill(0, b.length);
        loaded = { a, b, aAt, bAt };
    }
    const outAt = loaded.bAt + ((b.length * 4 + 16 + 15) & ~15);
    room(K.memory, outAt + (count + 4) * 8);
    for (let kk = from; kk <= to; kk += 4) K.dot4(loaded.aAt, loaded.bAt, a.length, kk, outAt + (kk - from) * 8);
    return new Float64Array(K.memory.buffer, outAt, count).slice();
}

// ---- 16-bit samples and peaks (the memory from DATA on: the lag sums' windows load again after) ----

/**
 * toInt16Strided() of prepareAudio.ts for one or two channels, frames [from, to) of each,
 * interleaved into dst from p (the same numbers). False when WebAssembly is not there, or for
 * more channels.
 */
export function wasmInt16(block: Float32Array[], from: number, to: number, dst: Int16Array, p: number): boolean {
    const C = block.length;
    if (C < 1 || C > 2) return false;
    const K = k();
    if (!K) return false;
    loaded = null;
    const n = to - from;
    const xAt = DATA;
    const yAt = xAt + n * 4;
    const outAt = yAt + n * 4;
    const buf = room(K.memory, outAt + n * 2 * C);
    new Float32Array(buf, xAt, n).set(block[0].subarray(from, to));
    if (C === 2) {
        new Float32Array(buf, yAt, n).set(block[1].subarray(from, to));
        K.int16_stereo(xAt, yAt, n, outAt);
    } else {
        K.int16_mono(xAt, n, outAt);
    }
    dst.set(new Int16Array(buf, outAt, n * C), p);
    return true;
}

/**
 * monoI16x2() of overviewAnalysis.ts: the mean of two channels as 16-bit, into dst from o (the
 * same numbers). False when WebAssembly is not there.
 */
export function wasmMonoI16Stereo(a: Float32Array, b: Float32Array, n: number, scale: number, dst: Int16Array, o: number): boolean {
    const K = k();
    if (!K) return false;
    loaded = null;
    const aAt = DATA;
    const bAt = aAt + n * 4;
    const outAt = bAt + n * 4;
    const buf = room(K.memory, outAt + n * 2);
    new Float32Array(buf, aAt, n).set(a.subarray(0, n));
    new Float32Array(buf, bAt, n).set(b.subarray(0, n));
    K.mono_i16_stereo(aAt, bAt, n, scale, outAt);
    dst.set(new Int16Array(buf, outAt, n), o);
    return true;
}

/**
 * peakBins() of jobs.ts for two channels at once over l, r [0, n): per bin of fpp frames six
 * doubles - the low, the high and Σx², each for l then r (the same numbers). A view of the
 * module's memory: read it before the next call. Null when WebAssembly is not there.
 */
export function wasmPeaksStereo(l: Float32Array, r: Float32Array, n: number, fpp: number): Float64Array | null {
    const K = k();
    if (!K) return null;
    loaded = null;
    const bins = Math.ceil(n / fpp);
    const lAt = DATA;
    const rAt = lAt + n * 4;
    const outAt = (rAt + n * 4 + 15) & ~15;
    const buf = room(K.memory, outAt + bins * 48);
    new Float32Array(buf, lAt, n).set(l.subarray(0, n));
    new Float32Array(buf, rAt, n).set(r.subarray(0, n));
    K.peaks_stereo(lAt, rAt, n, fpp, outAt);
    return new Float64Array(buf, outAt, bins * 6);
}

// ---- pffft, double precision, real transforms ---------------------------------------------

let pffft: PffftExports | null | undefined;
const setups = new Map<number, { setup: number; input: number; output: number; work: number }>();

function p(): PffftExports | null {
    if (pffft === undefined) {
        pffft = instantiate<PffftExports>(PFFFTD_WASM);
        pffft?._initialize();
    }
    return pffft;
}

/**
 * Real FFT of size n (a power of two ≥ 32), forward (sign −1, unscaled) or backward (unscaled),
 * in pffft's ordered layout: [X0, X(n/2), Re X1, Im X1, Re X2, Im X2, …]. Null when
 * WebAssembly is not there.
 */
export function wasmRealFft(n: number, input: Float64Array, output: Float64Array, backward = false): boolean {
    const P = p();
    if (!P) return false;
    let s = setups.get(n);
    if (!s) {
        const setup = P.pffftd_new_setup(n, 0);
        s = { setup, input: P.pffftd_aligned_malloc(n * 8), output: P.pffftd_aligned_malloc(n * 8), work: P.pffftd_aligned_malloc(n * 8) };
        setups.set(n, s);
    }
    new Float64Array(P.memory.buffer, s.input, n).set(input.subarray(0, n));
    P.pffftd_transform_ordered(s.setup, s.input, s.output, s.work, backward ? 1 : 0);
    output.set(new Float64Array(P.memory.buffer, s.output, n));
    return true;
}
