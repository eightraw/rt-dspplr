// Spectrogram worker. Holds a mono copy of each stem and answers requests for
// a window of the clip at a given size: one magnitude per pixel, per stem,
// on a logarithmic frequency axis. The colours are applied on the main thread,
// so moving the mix only repaints and never asks this worker again.
// Bundled into a self-contained string at library build time.

import type {
    SpectralLevel,
    SpectralPyramid,
    SpectrogramComputeMessage,
    SpectrogramLoadMessage,
    SpectrogramPyramidMessage,
    SpectrogramPyramidResponse,
    SpectrogramResponse,
    SpectrogramUnloadMessage,
} from './protocol';
import {
    REFERENCE_FFT,
    type Fft,
    fftOf,
    loadFrame,
    transform,
    type RowPlan,
    rowValue,
    type Band,
    planBands,
    PYRAMID_MIN_HOP,
    PYRAMID_MAX_FRAMES,
    PYRAMID_BANDS,
    framesOfStem,
    halve,
} from './spectral';

type WorkerMessage = SpectrogramLoadMessage | SpectrogramComputeMessage | SpectrogramPyramidMessage | SpectrogramUnloadMessage;

const workerScope = self as unknown as {
    onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
    postMessage(message: unknown, transfer?: Transferable[]): void;
};

interface Clip {
    loadId: number;
    sampleRate: number;
    /** Mono, 16-bit: half the memory of floats, and far below the 66 dB the picture shows. */
    stemA: Int16Array | null;
    stemB: Int16Array | null;
    referenceSum: number;
    referenceMax: number;
}

/** What each view on the page has loaded. */
const clips = new Map<number, Clip>();

// ---- Requests -------------------------------------------------------------------

/** The loudest bin of the whole clip, sampled at up to ~4000 frames. */
function measureReference(clip: Clip): void {
    let referenceSum = 0;
    let referenceMax = 0;
    const a = clip.stemA;
    if (!a || a.length === 0) return;
    const fft = fftOf(REFERENCE_FFT);
    const b = clip.stemB;
    const frames = Math.max(1, Math.min(4000, Math.ceil(a.length / fft.half)));
    const spectrumA = new Float32Array(fft.half + 1);
    for (let i = 0; i < frames; i += 1) {
        const centre = ((i + 0.5) * a.length) / frames;
        loadFrame(fft, a, centre);
        spectrumA.set(transform(fft));
        let spectrumB: Float32Array | null = null;
        if (b) {
            loadFrame(fft, b, centre);
            spectrumB = transform(fft);
        }
        for (let k = 0; k <= fft.half; k += 1) {
            const ma = spectrumA[k];
            const mb = spectrumB ? spectrumB[k] : 0;
            if (ma + mb > referenceSum) referenceSum = ma + mb;
            if (ma > referenceMax) referenceMax = ma;
            if (mb > referenceMax) referenceMax = mb;
        }
    }
    clip.referenceSum = referenceSum;
    clip.referenceMax = referenceMax;
}

/**
 * The rows of one FFT for every column of one stem, into `out` (rows not
 * listed are left alone).
 *
 * Columns narrower than an eighth of the window share frames: closer than
 * that, two frames show the same thing, so a zoomed-in view transforms one
 * frame per eighth of a window and draws the columns between two frames as a
 * blend of them, rather than repeating one in steps. A column wider than half the window
 * takes the loudest of up to four frames spread across it, so a drum hit
 * between two frames of a long clip still shows.
 */
