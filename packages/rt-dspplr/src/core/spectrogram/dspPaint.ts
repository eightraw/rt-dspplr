import type { AudioPlayerState } from '../AudioPlayer';
import { outputGainDbToGain } from '../controls';
import { HIGH_PASS_SECTION_Q, computeHighPassCoefficients } from '../dsp/highPass';
import { previewSettings } from '../effects/preview';
import type { DspPreview } from '../waveform/followWaveform';
import { gainCovers, gainOver } from '../waveform/gainTrack';
import type { SpectrogramData } from './SpectrogramAnalyzer';

// ---------------------------------------------------------------------------
// The processed spectrogram, applied when it is painted — a knob move only
// repaints, no STFT is computed again:
//
//   per row     |H(f)| of the high-pass, from the SAME coefficients the DSP
//               chain and the waveform preview use (computeHighPassCoefficients,
//               two Butterworth sections): exact for this LTI filter, up to the
//               row's own frequency width.
//   per column  the dynamics gain over the column's time (compressor + output
//               gain + ceiling) from the waveform preview's gain track: exact for
//               a whole clip and for a prepared clip's decoded window,
//               approximate over a prepared overview. The output gain is
//               rescaled at once; a compression move waits for the worker
//               (one debounced recompute, as for the waveform).
// ---------------------------------------------------------------------------

/** Centre frequency of each row (row 0 = the top), as the spectrogram worker plans them. */
export function rowFrequencies(rows: number, minHz: number, maxHz: number): Float32Array {
    const out = new Float32Array(rows);
    const ratio = maxHz / minHz;
    for (let r = 0; r < rows; r += 1) out[rows - 1 - r] = minHz * Math.pow(ratio, rows > 1 ? r / (rows - 1) : 0);
    return out;
}

/** |H(e^{jω})| of one biquad section. */
function sectionMagnitude(c: { b0: number; b1: number; b2: number; a1: number; a2: number }, w: number): number {
    const cos1 = Math.cos(w);
    const sin1 = Math.sin(w);
    const cos2 = Math.cos(2 * w);
    const sin2 = Math.sin(2 * w);
    const nr = c.b0 + c.b1 * cos1 + c.b2 * cos2;
    const ni = -(c.b1 * sin1 + c.b2 * sin2);
    const dr = 1 + c.a1 * cos1 + c.a2 * cos2;
    const di = -(c.a1 * sin1 + c.a2 * sin2);
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Amplitude response of the player's high-pass at each frequency (1 when bypassed). */
export function highPassResponse(freqs: Float32Array, hz: number, sampleRate: number): Float32Array {
    const out = new Float32Array(freqs.length).fill(1);
    if (!(hz > 0)) return out;
    const sections = HIGH_PASS_SECTION_Q.map((q) => computeHighPassCoefficients(sampleRate, hz, q));
    for (let i = 0; i < freqs.length; i += 1) {
        const w = (2 * Math.PI * Math.min(freqs[i], sampleRate / 2 - 1)) / sampleRate;
        out[i] = sections.reduce((g, s) => g * sectionMagnitude(s, w), 1);
    }
    return out;
}

export interface DspPaintInput {
    state: AudioPlayerState;
    preview: DspPreview | null;
    /** Frames per second of the clip's timeline (the gain tracks' unit). */
    timelineRate: number;
    minHz: number;
    maxHz: number;
}

const rowCache = new Map<string, Float32Array>();

/**
 * `data` with the DSP applied, in `reuse`'s arrays when they fit. Returns
 * `data` itself when nothing is to apply (defaults, no preview yet).
 */
export function applyDspToSpectrogram(data: SpectrogramData, input: DspPaintInput, reuse?: SpectrogramData | null): SpectrogramData {
    const { state, preview } = input;
    const p = previewSettings(state);
    const outputGain = outputGainDbToGain(p.outputGainDb);
    const inputGain = outputGainDbToGain(p.inputGainDb);
    const track = preview?.gain ?? null;
    const windowTrack = preview?.windowGain ?? null;
    const hp = p.highPassHz > 0;
    if (!hp && !track && !windowTrack && outputGain === 1 && inputGain === 1 && p.lti.length === 0) return data;
    const { rows, columns } = data;
    const sampleRate = state.audioContext?.sampleRate ?? 48000;
    const key = `${rows}|${input.minHz}|${input.maxHz}|${sampleRate}|${p.key}`;
    let rowGain = rowCache.get(key);
    if (!rowGain) {
        const freqs = rowFrequencies(rows, input.minHz, input.maxHz);
        rowGain = highPassResponse(freqs, p.highPassHz, sampleRate);
        // Plugins with a magnitude response (linear time-invariant): exact per row.
        for (const { plugin, params } of p.lti) {
            try {
                const db = plugin.preview!.magnitudeResponse!(params, freqs, sampleRate);
                for (let r = 0; r < rows; r += 1) rowGain[r] *= Math.pow(10, (db[r] ?? 0) / 20);
            } catch (error) {
                console.warn(`[spectrogram] ${plugin.name}: magnitudeResponse threw; left out`, error);
            }
        }
        if (rowCache.size > 32) rowCache.clear();
        rowCache.set(key, rowGain);
    }
    const colGain = new Float32Array(columns);
    const span = (data.end - data.start) / Math.max(1, columns);
    for (let c = 0; c < columns; c += 1) {
        const from = (data.start + c * span) * input.timelineRate;
        const to = Math.max(from + 1, (data.start + (c + 1) * span) * input.timelineRate);
        // Without a gain track yet: both gains as they are (the compressor's part comes with the track).
        let g = inputGain * outputGain;
        const t = windowTrack && gainCovers(windowTrack, from, to) ? windowTrack : track;
        if (t) g = gainOver(t, from, to) * (t.outputGain && t.outputGain > 0 ? outputGain / t.outputGain : 1);
        colGain[c] = g;
    }
    const cells = rows * columns;
    const magA = reuse && reuse.magA.length === cells ? reuse.magA : new Float32Array(cells);
    const magB = data.magB ? (reuse?.magB && reuse.magB.length === cells ? reuse.magB : new Float32Array(cells)) : null;
    for (let r = 0; r < rows; r += 1) {
        const rg = rowGain[r];
        const base = r * columns;
        for (let c = 0; c < columns; c += 1) {
            const g = rg * colGain[c];
            magA[base + c] = data.magA[base + c] * g;
            if (magB && data.magB) magB[base + c] = data.magB[base + c] * g;
        }
    }
    return { ...data, magA, magB };
}
