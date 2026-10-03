// Waveform peak worker. Builds a min/max/RMS peak pyramid of the clip and a
// second "processed" pyramid that previews what the DSP chain does to it
// (high-pass, compressor, output gain, limiter ceiling, A/B mix), so the
// drawn waveform follows the knobs without touching the audio thread.
// Bundled into a self-contained string at library build time.

import {
    buildPeakPyramid,
    type WaveformPeakLevel,
    type WaveformPeakPyramid,
} from './pyramid';
import { LIMITER_CEILING_DB, mixGains } from '../controls';
import {
    dbToGain,
    gainToDb,
    computeCompressorParams,
    computeCompressorTimeConstants,
    computeGainReductionDb,
} from '../dsp/compression';
import {
    HIGH_PASS_SECTION_Q,
    clampHighPassHz,
    computeHighPassCoefficients,
} from '../dsp/highPass';
import type { WaveformProcessing } from './types';

type LoadBufferMessage = {
    type: 'loadBuffer';
    sampleRate: number;
    length: number;
    channels: ArrayBuffer[];
    channelsB?: ArrayBuffer[];
    processing: WaveformProcessing;
    requestId: number;
};

type BuildProcessedMessage = {
    type: 'buildProcessed';
    requestId: number;
    processing: WaveformProcessing;
};

type WorkerMessage = LoadBufferMessage | BuildProcessedMessage;

type BufferReadyResponse = {
    type: 'bufferReady';
    requestId: number;
    sourcePyramid: WaveformPeakPyramid;
    processedPyramid: WaveformPeakPyramid;
};

type ProcessedReadyResponse = {
    type: 'processedReady';
    requestId: number;
    pyramid: WaveformPeakPyramid;
};

type WorkerResponse = BufferReadyResponse | ProcessedReadyResponse;

const BASE_BIN_SIZE = 32;
const workerScope = self as unknown as {
    onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
    postMessage(message: unknown, transfer?: Transferable[]): void;
};

let currentSampleRate = 0;
let currentLength = 0;
let channelData: Float32Array[] = [];
let channelDataB: Float32Array[] = [];

// Cached source peaks — kept after buildSourcePyramid so the processed path
// can reuse them when the high-pass filter is disabled (avoids re-scanning all samples).
let sourceBaseMinPeaks: Float32Array | null = null;
let sourceBaseMaxPeaks: Float32Array | null = null;
let sourceBaseRmsSq: Float32Array | null = null;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Phase 1 helpers — build base-level min/max peaks + RMS
// ---------------------------------------------------------------------------

interface BasePeakArrays {
    minPeaks: Float32Array;
    maxPeaks: Float32Array;
    rmsSq: Float32Array; // sum of squares per bin (divide by count + sqrt later)
}

function createBasePeakArrays(): BasePeakArrays {
    const binCount = Math.max(1, Math.ceil(currentLength / BASE_BIN_SIZE));
    const minPeaks = new Float32Array(binCount);
    const maxPeaks = new Float32Array(binCount);
    const rmsSq = new Float32Array(binCount);
    minPeaks.fill(1);
    maxPeaks.fill(-1);
    return { minPeaks, maxPeaks, rmsSq };
}

function finalizeBasePeakArrays(minPeaks: Float32Array, maxPeaks: Float32Array): void {
    for (let i = 0; i < minPeaks.length; i += 1) {
        if (maxPeaks[i] < minPeaks[i]) {
            minPeaks[i] = 0;
            maxPeaks[i] = 0;
        }
    }
}

/**
 * Convert rmsSq (sum of squares) to RMS values in-place.
 * samplesPerBin is the number of samples that contributed to each bin.
 */
function finalizeRms(rmsSq: Float32Array, channelCount: number): Float32Array {
    const totalSamplesPerBin = BASE_BIN_SIZE * channelCount;
    const rmsPeaks = new Float32Array(rmsSq.length);
    for (let i = 0; i < rmsSq.length; i += 1) {
        rmsPeaks[i] = Math.sqrt(rmsSq[i] / totalSamplesPerBin);
    }
    return rmsPeaks;
}

