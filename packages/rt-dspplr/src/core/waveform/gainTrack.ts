// ---------------------------------------------------------------------------
// GainTrack — the dynamics stage's linear gain over time (compressor + output
// gain + ceiling, RMS out / RMS in per bin), from the same envelope math as the
// waveform preview. The spectrogram multiplies each column by it, so it shows
// what the listener hears without recomputing an STFT.
// ---------------------------------------------------------------------------

export interface GainTrack {
    /** Frames per value. */
    binSize: number;
    /** Timeline frame of values[0] (a partial track covers a window only). */
    startFrame: number;
    values: Float32Array;
    /** The output gain (linear) the track was computed with: a later knob move rescales it at once. */
    outputGain?: number;
}

/** Mean of every `factor` values. */
export function downsampleGains(values: Float32Array, factor: number): Float32Array {
    if (factor <= 1) return values;
    const out = new Float32Array(Math.ceil(values.length / factor));
    for (let i = 0; i < out.length; i += 1) {
        let s = 0;
        const to = Math.min(values.length, (i + 1) * factor);
        for (let j = i * factor; j < to; j += 1) s += values[j];
        out[i] = s / (to - i * factor);
    }
    return out;
}

const prefixes = new WeakMap<Float32Array, Float64Array>();

function prefixOf(values: Float32Array): Float64Array {
    let p = prefixes.get(values);
    if (!p) {
        p = new Float64Array(values.length + 1);
        for (let i = 0; i < values.length; i += 1) p[i + 1] = p[i] + values[i];
        prefixes.set(values, p);
    }
    return p;
}

/** Whether `track` covers the frames [from, to). */
export function gainCovers(track: GainTrack, from: number, to: number): boolean {
    return from >= track.startFrame && to <= track.startFrame + track.values.length * track.binSize;
}

/** Mean gain over the frames [from, to) (O(1) after the first call per track). */
export function gainOver(track: GainTrack, from: number, to: number): number {
    const n = track.values.length;
    if (n === 0) return 1;
    let a = Math.floor((from - track.startFrame) / track.binSize);
    let b = Math.ceil((to - track.startFrame) / track.binSize);
    a = Math.min(n - 1, Math.max(0, a));
    b = Math.min(n, Math.max(a + 1, b));
    const p = prefixOf(track.values);
    return (p[b] - p[a]) / (b - a);
}
