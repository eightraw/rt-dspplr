import { LIMITER_CEILING_DB } from '../controls';
import { dbToGain } from '../dsp/compression';
import { clampHighPassHz } from '../dsp/highPass';
import { highPassEnergyRatio, type BandsFile } from '../stream/bandsFile';
import { applyDynamicsAtBinRate, type DynamicsState } from './dynamicsPreview';
import { buildPeakPyramid, type WaveformPeakPyramid } from './pyramid';
import type { GainTrack } from './gainTrack';
import type { WaveformProcessing } from './types';
import { mixGains } from '../controls';

/** Stem B's stored overview (same grid as A) and how it blends with A. */
export interface StemBOverview {
    stored: WaveformPeakPyramid;
    bands: BandsFile | null;
    /** A dry/wet pair: amplitudes add coherently; otherwise RMS adds in quadrature. */
    correlated: boolean;
    /** B's explicit trim (linear). */
    gain: number;
}

// ---------------------------------------------------------------------------
// The processed-waveform preview of a prepared clip where its audio is not in
// memory: an approximation from the stored peaks.
//
//   high-pass  each finest bin is scaled by sqrt(E_hp / E_total) of its band
//              bin (bands.bin; see bandsFile.ts). Without bands (a v1
//              manifest) the high-pass is not previewed here.
//   dynamics   the same compressor + output gain + ceiling code the peaks
//              worker runs (dynamicsPreview.ts), at the worker's own 32-frame
//              rate: each stored bin becomes 32-frame sub-steps, its peak in
//              the first and a sine-crest estimate (RMS × √2) in the rest, so
//              the detector sees what it would see over the decoded audio.
//              (At the stored bins' rate it compressed 1–2 dB too much.)
//   levels     rebuilt from the processed finest one by doubling (buildPeakPyramid),
//              as the peaks worker does, so both modes draw from the same bin sizes.
//
// Inside the decoded window the timeline draws the exact preview instead.
// ---------------------------------------------------------------------------

export function approximateProcessedPyramid(
    stored: WaveformPeakPyramid,
    bands: BandsFile | null,
    processing: WaveformProcessing,
    sampleRate: number,
    lti?: LtiOverview | null,
): WaveformPeakPyramid {
    return approximateProcessed(stored, bands, processing, sampleRate, lti).pyramid;
}

/**
 * Plugins with a magnitude response, over a prepared overview: their combined
 * amplitude response at each row of the prepared spectrogram, and that
 * spectrogram's finest level. Each 85 ms column's level change is the
 * response weighted by the column's energy per row (rows on a log axis, so a
 * row's bandwidth grows with its frequency).
 */
export interface LtiOverview {
    rowAmp: Float32Array;
    spectro: { a: Uint8Array; hop: number; columns: number; rows: number; topDb: number; rangeDb: number; minHz: number; maxHz: number };
}

function ltiColumnRatios(lti: LtiOverview): Float32Array {
    const { a, columns, rows, topDb, rangeDb, minHz, maxHz } = lti.spectro;
    const weight = new Float64Array(rows);
    for (let r = 0; r < rows; r += 1) weight[r] = minHz * Math.pow(maxHz / minHz, rows > 1 ? (rows - 1 - r) / (rows - 1) : 0);
    const power = new Float64Array(256);
    for (let q = 1; q < 256; q += 1) power[q] = Math.pow(10, (topDb - rangeDb + (q / 255) * rangeDb) / 10);
    const out = new Float32Array(columns);
    for (let c = 0; c < columns; c += 1) {
        let num = 0;
        let den = 0;
        for (let r = 0; r < rows; r += 1) {
            const e = power[a[c * rows + r]] * weight[r];
            num += e * lti.rowAmp[r] * lti.rowAmp[r];
            den += e;
        }
        out[c] = den > 0 ? Math.sqrt(num / den) : 1;
    }
    return out;
}

/** The approximate processed pyramid and the dynamics gain track behind it (per stored bin). */
export function approximateProcessed(
    stored: WaveformPeakPyramid,
    bands: BandsFile | null,
    processing: WaveformProcessing,
    sampleRate: number,
    lti?: LtiOverview | null,
    stemB?: StemBOverview | null,
): { pyramid: WaveformPeakPyramid; gain: GainTrack | null } {
    const finest = stored.levels[0];
    if (!finest) return { pyramid: stored, gain: null };
    const bin = finest.binSize;
    const { min, max, rms } = filtered(finest, bands, processing, sampleRate, lti);
    const n = min.length;

    // The A/B blend, before the dynamics (they run on the mixed signal in the player).
    const finestB = stemB?.stored.levels[0];
    const [gA, gB0] = mixGains(processing.mix, processing.mixLaw);
    const gB = gB0 * (stemB?.gain ?? 1);
    if (stemB && finestB && finestB.binSize === bin && gB > 0) {
        const b = filtered(finestB, stemB.bands, processing, sampleRate, lti);
        const m = Math.min(n, b.min.length);
        for (let i = 0; i < n; i += 1) {
            const bmin = i < m ? b.min[i] : 0;
            const bmax = i < m ? b.max[i] : 0;
            const brms = i < m ? b.rms[i] : 0;
            min[i] = gA * min[i] + gB * bmin;
            max[i] = gA * max[i] + gB * bmax;
            rms[i] = stemB.correlated ? gA * rms[i] + gB * brms : Math.sqrt((gA * rms[i]) ** 2 + (gB * brms) ** 2);
        }
    } else if (gA !== 1 && stemB && finestB) {
        for (let i = 0; i < n; i += 1) {
            min[i] *= gA;
            max[i] *= gA;
            rms[i] *= gA;
        }
    }

    const gains = new Float32Array(n);
    applyDynamicsInSubsteps(min, max, rms, bin, sampleRate, processing, gains);

    // Doubling levels, as the peaks worker builds them, so a column picks the same bin size in both modes.
    return { pyramid: buildPeakPyramid(min, max, rms, bin, stored.totalSamples), gain: { binSize: bin, startFrame: 0, values: gains, outputGain: Math.max(0, processing.outputGain) } };
}