/**
 * Compute raw (unprocessed) min/max peaks + RMS per bin from the source channel data.
 */
function computeSourceBasePeaks(minPeaks: Float32Array, maxPeaks: Float32Array, rmsSq: Float32Array): void {
    const channels = channelData;
    const channelCount = channels.length;

    if (channelCount === 0 || currentLength <= 0) {
        minPeaks.fill(0);
        maxPeaks.fill(0);
        rmsSq.fill(0);
        return;
    }

    computeBasePeaksFromProvider(minPeaks, maxPeaks, rmsSq, channelCount, (ch, i) => channels[ch][i] ?? 0);
}

function computeMixedSourceBasePeaks(
    minPeaks: Float32Array,
    maxPeaks: Float32Array,
    rmsSq: Float32Array,
    gainA: number,
    gainB: number,
): void {
    const channelCount = Math.max(channelData.length, channelDataB.length);

    if (channelCount === 0 || currentLength <= 0) {
        minPeaks.fill(0);
        maxPeaks.fill(0);
        rmsSq.fill(0);
        return;
    }

    computeBasePeaksFromProvider(minPeaks, maxPeaks, rmsSq, channelCount, (ch, i) => {
        const dry = getChannelSample(channelData, ch, i);
        const wetSample = getChannelSample(channelDataB, ch, i);
        return dry * gainA + wetSample * gainB;
    });
}

function computeBasePeaksFromProvider(
    minPeaks: Float32Array,
    maxPeaks: Float32Array,
    rmsSq: Float32Array,
    channelCount: number,
    sampleProvider: (channelIndex: number, sampleIndex: number) => number,
): void {
    for (let ch = 0; ch < channelCount; ch += 1) {
        for (let i = 0; i < currentLength; i += 1) {
            const s = sampleProvider(ch, i);
            const bin = (i / BASE_BIN_SIZE) | 0;
            if (s < minPeaks[bin]) { minPeaks[bin] = s; }
            if (s > maxPeaks[bin]) { maxPeaks[bin] = s; }
            rmsSq[bin] += s * s;
        }
    }
}

/**
 * Run a biquad high-pass filter per-sample across all channels and accumulate
 * min/max peaks + RMS per bin inline.
 */
function computeHighPassFilteredPeaks(
    minPeaks: Float32Array,
    maxPeaks: Float32Array,
    rmsSq: Float32Array,
    hiPassHz: number,
): void {
    computeHighPassFilteredPeaksFromProvider(
        minPeaks,
        maxPeaks,
        rmsSq,
        hiPassHz,
        channelData.length,
        (ch, i) => channelData[ch][i] ?? 0,
    );
}

function computeMixedHighPassFilteredPeaks(
    minPeaks: Float32Array,
    maxPeaks: Float32Array,
    rmsSq: Float32Array,
    hiPassHz: number,
    gainA: number,
    gainB: number,
): void {
    const channelCount = Math.max(channelData.length, channelDataB.length);

    computeHighPassFilteredPeaksFromProvider(
        minPeaks,
        maxPeaks,
        rmsSq,
        hiPassHz,
        channelCount,
        (ch, i) => {
            const dry = getChannelSample(channelData, ch, i);
            const wetSample = getChannelSample(channelDataB, ch, i);
            return dry * gainA + wetSample * gainB;
        },
    );
}

