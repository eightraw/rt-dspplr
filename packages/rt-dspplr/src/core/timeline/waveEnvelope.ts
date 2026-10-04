import { pickPeakPyramidLevel, type WaveformPeakPyramid } from '../waveform/pyramid';

// Envelope-style waveform: for every device-pixel column of the visible
// sample range, the min/max peak (outer envelope) and the RMS (inner body)
// are resolved from the best pyramid level for that range, then drawn as two
// filled shapes. The level is re-picked on every call, i.e. on every zoom/pan.

export interface ColumnData {
    min: Float32Array;
    max: Float32Array;
    rms: Float32Array;
}

/** Per-column min/max/RMS for samples [startSample, endSample) over `columns` columns. */
export function resolveColumns(
    pyramid: WaveformPeakPyramid | null,
    startSample: number,
    endSample: number,
    columns: number,
): ColumnData | null {
    const count = Math.max(1, Math.floor(columns));
    // Ask for ~2 bins per column so every column has a real extremum.
    const level = pickPeakPyramidLevel(pyramid, startSample, endSample, count * 2);
    if (!level || level.maxPeaks.length === 0) return null;

    const bins = level.maxPeaks.length;
    const binSize = Math.max(1, level.binSize);
    const span = Math.max(1, endSample - startSample) / count;
    const min = new Float32Array(count);
    const max = new Float32Array(count);
    const rms = new Float32Array(count);

    for (let x = 0; x < count; x += 1) {
        const from = startSample + x * span;
        const first = Math.min(bins - 1, Math.max(0, Math.floor(from / binSize)));
        const last = Math.min(bins, Math.max(first + 1, Math.ceil((from + span) / binSize)));
        let lo = Infinity;
        let hi = -Infinity;
        let r = 0;
        for (let b = first; b < last; b += 1) {
            const bl = level.minPeaks[b];
            const bh = level.maxPeaks[b];
            const br = level.rmsPeaks[b];
            if (bl < lo) lo = bl;
            if (bh > hi) hi = bh;
            if (br > r) r = br;
        }
        if (hi < lo) {
            lo = 0;
            hi = 0;
            r = 0;
        }
        min[x] = lo;
        max[x] = hi;
        rms[x] = r;
    }
    return { min, max, rms };
}

function fillBand(
    ctx: CanvasRenderingContext2D,
    top: (x: number) => number,
    bottom: (x: number) => number,
    count: number,
    skip: (x: number) => boolean,
    color: string,
): void {
    let first = -1;
    let last = -1;
    for (let x = 0; x < count; x += 1) {
        if (!skip(x)) {
            if (first < 0) first = x;
            last = x;
        }
    }
    if (first < 0) return;
    ctx.beginPath();
    ctx.moveTo(first, top(first));
    for (let x = first + 1; x <= last; x += 1) ctx.lineTo(x + 0.5, top(x));
    ctx.lineTo(last + 1, top(last));
    ctx.lineTo(last + 1, bottom(last));
    for (let x = last; x >= first; x -= 1) ctx.lineTo(x + 0.5, bottom(x));
    ctx.lineTo(first, bottom(first));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
}

/**
 * Size `canvas` to `width` x `height` CSS px at the device pixel ratio and
 * draw the envelope (`peakColor`) and the RMS body (`rmsColor`). Works in
 * device pixels: one column per physical pixel.
 */
export function drawEnvelope(
    canvas: HTMLCanvasElement,
    pyramid: WaveformPeakPyramid | null,
    startSample: number,
    endSample: number,
    width: number,
    height: number,
    peakColor: string,
    rmsColor: string,
): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const pxW = Math.max(1, Math.round(width * dpr));
    const pxH = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pxW, pxH);

    const data = resolveColumns(pyramid, startSample, endSample, pxW);
    if (!data) return;
    const mid = pxH / 2;
    const amp = pxH * 0.46;
    // A hairline floor keeps silence visible as a centre line.
    const floor = Math.max(0.5, dpr * 0.5);
    const { min, max, rms } = data;

    fillBand(
        ctx,
        (x) => Math.min(mid - floor, mid - max[x] * amp),
        (x) => Math.max(mid + floor, mid - min[x] * amp),
        pxW,
        () => false,
        peakColor,
    );
    fillBand(
        ctx,
        (x) => mid - rms[x] * amp,
        (x) => mid + rms[x] * amp,
        pxW,
        (x) => rms[x] <= 0,
        rmsColor,
    );
}
