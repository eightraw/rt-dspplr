// Offline Rubber Band processing on an initialised RubberBandInterface.
// Pure function of its inputs, so it runs in the worker and in Node tests.

import { RubberBandOption, type RubberBandInterface } from 'rubberband-wasm';

export function createRubberBandOptions(): RubberBandOption {
    // Offline, precise settings: soft transient detector and laminar phase
    // (fewer phasing artefacts), short window (better time resolution),
    // formant preservation, and the newer "finer" R3 engine.
    return (
        RubberBandOption.RubberBandOptionProcessOffline
        | RubberBandOption.RubberBandOptionStretchPrecise
        | RubberBandOption.RubberBandOptionTransientsMixed
        | RubberBandOption.RubberBandOptionDetectorSoft
        | RubberBandOption.RubberBandOptionPhaseLaminar
        | RubberBandOption.RubberBandOptionWindowShort
        | RubberBandOption.RubberBandOptionSmoothingOn
        | RubberBandOption.RubberBandOptionFormantPreserved
        | RubberBandOption.RubberBandOptionPitchHighConsistency
        | RubberBandOption.RubberBandOptionChannelsTogether
        | RubberBandOption.RubberBandOptionEngineFiner
    );
}

function ensureChannelCapacity(
    buffers: Float32Array[],
    channelIndex: number,
    requiredLength: number,
): Float32Array[] {
    if (requiredLength <= buffers[channelIndex].length) {
        return buffers;
    }

    const nextLength = Math.max(requiredLength, Math.ceil(buffers[channelIndex].length * 1.5));
    return buffers.map((buffer) => {
        const expanded = new Float32Array(nextLength);
        expanded.set(buffer);
        return expanded;
    });
}

/**
 * Two-pass offline processing: study() the whole input first (lets the
 * stretcher plan the time map), then process() in blocks and retrieve() what
 * is available. The output arrays are over-allocated by 8192 frames; the
 * returned views cover exactly the `write` frames produced.
 */
export function processWithRubberBand(
    api: RubberBandInterface,
    sourceChannels: Float32Array[],
    sampleRate: number,
    speed: number,
): Float32Array[] {
    const timeRatio = 1 / speed;
    const outputEstimate = Math.max(1, Math.ceil(sourceChannels[0].length * timeRatio) + 8192);
    let outputChannels = sourceChannels.map(() => new Float32Array(outputEstimate));

    const options = createRubberBandOptions();
    const state = api.rubberband_new(sampleRate, sourceChannels.length, options, timeRatio, 1);
    api.rubberband_set_pitch_scale(state, 1);
    api.rubberband_set_time_ratio(state, timeRatio);
    api.rubberband_set_expected_input_duration(state, sourceChannels[0].length);

    let samplesRequired = api.rubberband_get_samples_required(state);
    if (!Number.isFinite(samplesRequired) || samplesRequired <= 0) {
        samplesRequired = Math.min(8192, Math.max(1024, Math.ceil(sampleRate * 0.05)));
    }

    const channelArrayPtr = api.malloc(sourceChannels.length * 4);
    const channelDataPtr: number[] = [];

    try {
        for (let channelIndex = 0; channelIndex < sourceChannels.length; channelIndex += 1) {
            const bufferPtr = api.malloc(samplesRequired * 4);
            channelDataPtr.push(bufferPtr);
            api.memWritePtr(channelArrayPtr + (channelIndex * 4), bufferPtr);
        }

        let read = 0;
        while (read < sourceChannels[0].length) {
            const remaining = Math.min(samplesRequired, sourceChannels[0].length - read);
            sourceChannels.forEach((channel, channelIndex) => {
                api.memWrite(channelDataPtr[channelIndex], channel.subarray(read, read + remaining));
            });
            read += remaining;
            const hasMore = read < sourceChannels[0].length;
            api.rubberband_study(state, channelArrayPtr, remaining, hasMore ? 0 : 1);
        }

        read = 0;
        let write = 0;

        const retrieveAvailable = (finalPass: boolean): void => {
            for (;;) {
                const available = api.rubberband_available(state);
                if (available < 1) {
                    break;
                }
                if (!finalPass && available < samplesRequired) {
                    break;
                }

                const receiveCount = api.rubberband_retrieve(state, channelArrayPtr, Math.min(samplesRequired, available));
                if (receiveCount <= 0) {
                    break;
                }

                outputChannels = ensureChannelCapacity(outputChannels, 0, write + receiveCount);
                sourceChannels.forEach((_, channelIndex) => {
                    outputChannels = ensureChannelCapacity(outputChannels, channelIndex, write + receiveCount);
                    outputChannels[channelIndex].set(api.memReadF32(channelDataPtr[channelIndex], receiveCount), write);
                });
                write += receiveCount;
            }
        };

        while (read < sourceChannels[0].length) {
            const remaining = Math.min(samplesRequired, sourceChannels[0].length - read);
            sourceChannels.forEach((channel, channelIndex) => {
                api.memWrite(channelDataPtr[channelIndex], channel.subarray(read, read + remaining));
            });
            read += remaining;
            const hasMore = read < sourceChannels[0].length;
            api.rubberband_process(state, channelArrayPtr, remaining, hasMore ? 0 : 1);
            retrieveAvailable(false);
        }

        retrieveAvailable(true);
        return outputChannels.map((channel) => channel.subarray(0, write));
    } finally {
        channelDataPtr.forEach((ptr) => api.free(ptr));
        api.free(channelArrayPtr);
        api.rubberband_delete(state);
    }
}