/** One stem's finest level with the high-pass and the magnitude-response plugins applied. */
function filtered(
    finest: WaveformPeakPyramid['levels'][number],
    bands: BandsFile | null,
    processing: WaveformProcessing,
    sampleRate: number,
    lti?: LtiOverview | null,
): { min: Float32Array; max: Float32Array; rms: Float32Array } {
    const n = finest.maxPeaks.length;
    const min = new Float32Array(finest.minPeaks);
    const max = new Float32Array(finest.maxPeaks);
    const rms = new Float32Array(finest.rmsPeaks);
    const bin = finest.binSize;
    if (processing.highPassHz > 0 && bands && bands.bins > 0) {
        const hz = clampHighPassHz(processing.highPassHz, sampleRate);
        const ratios = new Float32Array(bands.bins);
        for (let b = 0; b < bands.bins; b += 1) ratios[b] = Math.sqrt(highPassEnergyRatio(bands, b, hz));
        for (let i = 0; i < n; i += 1) {
            const r = ratios[Math.min(bands.bins - 1, Math.floor((i * bin) / bands.framesPerBin))];
            min[i] *= r;
            max[i] *= r;
            rms[i] *= r;
        }
    }

    if (lti && lti.spectro.columns > 0) {
        const ratios = ltiColumnRatios(lti);
        for (let i = 0; i < n; i += 1) {
            const r = ratios[Math.min(ratios.length - 1, Math.floor((i * bin) / lti.spectro.hop))];
            min[i] *= r;
            max[i] *= r;
            rms[i] *= r;
        }
    }
    return { min, max, rms };
}

const SUBSTEP = 32;
const CHUNK = 4096;

/** Run the shared dynamics over 32-frame sub-steps of each bin, chunk by chunk (bounded memory). */
function applyDynamicsInSubsteps(
    min: Float32Array,
    max: Float32Array,
    rms: Float32Array,
    bin: number,
    sampleRate: number,
    processing: WaveformProcessing,
    gains: Float32Array,
): void {
    const comp = Math.min(1, Math.max(0, processing.compression));
    const gain = Math.max(0, processing.outputGain);
    const ceiling = dbToGain(LIMITER_CEILING_DB);
    const steps = Math.max(1, Math.round(bin / SUBSTEP));
    if (comp <= 0 || steps === 1) {
        applyDynamicsAtBinRate(min, max, rms, comp, gain, ceiling, sampleRate / bin, undefined, gains);
        return;
    }
    const state: DynamicsState = { envelope: 0, gain: 1 };
    const smin = new Float32Array(CHUNK * steps);
    const smax = new Float32Array(CHUNK * steps);
    const srms = new Float32Array(CHUNK * steps);
    for (let from = 0; from < min.length; from += CHUNK) {
        const count = Math.min(CHUNK, min.length - from);
        for (let j = 0; j < count; j += 1) {
            const i = from + j;
            const peak = Math.max(-min[i], max[i]);
            const est = Math.min(peak, rms[i] * Math.SQRT2);
            for (let k = 0; k < steps; k += 1) {
                const v = k === 0 ? peak : est;
                smin[j * steps + k] = -v;
                smax[j * steps + k] = v;
                srms[j * steps + k] = rms[i];
            }
        }
        const n = count * steps;
        applyDynamicsAtBinRate(smin.subarray(0, n), smax.subarray(0, n), srms.subarray(0, n), comp, gain, ceiling, sampleRate / SUBSTEP, state);
        for (let j = 0; j < count; j += 1) {
            const i = from + j;
            const peak = Math.max(-min[i], max[i]);
            // The bin's loudest processed sub-step sets its new peak; min and max keep their balance.
            let top = 0;
            let sq = 0;
            for (let k = 0; k < steps; k += 1) {
                if (smax[j * steps + k] > top) top = smax[j * steps + k];
                sq += srms[j * steps + k] * srms[j * steps + k];
            }
            const ratio = peak > 0 ? top / peak : 1;
            max[i] = Math.min(ceiling, max[i] * ratio);
            min[i] = Math.max(-ceiling, min[i] * ratio);
            const rmsOut = Math.sqrt(sq / steps);
            gains[i] = rms[i] > 0 ? rmsOut / rms[i] : gain;
            rms[i] = rmsOut;
        }
    }
}