function computeHighPassFilteredPeaksFromProvider(
    minPeaks: Float32Array,
    maxPeaks: Float32Array,
    rmsSq: Float32Array,
    hiPassHz: number,
    channelCount: number,
    sampleProvider: (channelIndex: number, sampleIndex: number) => number,
): void {
    const sr = currentSampleRate;

    const freq = clampHighPassHz(hiPassHz, sr);
    const stageA = computeHighPassCoefficients(sr, freq, HIGH_PASS_SECTION_Q[0]);
    const stageB = computeHighPassCoefficients(sr, freq, HIGH_PASS_SECTION_Q[1]);

    for (let ch = 0; ch < channelCount; ch += 1) {
        let x1a = 0;
        let x2a = 0;
        let y1a = 0;
        let y2a = 0;
        let x1b = 0;
        let x2b = 0;
        let y1b = 0;
        let y2b = 0;

        for (let i = 0; i < currentLength; i += 1) {
            const x = sampleProvider(ch, i);
            const ya = stageA.b0 * x + stageA.b1 * x1a + stageA.b2 * x2a - stageA.a1 * y1a - stageA.a2 * y2a;
            x2a = x1a;
            x1a = x;
            y2a = y1a;
            y1a = ya;

            const y = stageB.b0 * ya + stageB.b1 * x1b + stageB.b2 * x2b - stageB.a1 * y1b - stageB.a2 * y2b;
            x2b = x1b;
            x1b = ya;
            y2b = y1b;
            y1b = y;

            const bin = (i / BASE_BIN_SIZE) | 0;
            if (y < minPeaks[bin]) { minPeaks[bin] = y; }
            if (y > maxPeaks[bin]) { maxPeaks[bin] = y; }
            rmsSq[bin] += y * y;
        }
    }
}

function getChannelSample(channels: Float32Array[], channelIndex: number, sampleIndex: number): number {
    if (channels.length === 0) return 0;
    const safeIndex = Math.min(channelIndex, channels.length - 1);
    const channel = channels[safeIndex];
    if (!channel || sampleIndex >= channel.length) return 0;
    return channel[sampleIndex] ?? 0;
}

// ---------------------------------------------------------------------------
// Phase 2 — apply dynamics (comp + gain + limiter) at BIN RATE
// ---------------------------------------------------------------------------

function applyDynamicsAtBinRate(
    minPeaks: Float32Array,
    maxPeaks: Float32Array,
    rmsPeaks: Float32Array,
    compAmount: number,
    outputGain: number,
    ceilingGain: number,
): void {
    const binCount = minPeaks.length;

    if (compAmount <= 0 && outputGain === 1) {
        for (let i = 0; i < binCount; i += 1) {
            if (maxPeaks[i] > ceilingGain) { maxPeaks[i] = ceilingGain; }
            if (minPeaks[i] < -ceilingGain) { minPeaks[i] = -ceilingGain; }
            if (rmsPeaks[i] > ceilingGain) { rmsPeaks[i] = ceilingGain; }
        }
        return;
    }

    const binRate = currentSampleRate / BASE_BIN_SIZE;
    const tc = computeCompressorTimeConstants(binRate);
    const params = computeCompressorParams(compAmount);

    let detectorEnvelope = 0;
    let appliedGain = 1;

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
        let rms = rmsPeaks[i] * totalGain;
        if (hi > ceilingGain) { hi = ceilingGain; }
        if (lo < -ceilingGain) { lo = -ceilingGain; }
        if (rms > ceilingGain) { rms = ceilingGain; }
        minPeaks[i] = lo;
        maxPeaks[i] = hi;
        rmsPeaks[i] = rms;
    }
}

// ---------------------------------------------------------------------------
// Public pyramid builders
// ---------------------------------------------------------------------------

function buildSourcePyramid(): WaveformPeakPyramid {
    const { minPeaks, maxPeaks, rmsSq } = createBasePeakArrays();
    computeSourceBasePeaks(minPeaks, maxPeaks, rmsSq);
    finalizeBasePeakArrays(minPeaks, maxPeaks);
    const rmsPeaks = finalizeRms(rmsSq, channelData.length || 1);

    // Cache copies so buildProcessedPyramid can reuse when HP is off.
    sourceBaseMinPeaks = new Float32Array(minPeaks);
    sourceBaseMaxPeaks = new Float32Array(maxPeaks);
    sourceBaseRmsSq = new Float32Array(rmsSq);

    return buildPeakPyramid(minPeaks, maxPeaks, rmsPeaks, BASE_BIN_SIZE, currentLength);
}

