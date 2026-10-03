// ---------------------------------------------------------------------------
// Zero-crossing finder for click-free loop boundaries
// ---------------------------------------------------------------------------

/**
 * Maximum search window in seconds around the target time.
 * We look ±WINDOW_SECONDS for the nearest zero crossing.
 */
const WINDOW_SECONDS = 0.005; // 5ms

/**
 * Find the nearest zero-crossing point in the buffer around `timeSec`.
 *
 * A zero-crossing is where the waveform crosses through zero amplitude.
 * Snapping loop boundaries to these points avoids audible clicks.
 *
 * Uses channel 0 (mono or left) for analysis.
 * Returns the snapped time in seconds.
 */
export function findZeroCrossing(buffer: AudioBuffer, timeSec: number): number {
    const sampleRate = buffer.sampleRate;
    const data = buffer.getChannelData(0);
    const totalSamples = data.length;

    const centerSample = Math.round(timeSec * sampleRate);
    const windowSamples = Math.round(WINDOW_SECONDS * sampleRate);

    const searchStart = Math.max(1, centerSample - windowSamples);
    const searchEnd = Math.min(totalSamples - 1, centerSample + windowSamples);

    let bestSample = centerSample;
    let bestDistance = Infinity;

    for (let i = searchStart; i <= searchEnd; i++) {
        // Check for sign change between adjacent samples
        const prev = data[i - 1];
        const curr = data[i];

        if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) {
            // Zero crossing found — pick the sample closer to zero
            const distPrev = Math.abs(prev);
            const distCurr = Math.abs(curr);
            const crossingSample = distPrev < distCurr ? i - 1 : i;

            const distFromCenter = Math.abs(crossingSample - centerSample);
            if (distFromCenter < bestDistance) {
                bestDistance = distFromCenter;
                bestSample = crossingSample;
            }
        }
    }

    // Clamp to buffer bounds
    return Math.max(0, Math.min(bestSample / sampleRate, buffer.duration));
}
