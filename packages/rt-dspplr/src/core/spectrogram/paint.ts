import type { SpectrogramData } from './SpectrogramAnalyzer';

// ---------------------------------------------------------------------------
// Colouring a spectrogram computed by the worker
// ---------------------------------------------------------------------------
//
// The level of a cell is its magnitude in dB against the clip's loudest bin,
// mapped from `floorDb` below it to 0…1 and raised to 1.7. The colour runs
// from the background to a stem colour by 0.72 and on towards `peak`, so the
// loudest cells still separate.
//
// - 'single': one colour for the whole picture, taken from the mix position:
//   stem A's colour at A alone, the mix colour with both, stem B's at B alone.
//   With a colormap (palette.colormap) the level runs through the map's stops
//   instead, whatever the mix.
// - 'dual': each cell coloured by which stem it comes from, so the picture
//   shows where the two parts are and fades one as the mix moves away from it.

export type SpectrogramColorMode = 'single' | 'dual';

export interface SpectrogramPalette {
    /** Empty cells, and the bottom of every ramp (a colormap's first colour replaces it). */
    background: string;
    /** Stem A alone. */
    colorA: string;
    /** Stem B alone. */
    colorB: string;
    /** Both stems in equal parts. */
    colorMix: string;
    /** What the loudest cells run towards. */
    peak: string;
    /**
     * A colormap for colorMode 'single': a name of COLORMAPS ('magma', 'inferno',
     * 'plasma', 'viridis', 'grey'; with '_r' reversed, e.g. 'magma_r'), or its
     * colours from quiet to loud. Its first colour is the background. null or
     * absent: the three-colour ramp above. 'dual' keeps the stem colours.
     */
    colormap?: ColormapName | `${ColormapName}_r` | readonly string[] | null;
}

/** The named colormaps. */
export type ColormapName = 'magma' | 'inferno' | 'plasma' | 'viridis' | 'grey';

/**
 * Matplotlib's perceptually uniform colormaps (CC0), sampled at 11 points
 * from quiet to loud; the painter interpolates between them.
 */
export const COLORMAPS: Readonly<Record<ColormapName, readonly string[]>> = Object.freeze({
    magma: ['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d', '#fecf92', '#fcfdbf'],
    inferno: ['#000004', '#160b39', '#420a68', '#6a176e', '#932667', '#bc3754', '#dd513a', '#f37819', '#fca50a', '#f6d746', '#fcffa4'],
    plasma: ['#0d0887', '#41049d', '#6a00a8', '#8f0da4', '#b12a90', '#cc4778', '#e16462', '#f2844b', '#fca636', '#fcce25', '#f0f921'],
    viridis: ['#440154', '#482475', '#414487', '#355f8d', '#2a788e', '#21918c', '#22a884', '#44bf70', '#7ad151', '#bddf26', '#fde725'],
    grey: ['#000000', '#ffffff'],
});

/** A colormap's colours from quiet to loud, or null for none. */
export function colormapStops(map: SpectrogramPalette['colormap']): readonly string[] | null {
    if (!map) return null;
    if (typeof map !== 'string') return map.length >= 2 ? map : null;
    const name = map.trim();
    const reversed = name.endsWith('_r');
    const stops = COLORMAPS[(reversed ? name.slice(0, -2) : name) as ColormapName];
    if (!stops) return null;
    return reversed ? [...stops].reverse() : stops;
}

/** What empty cells are painted with: the colormap's first colour, else the background. */
export function spectrogramBackground(palette: SpectrogramPalette): string {
    return colormapStops(palette.colormap)?.[0] ?? palette.background;
}

/** Orange for stem A, blue for stem B, purple for both, on a dark panel: the colours of EQSEP 2. */
export const DEFAULT_SPECTROGRAM_PALETTE: Readonly<SpectrogramPalette> = Object.freeze({
    background: '#131315',
    colorA: '#eb9746',
    colorB: '#65a8ed',
    colorMix: '#ae7be7',
    peak: '#ffffff',
});

export interface SpectrogramLook {
    colorMode: SpectrogramColorMode;
    palette: SpectrogramPalette;
    /** How far below the loudest bin is drawn as background. */
    floorDb: number;
}

const KNEE = 0.72;
const GAMMA = 1.7;
const WHITE_EXPONENT = 1.4;
const RATIO_STEPS = 64;

type Rgb = [number, number, number];