function buildProcessedPyramid(processing: WaveformProcessing): WaveformPeakPyramid {
    const { minPeaks, maxPeaks, rmsSq } = createBasePeakArrays();

    if (channelData.length === 0 || currentSampleRate <= 0 || currentLength <= 0) {
        minPeaks.fill(0);
        maxPeaks.fill(0);
        const rmsPeaks = new Float32Array(minPeaks.length);
        return buildPeakPyramid(minPeaks, maxPeaks, rmsPeaks, BASE_BIN_SIZE, currentLength);
    }

    // --- Phase 1: Build base peaks (filtered or source) ---
    const hpEnabled = processing.highPassHz > 0;
    const [gainA, gainB] = mixGains(processing.mix ?? 0, processing.mixLaw);
    const mixesB = channelDataB.length > 0 && (gainA !== 1 || gainB !== 0);

    if (hpEnabled) {
        if (mixesB) {
            computeMixedHighPassFilteredPeaks(minPeaks, maxPeaks, rmsSq, processing.highPassHz, gainA, gainB);
        } else {
            computeHighPassFilteredPeaks(minPeaks, maxPeaks, rmsSq, processing.highPassHz);
        }
    } else if (sourceBaseMinPeaks && sourceBaseMaxPeaks && sourceBaseRmsSq) {
        if (mixesB) {
            computeMixedSourceBasePeaks(minPeaks, maxPeaks, rmsSq, gainA, gainB);
        } else {
            minPeaks.set(sourceBaseMinPeaks);
            maxPeaks.set(sourceBaseMaxPeaks);
            rmsSq.set(sourceBaseRmsSq);
        }
    } else {
        if (mixesB) {
            computeMixedSourceBasePeaks(minPeaks, maxPeaks, rmsSq, gainA, gainB);
        } else {
            computeSourceBasePeaks(minPeaks, maxPeaks, rmsSq);
        }
    }

    finalizeBasePeakArrays(minPeaks, maxPeaks);
    const rmsPeaks = finalizeRms(rmsSq, channelData.length || 1);

    // --- Phase 2: Apply dynamics at bin rate ---
    const compAmount = clamp(processing.compression, 0, 1);
    const outGain = Math.max(0, processing.outputGain);
    const ceilingGain = dbToGain(LIMITER_CEILING_DB);

    applyDynamicsAtBinRate(minPeaks, maxPeaks, rmsPeaks, compAmount, outGain, ceilingGain);
    finalizeBasePeakArrays(minPeaks, maxPeaks);

    return buildPeakPyramid(minPeaks, maxPeaks, rmsPeaks, BASE_BIN_SIZE, currentLength);
}

// ---------------------------------------------------------------------------
// Transfer helpers + message handler
// ---------------------------------------------------------------------------

function collectTransfers(levels: WaveformPeakLevel[]): Transferable[] {
    const transfers: Transferable[] = [];
    for (const level of levels) {
        transfers.push(level.minPeaks.buffer, level.maxPeaks.buffer, level.rmsPeaks.buffer);
    }
    return transfers;
}

workerScope.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if (!message) {
        return;
    }

    if (message.type === 'loadBuffer') {
        currentSampleRate = message.sampleRate;
        currentLength = message.length;
        channelData = message.channels.map((buffer) => new Float32Array(buffer));
        channelDataB = (message.channelsB ?? []).map((buffer) => new Float32Array(buffer));

        const sourcePyramid = buildSourcePyramid();
        const processedPyramid = buildProcessedPyramid(message.processing);
        const response: BufferReadyResponse = {
            type: 'bufferReady',
            requestId: message.requestId,
            sourcePyramid,
            processedPyramid,
        };
        const transfers = [
            ...collectTransfers(sourcePyramid.levels),
            ...collectTransfers(processedPyramid.levels),
        ];
        workerScope.postMessage(response as WorkerResponse, transfers);
        return;
    }

    if (message.type === 'buildProcessed') {
        const pyramid = buildProcessedPyramid(message.processing);
        const response: ProcessedReadyResponse = {
            type: 'processedReady',
            requestId: message.requestId,
            pyramid,
        };
        workerScope.postMessage(response as WorkerResponse, collectTransfers(pyramid.levels));
    }
};

export {};
