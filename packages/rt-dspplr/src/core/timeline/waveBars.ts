import { pickPeakPyramidLevel, type WaveformPeakPyramid } from '../waveform/pyramid';

// Bar-style waveform: the visible sample range is split into evenly spaced
// columns, each drawn as a rounded vertical bar mirrored around the centre.
// Bar height is the column's peak, with its RMS as a floor so quiet but dense
// material does not vanish; silence keeps a short stub so the track stays visible.

export interface BarLayout {
    /** Width of one bar in CSS px. */
    bar: number;
    /** Gap between bars in CSS px. */
    gap: number;
}

export const DEFAULT_BAR_LAYOUT: BarLayout = { bar: 2, gap: 1.5 };

/** Per-bar amplitudes (0..1) for the sample range [startSample, endSample). */
export function computeBarHeights(
    pyramid: WaveformPeakPyramid | null,
    startSample: number,
    endSample: number,
    barCount: number,
): Float32Array {
    const out = new Float32Array(Math.max(0, barCount));
    if (!pyramid || barCount <= 0 || endSample <= startSample) return out;

    const level = pickPeakPyramidLevel(pyramid, startSample, endSample, barCount * 2);
    if (!level || level.maxPeaks.length === 0) return out;

    const binSize = Math.max(1, level.binSize);
    const lastBin = level.maxPeaks.length - 1;
    const span = (endSample - startSample) / barCount;

    for (let i = 0; i < barCount; i += 1) {
        const from = startSample + i * span;
        const to = from + span;
        const firstBin = Math.min(lastBin, Math.max(0, Math.floor(from / binSize)));
        const endBin = Math.min(level.maxPeaks.length, Math.max(firstBin + 1, Math.ceil(to / binSize)));
        let peak = 0;
        let rms = 0;
        for (let b = firstBin; b < endBin; b += 1) {
            const hi = Math.abs(level.maxPeaks[b] ?? 0);
            const lo = Math.abs(level.minPeaks[b] ?? 0);
            const p = hi > lo ? hi : lo;
            if (p > peak) peak = p;
            const r = level.rmsPeaks[b] ?? 0;
            if (r > rms) rms = r;
        }
        out[i] = Math.min(1, Math.max(peak * 0.85, rms * 1.6));
    }
    return out;
}

function roundedBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const r = Math.min(w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
}

/**
 * Size `canvas` for `width` x `height` CSS px at the device pixel ratio and
 * draw `heights` as bars in `color`.
 */
export function drawBars(
    canvas: HTMLCanvasElement,
    heights: Float32Array,
    width: number,
    height: number,
    color: string,
    layout: BarLayout = DEFAULT_BAR_LAYOUT,
): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const pxW = Math.max(1, Math.round(width * dpr));
    const pxH = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (heights.length === 0) return;

    const step = width / heights.length;
    const barW = Math.max(1, Math.min(layout.bar, step - 0.5));
    const minH = Math.min(height, 2);
    const mid = height / 2;

    ctx.beginPath();
    for (let i = 0; i < heights.length; i += 1) {
        const h = Math.max(minH, heights[i] * height * 0.96);
        const x = i * step + (step - barW) / 2;
        roundedBar(ctx, x, mid - h / 2, barW, h);
    }
    ctx.fillStyle = color;
    ctx.fill();
}

/** Number of bars that fit `width` CSS px. */
export function barCountFor(width: number, layout: BarLayout = DEFAULT_BAR_LAYOUT): number {
    return Math.max(1, Math.floor(width / (layout.bar + layout.gap)));
}