function parseColor(value: string): Rgb {
    const hex = value.trim().replace(/^#/, '');
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    const n = Number.parseInt(full.slice(0, 6), 16);
    if (!Number.isFinite(n) || full.length < 6) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerp(a: Rgb, b: Rgb, k: number): Rgb {
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Stem A's colour at 0, the mix colour at 0.5, stem B's at 1. */
function blend(palette: { a: Rgb; mix: Rgb; b: Rgb }, ratio: number): Rgb {
    return ratio <= 0.5 ? lerp(palette.a, palette.mix, ratio * 2) : lerp(palette.mix, palette.b, ratio * 2 - 1);
}

/** 256 RGBA entries through a colormap's stops, evenly spaced. */
function rampStops(stops: readonly Rgb[]): Uint8ClampedArray {
    const out = new Uint8ClampedArray(256 * 4);
    const last = stops.length - 1;
    for (let i = 0; i < 256; i += 1) {
        const x = (i / 255) * last;
        const k = Math.min(last - 1, Math.floor(x));
        const c = lerp(stops[k], stops[k + 1], x - k);
        out[i * 4] = c[0];
        out[i * 4 + 1] = c[1];
        out[i * 4 + 2] = c[2];
        out[i * 4 + 3] = 255;
    }
    return out;
}

const mapLuts = new Map<string, Uint8ClampedArray>();

function colormapLut(stops: readonly string[]): Uint8ClampedArray {
    const key = stops.join(',');
    let lut = mapLuts.get(key);
    if (!lut) {
        lut = rampStops(stops.map(parseColor));
        if (mapLuts.size > 16) mapLuts.clear();
        mapLuts.set(key, lut);
    }
    return lut;
}

/** 256 RGBA entries from the background through `color` to `peak`. */
function ramp(background: Rgb, color: Rgb, peak: Rgb): Uint8ClampedArray {
    const out = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i += 1) {
        const t = i / 255;
        const c = t < KNEE
            ? lerp(background, color, t / KNEE)
            : lerp(color, peak, Math.pow((t - KNEE) / (1 - KNEE), WHITE_EXPONENT));
        out[i * 4] = c[0];
        out[i * 4 + 1] = c[1];
        out[i * 4 + 2] = c[2];
        out[i * 4 + 3] = 255;
    }
    return out;
}

// A repaint runs per pixel each time the mix moves, so the level of a cell
// is looked up rather than computed: log2 from the float's own exponent plus a
// quadratic on its mantissa (within 0.01 octave, 0.06 dB - well under one of
// the 256 colour steps, which are 0.26 dB apart at a 66 dB floor), then a
// table for the 1.7 power.

const LEVEL_STEPS = 1024;
const LEVELS = (() => {
    const table = new Uint8Array(LEVEL_STEPS + 1);
    for (let i = 0; i <= LEVEL_STEPS; i += 1) table[i] = Math.round(Math.pow(i / LEVEL_STEPS, GAMMA) * 255);
    return table;
})();
const floatBits = new Float32Array(1);
const floatWord = new Uint32Array(floatBits.buffer);

function fastLog2(x: number): number {
    floatBits[0] = x;
    const word = floatWord[0];
    const mantissa = (word & 0x7fffff) / 0x800000;
    return ((word >>> 23) & 255) - 127 + mantissa * (1.3466 - 0.3466 * mantissa);
}

/** 0…255 level of a linear magnitude: `scale` and `offset` place the reference and the floor. */
function levelIndex(magnitude: number, scale: number, offset: number): number {
    const step = fastLog2(magnitude) * scale + offset;
    if (step <= 0) return 0;
    if (step >= LEVEL_STEPS) return 255;
    return LEVELS[step | 0];
}

/**
 * Paint `data` into `target` (columns × rows pixels) for stem gains
 * `[gainA, gainB]`. `reference` is the linear magnitude drawn at the top of
 * the range: `data.referenceSum` when the stems add up, `referenceMax` for a
 * crossfade.
 */
export function paintSpectrogram(
    target: ImageData,
    data: SpectrogramData,
    gains: readonly [number, number],
    look: SpectrogramLook,
    reference: number,
): void {
    const pixels = target.data;
    const cells = Math.min(data.columns * data.rows, target.width * target.height);
    const stops = colormapStops(look.palette.colormap);
    const background = parseColor(spectrogramBackground(look.palette));
    const peak = parseColor(look.palette.peak);
    const colors = { a: parseColor(look.palette.colorA), mix: parseColor(look.palette.colorMix), b: parseColor(look.palette.colorB) };
    const referenceDb = 20 * Math.log10(reference + 1e-9);
    const floorDb = Math.max(1, look.floorDb);
    // dB = 20·log10(m) = 6.0206·log2(m); the level runs from the floor (0) to the reference (1).
    const scale = (6.0206 / floorDb) * LEVEL_STEPS;
    const offset = ((floorDb - referenceDb) / floorDb) * LEVEL_STEPS;
    const magB = data.magB;
    const gainA = gains[0];
    const gainB = magB ? gains[1] : 0;
    const effectiveA = magB ? gainA : 1;

    if (look.colorMode === 'single' || !magB) {
        const total = effectiveA + gainB;
        const lut = stops ? colormapLut(stops) : ramp(background, blend(colors, total > 0 ? gainB / total : 0), peak);
        for (let i = 0; i < cells; i += 1) {
            const m = effectiveA * data.magA[i] + (magB ? gainB * magB[i] : 0);
            const o = levelIndex(m, scale, offset) * 4;
            const p = i * 4;
            pixels[p] = lut[o];
            pixels[p + 1] = lut[o + 1];
            pixels[p + 2] = lut[o + 2];
            pixels[p + 3] = 255;
        }
        return;
    }

    const luts: Uint8ClampedArray[] = [];
    for (let step = 0; step <= RATIO_STEPS; step += 1) {
        luts.push(ramp(background, blend(colors, step / RATIO_STEPS), peak));
    }
    for (let i = 0; i < cells; i += 1) {
        const a = gainA * data.magA[i];
        const b = gainB * magB[i];
        const m = a + b;
        const lut = luts[m > 0 ? Math.round((b / m) * RATIO_STEPS) : 0];
        const o = levelIndex(m, scale, offset) * 4;
        const p = i * 4;
        pixels[p] = lut[o];
        pixels[p + 1] = lut[o + 1];
        pixels[p + 2] = lut[o + 2];
        pixels[p + 3] = 255;
    }
}
