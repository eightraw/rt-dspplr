import type { DSPNodeDescriptor } from './DSPChain';
import {
    COMPRESSOR_ATTACK_S,
    COMPRESSOR_RELEASE_S,
    LIMITER_ATTACK_S,
    LIMITER_RELEASE_S,
    computeCompressorParams,
    nativeCompressorMakeupGain,
} from './compression';
import { LIMITER_CEILING_DB } from '../controls';
import {
    createFourthOrderHighPassStages,
    scheduleFourthOrderHighPassFrequency,
} from './highPass';

// ---------------------------------------------------------------------------
// Native Web Audio DSP nodes - wrapping browser-optimized implementations
// ---------------------------------------------------------------------------

// ---- High-Pass Filter ----------------------------------------------------

export interface HighPassNode extends DSPNodeDescriptor {
    readonly name: 'highpass';
    setFrequency(hz: number): void;
    setEnabled(enabled: boolean): void;
}

/**
 * High-pass filter with bypass.
 *
 * When disabled (hz=0), audio passes through unfiltered.
 * Uses two cascaded biquads for a 4th-order Butterworth response
 * (24 dB/oct, maximally flat passband).
 */
export function createHighPass(context: BaseAudioContext, initialHz?: number): HighPassNode {
    const inputGain = context.createGain();
    const outputGain = context.createGain();

    const stages = createFourthOrderHighPassStages(context);
    scheduleFourthOrderHighPassFrequency(stages, initialHz ?? 20, context.currentTime, 0);

    const bypassGain = context.createGain();
    const filteredGain = context.createGain();

    const enabled = (initialHz ?? 0) > 0;
    bypassGain.gain.value = enabled ? 0 : 1;
    filteredGain.gain.value = enabled ? 1 : 0;

    inputGain.connect(bypassGain);
    inputGain.connect(stages[0]);
    stages[0].connect(stages[1]);
    stages[1].connect(filteredGain);
    bypassGain.connect(outputGain);
    filteredGain.connect(outputGain);

    return {
        name: 'highpass',
        input: inputGain,
        output: outputGain,

        setFrequency(hz: number): void {
            const now = context.currentTime;
            const isEnabled = hz > 0;

            scheduleFourthOrderHighPassFrequency(stages, hz, now, 0.02);

            bypassGain.gain.cancelScheduledValues(now);
            bypassGain.gain.setValueAtTime(bypassGain.gain.value, now);
            bypassGain.gain.linearRampToValueAtTime(isEnabled ? 0 : 1, now + 0.02);

            filteredGain.gain.cancelScheduledValues(now);
            filteredGain.gain.setValueAtTime(filteredGain.gain.value, now);
            filteredGain.gain.linearRampToValueAtTime(isEnabled ? 1 : 0, now + 0.02);
        },

        setEnabled(en: boolean): void {
            const now = context.currentTime;
            bypassGain.gain.cancelScheduledValues(now);
            bypassGain.gain.setValueAtTime(bypassGain.gain.value, now);
            bypassGain.gain.linearRampToValueAtTime(en ? 0 : 1, now + 0.02);

            filteredGain.gain.cancelScheduledValues(now);
            filteredGain.gain.setValueAtTime(filteredGain.gain.value, now);
            filteredGain.gain.linearRampToValueAtTime(en ? 1 : 0, now + 0.02);
        },

        disconnect(): void {
            try { inputGain.disconnect(); } catch { /* noop */ }
            for (const stage of stages) {
                try { stage.disconnect(); } catch { /* noop */ }
            }
            try { bypassGain.disconnect(); } catch { /* noop */ }
            try { filteredGain.disconnect(); } catch { /* noop */ }
            try { outputGain.disconnect(); } catch { /* noop */ }
        },
    };
}

// ---- Compressor ----------------------------------------------------------

export interface CompressorNode extends DSPNodeDescriptor {
    readonly name: 'compressor';
    /** Set compression amount 0-1 (0 = off, 1 = maximum). */
    setAmount(amount: number): void;
}

/** Time constant of parameter moves (about 95 % there in 20 ms). */
const COMPRESSOR_SMOOTHING_S = 0.0067;