function fillRows(
    stem: Int16Array,
    out: Float32Array,
    columns: number,
    startSample: number,
    perColumn: number,
    fft: Fft,
    plan: RowPlan,
    rows: Int32Array,
): void {
    const values = new Float32Array(rows.length);
    const pool = Math.max(1, Math.min(4, Math.ceil(perColumn / (fft.size / 2))));
    if (pool > 1) {
        for (let column = 0; column < columns; column += 1) {
            values.fill(0);
            for (let k = 0; k < pool; k += 1) {
                loadFrame(fft, stem, startSample + (column + (k + 0.5) / pool) * perColumn);
                const spectrum = transform(fft);
                for (let i = 0; i < rows.length; i += 1) {
                    const v = rowValue(spectrum, plan, rows[i]);
                    if (v > values[i]) values[i] = v;
                }
            }
            for (let i = 0; i < rows.length; i += 1) out[rows[i] * columns + column] = values[i];
        }
        return;
    }
    const hop = Math.max(perColumn, fft.size / 8);
    const origin = startSample + perColumn / 2;
    const frameAt = (index: number, into: Float32Array) => {
        loadFrame(fft, stem, origin + index * hop);
        const spectrum = transform(fft);
        for (let i = 0; i < rows.length; i += 1) into[i] = rowValue(spectrum, plan, rows[i]);
    };
    if (hop === perColumn) {
        for (let column = 0; column < columns; column += 1) {
            frameAt(column, values);
            for (let i = 0; i < rows.length; i += 1) out[rows[i] * columns + column] = values[i];
        }
        return;
    }
    let before = new Float32Array(rows.length);
    let after = values;
    let index = -2;
    for (let column = 0; column < columns; column += 1) {
        const position = (column * perColumn) / hop;
        const frame = Math.floor(position);
        if (frame !== index) {
            if (frame === index + 1) {
                const spare = before;
                before = after;
                after = spare;
                frameAt(frame + 1, after);
            } else {
                frameAt(frame, before);
                frameAt(frame + 1, after);
            }
            index = frame;
        }
        const k = position - frame;
        for (let i = 0; i < rows.length; i += 1) out[rows[i] * columns + column] = before[i] + (after[i] - before[i]) * k;
    }
}

/** One stem into `out`, band by band, each row the weighted sum of the bands that draw it. */
function computeStem(
    stem: Int16Array,
    out: Float32Array,
    columns: number,
    startSample: number,
    span: number,
    layout: { bands: Band[]; weights: Float32Array[] },
): void {
    const perColumn = span / columns;
    if (layout.bands.length === 1) {
        const band = layout.bands[0];
        fillRows(stem, out, columns, startSample, perColumn, band.fft, band.plan, band.rows);
        return;
    }
    out.fill(0);
    const scratch = new Float32Array(out.length);
    layout.bands.forEach((band, index) => {
        fillRows(stem, scratch, columns, startSample, perColumn, band.fft, band.plan, band.rows);
        const weight = layout.weights[index];
        for (const row of band.rows) {
            const w = weight[row];
            const base = row * columns;
            for (let column = 0; column < columns; column += 1) out[base + column] += w * scratch[base + column];
        }
    });
}

function compute(clip: Clip, message: SpectrogramComputeMessage): void {
    const { stemB, sampleRate } = clip;
    const a = clip.stemA;
    const columns = Math.max(1, Math.floor(message.columns));
    const rows = Math.max(1, Math.floor(message.rows));
    const magA = new Float32Array(columns * rows);
    const magB = stemB ? new Float32Array(columns * rows) : null;
    if (a && a.length > 0 && sampleRate > 0) {
        if (clip.referenceSum === 0) measureReference(clip);
        const maxHz = Math.min(message.maxHz, sampleRate / 2);
        const bands = message.bands && message.bands.length > 0
            ? [...message.bands].sort((x, y) => x.fromHz - y.fromHz)
            : [{ fftSize: message.fftSize, fromHz: 0 }];
        const layout = planBands(sampleRate, rows, message.minHz, maxHz, bands);
        const startSample = message.start * sampleRate;
        const span = (message.end - message.start) * sampleRate;
        computeStem(a, magA, columns, startSample, span, layout);
        if (stemB && magB) computeStem(stemB, magB, columns, startSample, span, layout);
    }
    const response: SpectrogramResponse = {
        type: 'spectrogram',
        viewId: message.viewId,
        requestId: message.requestId,
        loadId: clip.loadId,
        start: message.start,
        end: message.end,
        columns,
        rows,
        magA,
        magB,
        referenceSum: clip.referenceSum,
        referenceMax: clip.referenceMax,
    };
    workerScope.postMessage(response, magB ? [magA.buffer, magB.buffer] : [magA.buffer]);
}

