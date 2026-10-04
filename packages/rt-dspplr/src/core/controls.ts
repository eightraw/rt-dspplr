import { dbToGain } from './dsp/compression';

// ---------------------------------------------------------------------------
// Processing parameters: ranges, defaults, and the dial mappings used by UIs
// ---------------------------------------------------------------------------

export const HIGH_PASS_MAX_HZ = 500;
export const HIGH_PASS_DEFAULT_HZ = 0;
export const COMPRESSION_DEFAULT = 0;
export const OUTPUT_MIN_DB = -24;
export const OUTPUT_MAX_DB = 24;
export const OUTPUT_DEFAULT_DB = 0;
export const LIMITER_CEILING_DB = -0.01;
export const DEFAULT_SPEEDS = [1, 1.25, 1.5, 2] as const;
/** Playback speeds outside this range are clamped: slower renders a buffer many times the clip, faster has no use. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
export const MIX_DEFAULT = 0;

/**
 * Everything the listener can turn. Units are physical so the values can be
 * stored, synced, or set from any UI.
 */
export interface ProcessingState {
    /** 4th-order (24 dB/oct) high-pass cutoff in Hz. 0 = bypassed. */
    highPassHz: number;
    /** Peak compressor amount, 0 (off) to 1 (maximum). */
    compression: number;
    /** Make-up gain before the -0.01 dBFS limiter, in dB. -Infinity = muted. */
    outputGainDb: number;
    /** Playback speed. Pitch is preserved when a stretch strategy is available. */
    speed: number;
    /** Position of the mix control: 0 = stem A … 1 = stem B. The gains follow the player's `MixLaw`. */
    mix: number;
}

/**
 * How the mix control sets the two stems' gains.
 * - `crossfade`: A at `1 - mix`, B at `mix`. For two versions of one recording.
 * - `separation`: both at full in the middle, one fading out towards each end.
 *   For stems that add up to the original: 0 = A alone, 0.5 = the original, 1 = B alone.
 */
export type MixLaw = 'crossfade' | 'separation';

/** Gains of stem A and stem B for a mix position. */
export function mixGains(mix: number, law: MixLaw = 'crossfade'): [number, number] {
    const x = Math.min(1, Math.max(0, Number.isFinite(mix) ? mix : 0));
    if (law === 'separation') return [Math.min(1, 2 * (1 - x)), Math.min(1, 2 * x)];
    return [1 - x, x];
}

export const DEFAULT_PROCESSING: Readonly<ProcessingState> = Object.freeze({
    highPassHz: HIGH_PASS_DEFAULT_HZ,
    compression: COMPRESSION_DEFAULT,
    outputGainDb: OUTPUT_DEFAULT_DB,
    speed: DEFAULT_SPEEDS[0],
    mix: MIX_DEFAULT,
});

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
    return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

export function normalizeHighPassHz(hz: number): number {
    if (!Number.isFinite(hz) || hz <= 0) return 0;
    return clamp(hz, 0, 20000);
}

export function normalizeOutputGainDb(db: number): number {
    if (db === -Infinity) return -Infinity;
    if (!Number.isFinite(db)) return OUTPUT_DEFAULT_DB;
    return clamp(db, OUTPUT_MIN_DB, OUTPUT_MAX_DB);
}

export function normalizeSpeed(speed: number): number {
    if (!Number.isFinite(speed) || speed <= 0) return 1;
    return clamp(speed, SPEED_MIN, SPEED_MAX);
}

export function outputGainDbToGain(db: number): number {
    return db === -Infinity ? 0 : dbToGain(db);
}

// ---- Dial mappings (0..1 knob position <-> parameter) ---------------------

export function dialToHighPassHz(value: number): number {
    const normalized = clamp01(value);
    if (normalized <= 0.001) {
        return 0;
    }

    return Math.round(normalized * HIGH_PASS_MAX_HZ);
}

export function highPassHzToDial(value: number): number {
    if (value <= 0) {
        return 0;
    }

    return clamp(value / HIGH_PASS_MAX_HZ, 0, 1);
}

/** Dial 0 = mute, otherwise linear in dB from OUTPUT_MIN_DB to OUTPUT_MAX_DB. */
export function dialToOutputGainDb(value: number): number {
    const normalized = clamp01(value);
    if (normalized <= 0.001) {
        return -Infinity;
    }

    const db = OUTPUT_MIN_DB + (normalized * (OUTPUT_MAX_DB - OUTPUT_MIN_DB));
    return Math.round(db * 10) / 10;
}

export function outputGainDbToDial(db: number): number {
    if (db === -Infinity) return 0;
    return clamp((db - OUTPUT_MIN_DB) / (OUTPUT_MAX_DB - OUTPUT_MIN_DB), 0.001, 1);
}

// ---- Labels ---------------------------------------------------------------

export function formatHighPassLabel(hz: number): string {
    if (hz <= 0) {
        return 'Off';
    }

    return `${Math.round(hz)} Hz`;
}

export function formatPercentLabel(value01: number): string {
    return `${Math.round(clamp01(value01) * 100)}%`;
}

export function formatOutputGainLabel(db: number): string {
    if (db === -Infinity) {
        return 'Mute';
    }

    return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export function formatMixLabel(mix: number): string {
    if (mix <= 0) return 'Off';
    return formatPercentLabel(mix);
}

export function findSpeedIndex(speeds: readonly number[], value: number): number {
    const foundIndex = speeds.findIndex((option) => Math.abs(option - value) < 0.001);
    return foundIndex >= 0 ? foundIndex : 0;
}

export function formatSpeedLabel(value: number): string {
    return `x${value.toString().replace(/\.0$/, '')}`;
}
