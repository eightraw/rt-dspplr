const EPSILON = 1e-6;

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

export function dbToGain(db: number): number {
    return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
    return 20 * Math.log10(Math.max(EPSILON, gain));
}

// ---------------------------------------------------------------------------
// Compressor parameters - shared between native DynamicsCompressorNode
// and waveform worker preview
// ---------------------------------------------------------------------------

export interface CompressorParams {
    thresholdDb: number;
    ratio: number;
    kneeDb: number;
    halfKnee: number;
}

export interface CompressorTimeConstants {
    envAttack: number;
    envRelease: number;
    gainAttack: number;
    gainRelease: number;
}

// Native-node timing values: peak control rather than broad levelling.
export const COMPRESSOR_ATTACK_S = 0.006;
export const COMPRESSOR_RELEASE_S = 0.09;

// Worklet/preview detector timing.
// The detector reacts faster than the applied gain so loud peaks
// are noticed early, while onsets are not crushed as hard.
const COMPRESSOR_ENV_ATTACK_S = 0.0015;
const COMPRESSOR_ENV_RELEASE_S = 0.045;
export const LIMITER_ATTACK_S = 0.001;
export const LIMITER_RELEASE_S = 0.01;

/**
 * Map compAmount (0-1) to a peak compressor. The curve is selective rather
 * than a broad leveller: the body of the material stays open, loud peaks are
 * pushed down harder as the amount rises.
 *   0%   -> threshold 0 dB, ratio 1:1,  knee 2 dB
 *   50%  -> threshold -12 dB, ratio 8.5:1, knee 5 dB
 *   100% -> threshold -24 dB, ratio 16:1, knee 8 dB
 */
export function computeCompressorParams(compAmount: number): CompressorParams {
    const amount = clamp01(compAmount);
    const kneeDb = 2 + amount * 6;
    return {
        thresholdDb: amount * -24,
        ratio: 1 + amount * 15,
        kneeDb,
        halfKnee: kneeDb * 0.5,
    };
}

/**
 * Exponential time constants for the waveform worker and worklet envelope follower.
 * The detector is intentionally faster than the applied gain envelope.
 */
export function computeCompressorTimeConstants(rate: number): CompressorTimeConstants {
    return {
        envAttack: Math.exp(-1 / (rate * COMPRESSOR_ENV_ATTACK_S)),
        envRelease: Math.exp(-1 / (rate * COMPRESSOR_ENV_RELEASE_S)),
        gainAttack: Math.exp(-1 / (rate * COMPRESSOR_ATTACK_S)),
        gainRelease: Math.exp(-1 / (rate * COMPRESSOR_RELEASE_S)),
    };
}

/**
 * Downward-only gain reduction with soft knee (standard DAW formula).
 * Returns a negative dB value (gain reduction) or 0 when below threshold.
 */
export function computeGainReductionDb(
    envDb: number,
    params: CompressorParams,
): number {
    const { thresholdDb, ratio, kneeDb, halfKnee } = params;

    if (ratio <= 1 || envDb <= thresholdDb - halfKnee) {
        return 0;
    }

    if (envDb >= thresholdDb + halfKnee) {
        return (1 / ratio - 1) * (envDb - thresholdDb);
    }

    const x = envDb - thresholdDb + halfKnee;
    return (1 / ratio - 1) * x * x / (2 * kneeDb);
}
