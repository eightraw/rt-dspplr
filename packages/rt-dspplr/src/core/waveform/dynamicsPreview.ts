import {
    dbToGain,
    gainToDb,
    computeCompressorParams,
    computeCompressorTimeConstants,
    computeGainReductionDb,
} from '../dsp/compression';

// The dynamics stage of the waveform preview (compressor + output gain +
// ceiling), applied to peaks at the rate of their bins. Shared by the peaks
// worker (32-frame bins of a decoded clip) and the stream player's overview
// approximation (stored 256-frame bins).

export interface DynamicsState {
    envelope: number;
    gain: number;
}

export function applyDynamicsAtBinRate(
    minPeaks: Float32Array,
    maxPeaks: Float32Array,
    rmsPeaks: Float32Array,
    compAmount: number,
    outputGain: number,
    ceilingGain: number,
    binRate: number,
    /** Detector and gain carried across calls, for input processed in chunks. */
    state?: DynamicsState,
    /**
     * Receives each bin's linear gain (RMS out / RMS in): compressor, output gain
     * and ceiling together. The spectrogram applies it per column.
     */
    gains?: Float32Array,
): void {
    const binCount = minPeaks.length;

    if (compAmount <= 0 && outputGain === 1) {
        for (let i = 0; i < binCount; i += 1) {
            if (maxPeaks[i] > ceilingGain) { maxPeaks[i] = ceilingGain; }
            if (minPeaks[i] < -ceilingGain) { minPeaks[i] = -ceilingGain; }
            const rmsIn = rmsPeaks[i];
            if (rmsPeaks[i] > ceilingGain) { rmsPeaks[i] = ceilingGain; }
            if (gains) gains[i] = rmsIn > 0 ? rmsPeaks[i] / rmsIn : 1;
        }
        return;
    }

    const tc = computeCompressorTimeConstants(binRate);
    const params = computeCompressorParams(compAmount);

    let detectorEnvelope = state?.envelope ?? 0;
    let appliedGain = state?.gain ?? 1;

    for (let i = 0; i < binCount; i += 1) {
        const absPeak = Math.max(
            minPeaks[i] < 0 ? -minPeaks[i] : minPeaks[i],
            maxPeaks[i] < 0 ? -maxPeaks[i] : maxPeaks[i],
        );

        // Envelope follower
        if (absPeak > detectorEnvelope) {
            detectorEnvelope = detectorEnvelope * tc.envAttack + absPeak * (1 - tc.envAttack);
        } else {
            detectorEnvelope = detectorEnvelope * tc.envRelease + absPeak * (1 - tc.envRelease);
        }

        // Compute gain reduction (downward only)
        let targetGain = 1;
        if (compAmount > 0) {
            const envDb = gainToDb(detectorEnvelope);
            const reductionDb = computeGainReductionDb(envDb, params);
            targetGain = dbToGain(reductionDb);
        }

        // Smooth gain changes
        if (targetGain < appliedGain) {
            appliedGain = targetGain + (appliedGain - targetGain) * tc.gainAttack;
        } else {
            appliedGain = targetGain + (appliedGain - targetGain) * tc.gainRelease;
        }

        // Apply compression + output gain, then clamp to ceiling
        const totalGain = appliedGain * outputGain;
        let lo = minPeaks[i] * totalGain;
        let hi = maxPeaks[i] * totalGain;
        const rmsIn = rmsPeaks[i];
        let rms = rmsPeaks[i] * totalGain;
        if (hi > ceilingGain) { hi = ceilingGain; }
        if (lo < -ceilingGain) { lo = -ceilingGain; }
        if (rms > ceilingGain) { rms = ceilingGain; }
        minPeaks[i] = lo;
        maxPeaks[i] = hi;
        rmsPeaks[i] = rms;
        if (gains) gains[i] = rmsIn > 0 ? rms / rmsIn : totalGain;
    }
    if (state) {
        state.envelope = detectorEnvelope;
        state.gain = appliedGain;
    }
}
