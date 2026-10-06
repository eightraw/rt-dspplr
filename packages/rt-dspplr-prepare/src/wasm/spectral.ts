// ---------------------------------------------------------------------------
// The overview spectrogram's real FFT on pffft (single precision, WebAssembly
// SIMD), plugged into the format's transform(). jobs.ts installs it when it
// loads, on the main thread and in every worker alike, so one run never mixes
// two FFTs; with no WebAssembly it falls back to the JS one (same rows to
// within one 0.47 dB step).
// ---------------------------------------------------------------------------

import { setSpectralBackend, transformJs, type Fft } from '@saitdigital/rt-dspplr/format';
import { PFFFT_WASM } from './embedded';

interface PffftExports {
    memory: WebAssembly.Memory;
    _initialize(): void;
    pffft_new_setup(n: number, transform: number): number;
    pffft_aligned_malloc(bytes: number): number;
    pffft_transform_ordered(setup: number, input: number, output: number, work: number, direction: number): void;
}

let pffft: PffftExports | null | undefined;
const setups = new Map<number, { setup: number; input: number; output: number; work: number }>();

function load(): PffftExports | null {
    if (pffft === undefined) {
        try {
            pffft = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(PFFFT_WASM, 'base64')), {}).exports as unknown as PffftExports;
            pffft._initialize();
        } catch {
            pffft = null;
        }
    }
    return pffft;
}

/** transform() on pffft: the windowed frame in, |X[k]|·norm out (k = 0 … N/2), into fft.spectrum. */
function pffftTransform(fft: Fft): Float32Array {
    const P = load();
    if (!P) return transformJs(fft);
    const N = fft.size;
    let s = setups.get(N);
    if (!s) {
        s = { setup: P.pffft_new_setup(N, 0), input: P.pffft_aligned_malloc(N * 4), output: P.pffft_aligned_malloc(N * 4), work: P.pffft_aligned_malloc(N * 4) };
        setups.set(N, s);
    }
    const input = new Float32Array(P.memory.buffer, s.input, N);
    const { frame, hann } = fft;
    for (let n = 0; n < N; n += 1) input[n] = frame[n] * hann[n];
    P.pffft_transform_ordered(s.setup, s.input, s.output, s.work, 0);
    // Ordered real layout: X0, X(N/2), then Re, Im of X1 … X(N/2 − 1).
    const out = new Float32Array(P.memory.buffer, s.output, N);
    const { half, norm, spectrum } = fft;
    spectrum[0] = Math.abs(out[0]) * norm;
    spectrum[half] = Math.abs(out[1]) * norm;
    for (let k = 1; k < half; k += 1) {
        const re = out[2 * k];
        const im = out[2 * k + 1];
        spectrum[k] = Math.sqrt(re * re + im * im) * norm;
    }
    return spectrum;
}

/** Plugs pffft in behind the format's transform(). */
export function installSpectralBackend(): void {
    setSpectralBackend(pffftTransform);
}
