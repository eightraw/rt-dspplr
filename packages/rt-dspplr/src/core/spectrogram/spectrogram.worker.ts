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

type WorkerMessage = SpectrogramLoadMessage | SpectrogramComputeMessage | SpectrogramPyramidMessage | SpectrogramUnloadMessage;

const workerScope = self as unknown as {
    onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
    postMessage(message: unknown, transfer?: Transferable[]): void;
};

/** FFT length used for the clip-wide reference level. */
const REFERENCE_FFT = 2048;

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

// ---- FFT ---------------------------------------------------------------------
//
// A real FFT of size N through one complex FFT of size N/2, with a Hann
// window. Tables are kept per size, since a multi-resolution request uses two.

interface Fft {
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

const ffts = new Map<number, Fft>();

function fftOf(size: number): Fft {
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

const FROM_INT16 = 1 / 32767;

/** Load the frame of `stem` centred on sample `centre` (zeros outside the clip). */
function loadFrame(fft: Fft, stem: Int16Array, centre: number): void {
    const start = Math.round(centre - fft.size / 2);
    const frame = fft.frame;
    for (let n = 0; n < fft.size; n += 1) {
        const at = start + n;
        frame[n] = at >= 0 && at < stem.length ? stem[at] * FROM_INT16 : 0;
    }
}

/** |X[k]| for k = 0 … N/2 of the windowed frame, into `fft.spectrum`. */
function transform(fft: Fft): Float32Array {
    const { half, norm, hann, bitReverse, re, im, frame, cos, sin, splitCos, splitSin, spectrum } = fft;
    for (let n = 0; n < half; n += 1) {
        const j = bitReverse[n];
        re[j] = frame[2 * n] * hann[2 * n];
        im[j] = frame[2 * n + 1] * hann[2 * n + 1];
    }
    for (let size = 2; size <= half; size <<= 1) {
        const step = half / size;
        const span = size >> 1;
        for (let start = 0; start < half; start += size) {
            for (let k = 0; k < span; k += 1) {
                const c = cos[k * step];
                const s = -sin[k * step];
                const a = start + k;
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
    for (let k = 0; k <= half; k += 1) {
        const a = k % half;
        const b = (half - k) % half;
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

interface RowPlan {
    lo: Int32Array;
    hi: Int32Array;
    below: Int32Array;
    weight: Float32Array;
    /** Centre of each output row in Hz (row 0 = top). */
    hz: Float32Array;
}

function planRows(fft: Fft, sampleRate: number, rows: number, minHz: number, maxHz: number): RowPlan {
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

function rowValue(spectrum: Float32Array, plan: RowPlan, row: number): number {
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

/** A quarter of an octave on each side of a band edge is a blend of the two bands. */
const BLEND = Math.pow(2, 0.25);

interface Band {
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
function planBands(
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

const PYRAMID_MIN_HOP = 512;
const PYRAMID_MAX_FRAMES = 8192;
const PYRAMID_BANDS = [
    { fftSize: 4096, fromHz: 0 },
    { fftSize: 2048, fromHz: 300 },
    { fftSize: 1024, fromHz: 3000 },
];

function framesOfStem(
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
    const floorDb = topDb - rangeDb;
    const scale = 255 / rangeDb;
    for (let frame = 0; frame < frames; frame += 1) {
        const centre = (frame + 0.5) * hop;
        sum.fill(0);
        layout.bands.forEach((band, index) => {
            loadFrame(band.fft, stem, centre);
            const spectrum = transform(band.fft);
            const weight = layout.weights[index];
            for (const row of band.rows) sum[row] += weight[row] * rowValue(spectrum, band.plan, row);
        });
        const base = frame * rows;
        for (let row = 0; row < rows; row += 1) {
            const level = (20 * Math.log10(sum[row] + 1e-12) - floorDb) * scale;
            out[base + row] = level <= 0 ? 0 : level >= 255 ? 255 : Math.round(level);
        }
    }
    return out;
}

/** The next level up: each frame the louder of two, row by row. */
function halve(level: SpectralLevel, rows: number): SpectralLevel {
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