// ---- The pyramid ----------------------------------------------------------------
//
// The whole clip once, the way the waveform's peaks are built: frames on a
// grid of at least 512 samples (no more than 8192 of them), each through the
// three bands, stored as 8-bit levels below the clip's loudest bin, then
// halved level by level keeping the louder of each pair. Every zoom, pan and
// size afterwards is a lookup on the main thread.

function buildPyramid(viewId: number, clip: Clip, message: SpectrogramPyramidMessage): void {
    const a = clip.stemA;
    if (!a || a.length === 0 || clip.sampleRate <= 0) return;
    if (clip.referenceSum === 0) measureReference(clip);
    const rows = Math.max(16, Math.floor(message.rows));
    const hop = Math.max(PYRAMID_MIN_HOP, Math.ceil(a.length / PYRAMID_MAX_FRAMES));
    const frames = Math.max(1, Math.ceil(a.length / hop));
    const maxHz = Math.min(message.maxHz, clip.sampleRate / 2);
    const layout = planBands(clip.sampleRate, rows, message.minHz, maxHz, PYRAMID_BANDS);
    const rangeDb = Math.max(1, message.rangeDb);
    const topDb = 20 * Math.log10(Math.max(clip.referenceSum, clip.referenceMax) + 1e-12);
    const levels: SpectralLevel[] = [{
        binSize: hop,
        frames,
        a: framesOfStem(a, frames, hop, layout, rows, topDb, rangeDb),
        b: clip.stemB ? framesOfStem(clip.stemB, frames, hop, layout, rows, topDb, rangeDb) : null,
    }];
    while (levels[levels.length - 1].frames > 1) levels.push(halve(levels[levels.length - 1], rows));
    const pyramid: SpectralPyramid = {
        sampleRate: clip.sampleRate,
        totalSamples: a.length,
        rows,
        minHz: message.minHz,
        maxHz,
        topDb,
        rangeDb,
        referenceSum: clip.referenceSum,
        referenceMax: clip.referenceMax,
        levels,
    };
    const response: SpectrogramPyramidResponse = {
        type: 'pyramid',
        viewId,
        requestId: message.requestId,
        loadId: clip.loadId,
        pyramid,
    };
    const transfers: ArrayBuffer[] = [];
    for (const level of levels) {
        transfers.push(level.a.buffer as ArrayBuffer);
        if (level.b) transfers.push(level.b.buffer as ArrayBuffer);
    }
    workerScope.postMessage(response, transfers);
    // The view draws from the pyramid now; its audio is not needed here any more.
    clips.delete(viewId);
}

workerScope.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'load') {
        clips.set(message.viewId, {
            loadId: message.loadId,
            sampleRate: message.sampleRate,
            stemA: message.stemA ? new Int16Array(message.stemA) : null,
            stemB: message.stemB ? new Int16Array(message.stemB) : null,
            referenceSum: 0,
            referenceMax: 0,
        });
        return;
    }
    if (message.type === 'unload') {
        clips.delete(message.viewId);
        return;
    }
    const clip = clips.get(message.viewId);
    if (message.type === 'pyramid') {
        if (clip && message.loadId === clip.loadId) buildPyramid(message.viewId, clip, message);
        return;
    }
    if (message.type === 'compute') {
        if (clip && message.loadId === clip.loadId) {
            compute(clip, message);
        } else {
            // Nothing to compute (the audio has gone, or another clip came): answer anyway, so
            // the view is not left waiting.
            const empty: SpectrogramResponse = {
                type: 'spectrogram', viewId: message.viewId, requestId: message.requestId, loadId: -1,
                start: message.start, end: message.end, columns: 0, rows: 0,
                magA: new Float32Array(0), magB: null, referenceSum: 0, referenceMax: 0,
            };
            workerScope.postMessage(empty);
        }
    }
};

export {};
