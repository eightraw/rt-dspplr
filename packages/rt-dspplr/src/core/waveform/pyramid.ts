export interface WaveformPeakLevel {
    binSize: number;
    /**
     * A partial level (a prepared clip's live detail of the segments on
     * screen) starts at this bin; its arrays then cover bins
     * [startBin, startBin + length); it may be fractional (bins aligned to
     * the window's first frame). Absent: the level covers the clip.
     */
    startBin?: number;
    minPeaks: Float32Array;
    maxPeaks: Float32Array;
    rmsPeaks: Float32Array;
}

export interface WaveformPeakPyramid {
    totalSamples: number;
    levels: WaveformPeakLevel[];
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function buildPeakPyramid(
    baseMinPeaks: Float32Array,
    baseMaxPeaks: Float32Array,
    baseRmsPeaks: Float32Array,
    baseBinSize: number,
    totalSamples: number,
): WaveformPeakPyramid {
    if (baseMinPeaks.length !== baseMaxPeaks.length || baseMinPeaks.length !== baseRmsPeaks.length) {
        throw new Error('Waveform pyramid base arrays must have equal length');
    }

    const safeTotalSamples = Math.max(0, Math.floor(totalSamples));
    const safeBaseBinSize = Math.max(1, Math.floor(baseBinSize));
    const levels: WaveformPeakLevel[] = [{
        binSize: safeBaseBinSize,
        minPeaks: baseMinPeaks,
        maxPeaks: baseMaxPeaks,
        rmsPeaks: baseRmsPeaks,
    }];

    let currentMin = baseMinPeaks;
    let currentMax = baseMaxPeaks;
    let currentRms = baseRmsPeaks;
    let currentBinSize = safeBaseBinSize;

    while (currentMin.length > 1) {
        const nextLength = Math.ceil(currentMin.length / 2);
        const nextMin = new Float32Array(nextLength);
        const nextMax = new Float32Array(nextLength);
        const nextRms = new Float32Array(nextLength);

        for (let index = 0; index < nextLength; index += 1) {
            const leftIndex = index * 2;
            const rightIndex = leftIndex + 1;
            let minPeak = currentMin[leftIndex] ?? 0;
            let maxPeak = currentMax[leftIndex] ?? 0;
            let rmsSquaredSum = (currentRms[leftIndex] ?? 0) ** 2;
            let rmsCount = 1;

            if (rightIndex < currentMin.length) {
                minPeak = Math.min(minPeak, currentMin[rightIndex] ?? 0);
                maxPeak = Math.max(maxPeak, currentMax[rightIndex] ?? 0);
                rmsSquaredSum += (currentRms[rightIndex] ?? 0) ** 2;
                rmsCount = 2;
            }

            nextMin[index] = minPeak;
            nextMax[index] = maxPeak;
            nextRms[index] = Math.sqrt(rmsSquaredSum / rmsCount);
        }

        currentBinSize *= 2;
        currentMin = nextMin;
        currentMax = nextMax;
        currentRms = nextRms;
        levels.push({
            binSize: currentBinSize,
            minPeaks: currentMin,
            maxPeaks: currentMax,
            rmsPeaks: currentRms,
        });
    }

    return {
        totalSamples: safeTotalSamples,
        levels,
    };
}

/** The coarsest level that still gives at least `targetBins` bins across the range (any pyramid of doubling bins). */
export function pickPeakPyramidLevel<Level extends { binSize: number } = WaveformPeakLevel>(
    pyramid: { totalSamples: number; levels: Level[] } | null,
    startSample: number,
    endSample: number,
    targetBins: number,
): Level | null {
    if (!pyramid || pyramid.levels.length === 0) {
        return null;
    }

    const safeStart = clamp(Math.floor(startSample), 0, pyramid.totalSamples);
    const safeEnd = clamp(Math.ceil(endSample), safeStart + 1, pyramid.totalSamples || 1);
    const visibleSamples = Math.max(1, safeEnd - safeStart);
    const desiredBins = Math.max(1, targetBins);

    // Partial levels (startBin set) are used only when they cover the range.
    const covers = (level: Level) => {
        const first = (level as { startBin?: number }).startBin;
        if (first === undefined) return true;
        const length = (level as { maxPeaks?: ArrayLike<number> }).maxPeaks?.length ?? 0;
        return first * level.binSize <= safeStart && (first + length) * level.binSize >= safeEnd;
    };
    const usable = pyramid.levels.filter(covers);
    if (usable.length === 0) return null;
    let selectedLevel = usable[0];
    for (const level of usable) {
        selectedLevel = level;
        const visibleBins = visibleSamples / Math.max(1, level.binSize);
        if (visibleBins <= desiredBins) {
            break;
        }
    }

    return selectedLevel;
}

