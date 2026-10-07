// ---------------------------------------------------------------------------
// Streaming rational resampler: polyphase FIR from a Kaiser-windowed sinc.
//
// Output rate = input rate × L / M (reduced fraction). The prototype low-pass
// runs at L × input rate with its passband edge at `passbandHz` (default
// 0.4167 × the lower Nyquist… i.e. 20 kHz for 48 kHz out) and its stopband
// from the lower Nyquist (24 kHz for 48 kHz out), at `stopbandDb` (default
// 100 dB) attenuation. Everything that would alias is in the stopband, so
// aliasing products stay ≥ 100 dB down (≈ 90+ dB measured, see the tests);
// the passband ripple is below 0.001 dB.
//
// Zero phase: output frame n is centred on input position n × M / L, so the
// output is time-aligned with the input and has exactly round(frames × L / M)
// frames (the edges see zeros beyond the file, as any FIR would).
// ---------------------------------------------------------------------------

export interface ResamplerOptions {
    passbandHz?: number;
    stopbandHz?: number;
    stopbandDb?: number;
}

export interface ResamplerInfo {
    from: number;
    to: number;
    up: number;
    down: number;
    taps: number;
    tapsPerPhase: number;
    passbandHz: number;
    stopbandHz: number;
    stopbandDb: number;
    method: string;
}

function gcd(a: number, b: number): number {
    while (b) [a, b] = [b, a % b];
    return a;
}

/** Zeroth-order modified Bessel function of the first kind (series). */
function besselI0(x: number): number {
    let sum = 1;
    let term = 1;
    const q = (x * x) / 4;
    for (let k = 1; k < 64; k += 1) {
        term *= q / (k * k);
        sum += term;
        if (term < sum * 1e-17) break;
    }
    return sum;
}

export function designResampler(from: number, to: number, options: ResamplerOptions = {}) {
    const g = gcd(from, to);
    const up = to / g;
    const down = from / g;
    const nyquistOut = Math.min(from, to) / 2;
    const stopbandHz = options.stopbandHz ?? nyquistOut;
    const passbandHz = options.passbandHz ?? Math.min(nyquistOut * (20000 / 24000), stopbandHz * 0.95);
    const stopbandDb = options.stopbandDb ?? 100;
    const protoRate = from * up;
    const cutoff = (passbandHz + stopbandHz) / 2 / protoRate; // cycles per proto sample
    const transition = (2 * Math.PI * (stopbandHz - passbandHz)) / protoRate;
    const beta = stopbandDb > 50 ? 0.1102 * (stopbandDb - 8.7) : 0.5842 * (stopbandDb - 21) ** 0.4 + 0.07886 * (stopbandDb - 21);
    // Kaiser's length estimate, made odd and a whole number of phases on each side.
    const estimate = Math.ceil((stopbandDb - 8) / (2.285 * transition));
    const half = Math.ceil(estimate / 2 / up); // input taps on each side of the centre
    const centre = half * up;
    const length = 2 * centre + 1;
    const h = new Float64Array(length);
    const i0beta = besselI0(beta);
    let sum = 0;
    for (let i = 0; i < length; i += 1) {
        const t = i - centre;
        const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
        const r = t / centre;
        const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0beta;
        h[i] = sinc * w;
        sum += h[i];
    }
    // Interpolating by `up` needs a gain of `up`: each phase then sums to ~1.
    const scale = up / sum;
    // Polyphase table: phase p holds taps h[centre + p - k·up] for input offsets k.
    // Stored as a flat Float32Array [phase][tap], tap j ↔ input index base - half + j.
    const tapsPerPhase = 2 * half + 1;
    const table = new Float32Array(up * tapsPerPhase);
    for (let p = 0; p < up; p += 1) {
        for (let j = 0; j < tapsPerPhase; j += 1) {
            // input index x = base + (j - half); distance in proto samples: p - (j - half)·up
            const d = p - (j - half) * up;
            const idx = centre + d;
            table[p * tapsPerPhase + j] = idx >= 0 && idx < length ? h[idx] * scale : 0;
        }
    }
    const info: ResamplerInfo = {
        from, to, up, down, taps: length, tapsPerPhase, passbandHz, stopbandHz, stopbandDb,
        method: `polyphase Kaiser-windowed sinc (beta ${beta.toFixed(2)}, ${length} taps @ ${up}x, ${tapsPerPhase} per phase)`,
    };
    return { info, table, half, tapsPerPhase };
}

/**
 * Feed planar Float32 blocks with push(), get resampled planar blocks back;
 * end() flushes the tail. Memory: one input history per channel (a few
 * hundred samples) plus the block being processed.
 */
export class StreamingResampler {
    readonly info: ResamplerInfo;
    private readonly _table: Float32Array;
    private readonly _half: number;
    private readonly _taps: number;
    private readonly _channels: number;
    /** Input samples kept, per channel; _buf[c][0] is input index _base. */
    private _buf: Float32Array[];
    private _len = 0;
    private _base = 0;
    /** Input frames received so far. */
    private _inFrames = 0;
    /** Next output frame to produce. */
    private _out = 0;