/** The node's settings for compAmount, and the gain that cancels the node's automatic makeup. */
function nativeCompressorSettings(amount: number) {
    const p = computeCompressorParams(Math.max(0, Math.min(1, amount)));
    // The node's knee runs from the threshold up; the worklet's is centred on it.
    const thresholdDb = p.thresholdDb - p.halfKnee;
    return {
        thresholdDb,
        ratio: p.ratio,
        kneeDb: p.kneeDb,
        compensation: 1 / nativeCompressorMakeupGain(thresholdDb, p.kneeDb, p.ratio),
    };
}

/**
 * Native DynamicsCompressorNode with parameters mapped from compAmount (0-1),
 * the fallback of the dynamics worklet. A gain after it cancels the automatic
 * makeup gain the node applies (+14 dB at amount 1), so the fallback
 * sits within about 1 dB of the worklet's levels. Amount changes glide.
 */
export function createCompressor(context: BaseAudioContext, initialAmount?: number): CompressorNode {
    const compressor = context.createDynamicsCompressor();
    const compensation = context.createGain();
    compressor.attack.value = COMPRESSOR_ATTACK_S;
    compressor.release.value = COMPRESSOR_RELEASE_S;

    const initial = nativeCompressorSettings(initialAmount ?? 0);
    compressor.threshold.value = initial.thresholdDb;
    compressor.ratio.value = initial.ratio;
    compressor.knee.value = initial.kneeDb;
    compensation.gain.value = initial.compensation;
    compressor.connect(compensation);

    const glide = (param: AudioParam, value: number, now: number): void => {
        param.cancelScheduledValues(now);
        param.setTargetAtTime(value, now, COMPRESSOR_SMOOTHING_S);
    };

    return {
        name: 'compressor',
        input: compressor,
        output: compensation,

        setAmount(a: number): void {
            // Stepped values click, and the node recomputes its makeup gain for
            // every block without smoothing: both glide instead.
            const now = context.currentTime;
            const s = nativeCompressorSettings(a);
            glide(compressor.threshold, s.thresholdDb, now);
            glide(compressor.ratio, s.ratio, now);
            glide(compressor.knee, s.kneeDb, now);
            glide(compensation.gain, s.compensation, now);
        },

        disconnect(): void {
            try { compressor.disconnect(); } catch { /* noop */ }
            try { compensation.disconnect(); } catch { /* noop */ }
        },
    };
}

// ---- Output Gain ---------------------------------------------------------

export interface OutputGainNode extends DSPNodeDescriptor {
    readonly name: 'outputGain';
    /** Set gain in linear scale. */
    setGain(value: number): void;
}

export function createOutputGain(context: BaseAudioContext, initialGain?: number): OutputGainNode {
    const gain = context.createGain();
    gain.gain.value = initialGain ?? 1;

    return {
        name: 'outputGain',
        input: gain,
        output: gain,

        setGain(value: number): void {
            const now = context.currentTime;
            gain.gain.cancelScheduledValues(now);
            gain.gain.setValueAtTime(gain.gain.value, now);
            gain.gain.linearRampToValueAtTime(value, now + 0.02);
        },

        disconnect(): void {
            try { gain.disconnect(); } catch { /* noop */ }
        },
    };
}

// ---- Limiter -------------------------------------------------------------

export interface LimiterNode extends DSPNodeDescriptor {
    readonly name: 'limiter';
}

/**
 * A soft ceiling: a DynamicsCompressorNode at ratio 20 with no knee, just
 * under 0 dBFS. It is not a brickwall: a peak far over it still comes out a
 * fraction of a dB over. (The player's own -0.01 dBFS ceiling is a hard clip
 * in its effect chain, not this node.)
 */
export function createLimiter(context: BaseAudioContext): LimiterNode {
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = LIMITER_CEILING_DB;
    limiter.ratio.value = 20;
    limiter.knee.value = 0;
    limiter.attack.value = LIMITER_ATTACK_S;
    limiter.release.value = LIMITER_RELEASE_S;

    return {
        name: 'limiter',
        input: limiter,
        output: limiter,

        disconnect(): void {
            try { limiter.disconnect(); } catch { /* noop */ }
        },
    };
}