    constructor(channels: number, from: number, to: number, options?: ResamplerOptions) {
        const design = designResampler(from, to, options);
        this.info = design.info;
        this._table = design.table;
        this._half = design.half;
        this._taps = design.tapsPerPhase;
        this._channels = channels;
        this._buf = Array.from({ length: channels }, () => new Float32Array(4096));
    }

    /** Output frames that `inputFrames` of input produce in total. */
    static outputFrames(inputFrames: number, from: number, to: number): number {
        return Math.round((inputFrames * to) / from);
    }

    push(block: Float32Array[]): Float32Array[] {
        const n = block[0]?.length ?? 0;
        this._append(block, n);
        this._inFrames += n;
        return this._run(false);
    }

    end(): Float32Array[] {
        return this._run(true);
    }

    private _append(block: Float32Array[], n: number): void {
        if (this._len + n > this._buf[0].length) {
            const size = Math.max(this._buf[0].length * 2, this._len + n);
            this._buf = this._buf.map((old) => {
                const next = new Float32Array(size);
                next.set(old.subarray(0, this._len));
                return next;
            });
        }
        for (let c = 0; c < this._channels; c += 1) this._buf[c].set(block[c], this._len);
        this._len += n;
    }

    private _run(final: boolean): Float32Array[] {
        const { up, down } = this.info;
        const total = final ? StreamingResampler.outputFrames(this._inFrames, this.info.from, this.info.to) : Infinity;
        const half = this._half;
        const taps = this._taps;
        // Output n needs input up to floor(n·down/up) + half.
        const available = this._base + this._len; // input indices < available are known
        let last = this._out;
        if (final) {
            last = total;
        } else {
            // largest n with floor(n·down/up) + half < available
            last = Math.max(this._out, Math.floor(((available - half - 1) * up) / down) + 1);
            while (last > this._out && Math.floor(((last - 1) * down) / up) + half >= available) last -= 1;
        }
        const count = Math.max(0, last - this._out);
        const out = Array.from({ length: this._channels }, () => new Float32Array(count));
        const table = this._table;
        for (let k = 0; k < count; k += 1) {
            const n = this._out + k;
            const pos = n * down;
            const centre = Math.floor(pos / up);
            const phase = pos - centre * up;
            const first = centre - half - this._base; // buffer index of tap 0
            const t0 = phase * taps;
            for (let c = 0; c < this._channels; c += 1) {
                const x = this._buf[c];
                let acc = 0;
                const lo = Math.max(0, -first);
                const hi = Math.min(taps, this._len - first);
                for (let j = lo; j < hi; j += 1) acc += table[t0 + j] * x[first + j];
                out[c][k] = acc;
            }
        }
        this._out += count;
        // Drop input no longer needed: the next output's first tap.
        const keepFrom = Math.floor((this._out * down) / up) - half;
        const drop = Math.min(this._len, Math.max(0, keepFrom - this._base));
        if (drop > 0) {
            for (let c = 0; c < this._channels; c += 1) this._buf[c].copyWithin(0, drop, this._len);
            this._len -= drop;
            this._base += drop;
        }
        return out;
    }
}

/**
 * Output frames [n0, n1) of the same resampler, computed from a slice of the
 * input: `x[c][i]` is input index `xStart + i`, and must cover
 * [floor(n0·down/up) − half, floor((n1 − 1)·down/up) + half] where that lies
 * inside [0, inFrames). Outside the input (index < 0 or ≥ inFrames) samples
 * are zero, as in StreamingResampler. Same taps, same order, same
 * accumulation: the result is bit-identical to the streaming resampler's
 * frames n0..n1 — which is what lets prepare resample in parallel chunks.
 */
export function resampleRange(
    design: { info: ResamplerInfo; table: Float32Array; half: number; tapsPerPhase: number },
    x: Float32Array[],
    xStart: number,
    inFrames: number,
    n0: number,
    n1: number,
): Float32Array[] {
    const { up, down } = design.info;
    const { table, half } = design;
    const taps = design.tapsPerPhase;
    const count = Math.max(0, n1 - n0);
    const out = x.map(() => new Float32Array(count));
    for (let k = 0; k < count; k += 1) {
        const n = n0 + k;
        const pos = n * down;
        const centre = Math.floor(pos / up);
        const phase = pos - centre * up;
        const firstIndex = centre - half; // input index of tap 0
        const t0 = phase * taps;
        const lo = Math.max(0, -firstIndex);
        const hi = Math.min(taps, inFrames - firstIndex);
        const first = firstIndex - xStart;
        for (let c = 0; c < x.length; c += 1) {
            const xc = x[c];
            let acc = 0;
            for (let j = lo; j < hi; j += 1) acc += table[t0 + j] * xc[first + j];
            out[c][k] = acc;
        }
    }
    return out;
}

/** Input index range [from, to) that output frames [n0, n1) read. */
export function resampleInputRange(info: ResamplerInfo, half: number, n0: number, n1: number): [number, number] {
    return [Math.floor((n0 * info.down) / info.up) - half, Math.floor(((n1 - 1) * info.down) / info.up) + half + 1];
}
