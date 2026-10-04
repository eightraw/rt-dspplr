// ---------------------------------------------------------------------------
// OfflineStretchCore — pitch-preserving time stretch (phase vocoder)
// ---------------------------------------------------------------------------
//
// Offline, whole-buffer processing: STFT with a periodic Hann window, phase
// advance per bin from the measured instantaneous frequency, phase reset on
// spectral-flux transients (keeps onsets crisp), overlap-add normalised by the
// window power actually laid down. Pure TypeScript, no dependencies, so it can
// run in any worker. Quality is below a dedicated library such as Rubber Band.

/**
 * How the vocoder holds the clip while it works.
 * - 'fast': every analysis frame in memory at once, about 20x the channel's
 *   PCM while it runs. Quickest.
 * - 'lean': two passes over the clip, nothing kept but the input, the output
 *   and a few FFT-sized buffers. Same samples, bit for bit, somewhat slower.
 * - 'auto' (default): 'lean' for channels longer than LEAN_AFTER_SECONDS.
 *
 * Measured in Node 20, mono 48 kHz at 1.5x: 30 s takes 0.9 s and +147 MB fast,
 * 1.0 s and +5 MB lean; 10 min takes 19 s and +2.3 GB fast, 20 s and +78 MB lean
 * (the lean figure is the output itself).
 */
export type VocoderMemory = 'auto' | 'fast' | 'lean';

/** Channels longer than this are stretched the lean way under 'auto'. */
export const LEAN_AFTER_SECONDS = 15;

export interface StretchOptions {
    sampleRate: number;
    rate: number;
    transientSensitivity?: number;
    nFft?: number;
    hopLength?: number;
    memory?: VocoderMemory;
}

interface HalfSpectrum {
    re: Float64Array;
    im: Float64Array;
}

function isPowerOfTwo(value: number): boolean {
    return value > 0 && (value & (value - 1)) === 0;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function largestPowerOfTwoAtMost(value: number): number {
    let result = 1;
    while ((result << 1) <= value) {
        result <<= 1;
    }
    return result;
}

export function defaultStretchFftSize(sampleRate: number): number {
    const target = clamp(Math.round(sampleRate * 0.046), 32, 65536);
    return largestPowerOfTwoAtMost(target);
}

function periodicHann(size: number): Float64Array {
    const window = new Float64Array(size);
    for (let index = 0; index < size; index += 1) {
        window[index] = 0.5 - (0.5 * Math.cos((2 * Math.PI * index) / size));
    }
    return window;
}

/**
 * Where the stretched audio begins in the overlap-added output. Frame k is
 * analysed at k·hop of the padded input and placed at k·synthesisHop, so the
 * source sample t (padded position fftSize + t) lands at
 * t·rate + (fftSize/2)·(1 + rate): the frame centres move with the hop ratio,
 * the half-frame offset does not. Trimming a plain fftSize instead left the
 * output early or late by (fftSize/2)·(1 − rate), about 20 ms at 2x.
 */
function outputOffset(fftSize: number, rate: number): number {
    return Math.round((fftSize / 2) * (1 + rate));
}

/**
 * The overlap-add is divided by the sum of the squared synthesis window laid
 * down at each output sample, which depends on the synthesis hop. A window
 * pre-normalised for the analysis hop scaled the output by hop/synthesisHop,
 * that is by the speed: +6 dB at 2x, −6 dB at 0.5x.
 */
function normalise(windowSum: number): number {
    return windowSum < 1e-8 ? 1 : windowSum;
}

/**
 * Output position of frame k: its analysis position scaled by the rate, rounded
 * per frame. A single rounded synthesis hop (hop·rate to the nearest sample)
 * would make the clip play up to 0.1% slow or fast and drift away from the
 * position the player computes: 0.6 s over ten minutes at 1.25x.
 */
function synthesisStart(frameIndex: number, hopLength: number, rate: number): number {
    return Math.round(frameIndex * hopLength * rate);
}

function fftInPlace(real: Float64Array, imag: Float64Array, inverse: boolean): void {
    const size = real.length;
    let reversed = 0;

    for (let index = 1; index < size; index += 1) {
        let bit = size >> 1;
        while (reversed & bit) {
            reversed ^= bit;
            bit >>= 1;
        }
        reversed ^= bit;

        if (index < reversed) {
            const realValue = real[index];
            real[index] = real[reversed];
            real[reversed] = realValue;

            const imagValue = imag[index];
            imag[index] = imag[reversed];
            imag[reversed] = imagValue;
        }
    }

    for (let length = 2; length <= size; length <<= 1) {
        const angle = ((inverse ? 2 : -2) * Math.PI) / length;
        const wLengthReal = Math.cos(angle);
        const wLengthImag = Math.sin(angle);
        const half = length >> 1;

        for (let offset = 0; offset < size; offset += length) {
            let wReal = 1;
            let wImag = 0;

            for (let step = 0; step < half; step += 1) {
                const evenIndex = offset + step;
                const oddIndex = evenIndex + half;

                const oddReal = (real[oddIndex] * wReal) - (imag[oddIndex] * wImag);
                const oddImag = (real[oddIndex] * wImag) + (imag[oddIndex] * wReal);
                const evenReal = real[evenIndex];
                const evenImag = imag[evenIndex];

                real[evenIndex] = evenReal + oddReal;
                imag[evenIndex] = evenImag + oddImag;
                real[oddIndex] = evenReal - oddReal;
                imag[oddIndex] = evenImag - oddImag;

                const nextReal = (wReal * wLengthReal) - (wImag * wLengthImag);
                wImag = (wReal * wLengthImag) + (wImag * wLengthReal);
                wReal = nextReal;
            }
        }
    }

    if (inverse) {
        for (let index = 0; index < size; index += 1) {
            real[index] /= size;
            imag[index] /= size;
        }
    }
}

function realFft(frame: Float64Array): HalfSpectrum {
    const size = frame.length;
    const real = new Float64Array(frame);
    const imag = new Float64Array(size);
    fftInPlace(real, imag, false);

    const bins = (size >> 1) + 1;
    return {
        re: real.slice(0, bins),
        im: imag.slice(0, bins),
    };
}

function inverseRealFft(spectrum: HalfSpectrum, fftSize: number): Float64Array {
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);
    const bins = spectrum.re.length;

    for (let index = 0; index < bins; index += 1) {
        real[index] = spectrum.re[index];
        imag[index] = spectrum.im[index];
    }

    for (let index = 1; index < bins - 1; index += 1) {
        const mirrorIndex = fftSize - index;
        real[mirrorIndex] = spectrum.re[index];
        imag[mirrorIndex] = -spectrum.im[index];
    }

    fftInPlace(real, imag, true);
    return real;
}

function analysisFrames(
    input: Float64Array,
    fftSize: number,
    hopLength: number,
    analysisWindow: Float64Array,
): HalfSpectrum[] {
    const frames: HalfSpectrum[] = [];
    for (let position = 0; position + fftSize <= input.length; position += hopLength) {
        const frame = new Float64Array(fftSize);
        for (let sampleIndex = 0; sampleIndex < fftSize; sampleIndex += 1) {
            frame[sampleIndex] = input[position + sampleIndex] * analysisWindow[sampleIndex];
        }
        frames.push(realFft(frame));
    }
    return frames;
}

function detectTransients(frames: HalfSpectrum[], sensitivity: number): Uint8Array {
    const count = frames.length;
    const flags = new Uint8Array(count);
    if (count < 2 || sensitivity <= 0) {
        return flags;
    }

    const power = new Array<Float64Array>(count);
    for (let frameIndex = 0; frameIndex < count; frameIndex += 1) {
        const frame = frames[frameIndex];
        const bins = frame.re.length;
        const values = new Float64Array(bins);
        for (let binIndex = 0; binIndex < bins; binIndex += 1) {
            const re = frame.re[binIndex];
            const im = frame.im[binIndex];
            values[binIndex] = (re * re) + (im * im);
        }
        power[frameIndex] = values;
    }

    const flux = new Float64Array(count);
    for (let frameIndex = 1; frameIndex < count; frameIndex += 1) {
        const current = power[frameIndex];
        const previous = power[frameIndex - 1];
        let total = 0;
        for (let binIndex = 0; binIndex < current.length; binIndex += 1) {
            const delta = current[binIndex] - previous[binIndex];
            if (delta > 0) {
                total += delta;
            }
        }
        flux[frameIndex] = total;
    }

    flagTransientPeaks(flux, sensitivity, flags);
    return flags;
}

/**
 * Flag the frames whose spectral flux is a local peak above the mean flux of
 * their surroundings (5% of the clip each side). The window means come from one
 * running total, so the pass is linear in the frame count.
 */
function flagTransientPeaks(flux: Float64Array, sensitivity: number, flags: Uint8Array): void {
    const count = flux.length;
    const windowSize = Math.max(5, Math.floor(count / 20));
    const scale = 1.5 / sensitivity;
    const running = new Float64Array(count + 1);
    for (let index = 0; index < count; index += 1) {
        running[index + 1] = running[index] + flux[index];
    }

    for (let frameIndex = 1; frameIndex < count - 1; frameIndex += 1) {
        const start = Math.max(0, frameIndex - windowSize);
        const end = Math.min(count, frameIndex + windowSize + 1);
        const threshold = ((running[end] - running[start]) / (end - start)) * scale;
        const value = flux[frameIndex];
        if (
            value > threshold
            && value >= flux[frameIndex - 1]
            && value >= flux[frameIndex + 1]
        ) {
            flags[frameIndex] = 1;
        }
    }
}

function wrapPhase(value: number): number {
    return value - (2 * Math.PI * Math.round(value / (2 * Math.PI)));
}

function phaseVocoder(
    frames: HalfSpectrum[],
    transientFlags: Uint8Array,
    hopLength: number,
    rate: number,
    fftSize: number,
): HalfSpectrum[] {
    if (frames.length === 0) {
        return [];
    }

    const bins = frames[0].re.length;
    const omega = new Float64Array(bins);
    for (let binIndex = 0; binIndex < bins; binIndex += 1) {
        omega[binIndex] = (2 * Math.PI * binIndex) / fftSize;
    }

    const previousPhase = new Float64Array(bins);
    const phaseAccumulator = new Float64Array(bins);
    for (let binIndex = 0; binIndex < bins; binIndex += 1) {
        const phase = Math.atan2(frames[0].im[binIndex], frames[0].re[binIndex]);
        previousPhase[binIndex] = phase;
        phaseAccumulator[binIndex] = phase;
    }

    const output: HalfSpectrum[] = new Array(frames.length);

    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
        const frame = frames[frameIndex];
        const re = new Float64Array(bins);
        const im = new Float64Array(bins);
        const advance = frameIndex > 0
            ? synthesisStart(frameIndex, hopLength, rate) - synthesisStart(frameIndex - 1, hopLength, rate)
            : 0;

        for (let binIndex = 0; binIndex < bins; binIndex += 1) {
            const real = frame.re[binIndex];
            const imaginary = frame.im[binIndex];
            const magnitude = Math.hypot(real, imaginary);
            const phase = Math.atan2(imaginary, real);

            if (transientFlags[frameIndex]) {
                phaseAccumulator[binIndex] = phase;
            } else if (frameIndex > 0) {
                const delta = wrapPhase(phase - previousPhase[binIndex] - (omega[binIndex] * hopLength));
                const trueFrequency = omega[binIndex] + (delta / hopLength);
                phaseAccumulator[binIndex] += trueFrequency * advance;
            }

            re[binIndex] = magnitude * Math.cos(phaseAccumulator[binIndex]);
            im[binIndex] = magnitude * Math.sin(phaseAccumulator[binIndex]);
            previousPhase[binIndex] = phase;
        }

        output[frameIndex] = { re, im };
    }

    return output;
}

function synthesisOverlapAdd(
    frames: HalfSpectrum[],
    fftSize: number,
    hopLength: number,
    rate: number,
    window: Float64Array,
    minLength: number,
): Float32Array {
    const totalLength = Math.max(minLength, synthesisStart(frames.length, hopLength, rate) + fftSize);
    const output = new Float64Array(totalLength);
    const windowSum = new Float64Array(totalLength);

    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
        const grain = inverseRealFft(frames[frameIndex], fftSize);
        const start = synthesisStart(frameIndex, hopLength, rate);

        for (let sampleIndex = 0; sampleIndex < fftSize; sampleIndex += 1) {
            const weight = window[sampleIndex];
            output[start + sampleIndex] += grain[sampleIndex] * weight;
            windowSum[start + sampleIndex] += weight * weight;
        }
    }

    const result = new Float32Array(totalLength);
    for (let index = 0; index < totalLength; index += 1) {
        result[index] = output[index] / normalise(windowSum[index]);
    }
    return result;
}

function resampleToLength(input: Float32Array, targetLength: number): Float32Array {
    if (targetLength <= 0) {
        return new Float32Array(0);
    }

    if (input.length === targetLength) {
        return input;
    }

    if (input.length <= 1) {
        return new Float32Array(targetLength).fill(input[0] ?? 0);
    }

    if (targetLength === 1) {
        return new Float32Array([input[0]]);
    }

    const output = new Float32Array(targetLength);
    const scale = (input.length - 1) / (targetLength - 1);

    for (let index = 0; index < targetLength; index += 1) {
        const position = index * scale;
        const leftIndex = Math.floor(position);
        const rightIndex = Math.min(input.length - 1, leftIndex + 1);
        const fraction = position - leftIndex;
        output[index] = (
            (input[leftIndex] * (1 - fraction))
            + (input[rightIndex] * fraction)
        );
    }

    return output;
}

export function stretchChannel(channel: Float32Array, options: StretchOptions): Float32Array {
    const rate = options.rate;
    if (!(rate > 0)) {
        throw new Error(`stretch rate must be positive, got ${rate}`);
    }

    if (channel.length === 0 || Math.abs(rate - 1) < 1e-6) {
        return new Float32Array(channel);
    }

    const fftSize = options.nFft ?? defaultStretchFftSize(options.sampleRate);
    if (!isPowerOfTwo(fftSize)) {
        throw new Error(`nFft must be a power of two, got ${fftSize}`);
    }

    const hopLength = options.hopLength ?? (fftSize >> 2);
    const transientSensitivity = options.transientSensitivity ?? 0.5;
    const analysisWindow = periodicHann(fftSize);
    const targetLength = Math.max(1, Math.round(channel.length * rate));
    const offset = outputOffset(fftSize, rate);

    const memory = options.memory ?? 'auto';
    if (memory === 'lean' || (memory === 'auto' && channel.length > LEAN_AFTER_SECONDS * options.sampleRate)) {
        return stretchChannelLean(channel, rate, fftSize, hopLength, transientSensitivity, analysisWindow, targetLength, offset);
    }

    const padding = fftSize;
    const padded = new Float64Array(channel.length + padding + padding + fftSize);
    for (let index = 0; index < channel.length; index += 1) {
        padded[index + padding] = channel[index];
    }

    const frames = analysisFrames(padded, fftSize, hopLength, analysisWindow);
    const transients = detectTransients(frames, transientSensitivity);
    const stretchedFrames = phaseVocoder(frames, transients, hopLength, rate, fftSize);

    let output = synthesisOverlapAdd(stretchedFrames, fftSize, hopLength, rate, analysisWindow, targetLength + offset);
    output = output.subarray(offset);

    const trimmed = output.length > targetLength ? output.subarray(0, targetLength) : output;
    return trimmed.length === targetLength ? trimmed : resampleToLength(trimmed, targetLength);
}

/**
 * The same stretch as the whole-buffer path, frame by frame. Pass one keeps only
 * the spectral flux of each frame, for the transient flags; pass two takes each
 * frame's spectrum again, advances its phases and overlap-adds the grain into a
 * ring one FFT long (with the window power beside it), which is emptied into the
 * output as samples complete. The arithmetic and its order are the whole-buffer
 * path's, so are the samples.
 */
function stretchChannelLean(
    channel: Float32Array,
    rate: number,
    fftSize: number,
    hopLength: number,
    transientSensitivity: number,
    analysisWindow: Float64Array,
    targetLength: number,
    offset: number,
): Float32Array {
    const padding = fftSize;
    const paddedLength = channel.length + padding + padding + fftSize;
    const count = paddedLength >= fftSize ? Math.floor((paddedLength - fftSize) / hopLength) + 1 : 0;
    const bins = (fftSize >> 1) + 1;
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);

    // The windowed frame at `position` of the zero-padded input, transformed in place.
    const spectrumAt = (position: number) => {
        for (let sampleIndex = 0; sampleIndex < fftSize; sampleIndex += 1) {
            const source = position + sampleIndex - padding;
            const sample = source >= 0 && source < channel.length ? channel[source] : 0;
            real[sampleIndex] = sample * analysisWindow[sampleIndex];
        }
        imag.fill(0);
        fftInPlace(real, imag, false);
    };

    // Pass one: transients, from the flux between neighbouring frames.
    const flags = new Uint8Array(count);
    if (count >= 2 && transientSensitivity > 0) {
        const flux = new Float64Array(count);
        let previous = new Float64Array(bins);
        let current = new Float64Array(bins);
        for (let frameIndex = 0; frameIndex < count; frameIndex += 1) {
            spectrumAt(frameIndex * hopLength);
            for (let binIndex = 0; binIndex < bins; binIndex += 1) {
                current[binIndex] = (real[binIndex] * real[binIndex]) + (imag[binIndex] * imag[binIndex]);
            }
            if (frameIndex > 0) {
                let total = 0;
                for (let binIndex = 0; binIndex < bins; binIndex += 1) {
                    const delta = current[binIndex] - previous[binIndex];
                    if (delta > 0) {
                        total += delta;
                    }
                }
                flux[frameIndex] = total;
            }
            const swap = previous;
            previous = current;
            current = swap;
        }

        flagTransientPeaks(flux, transientSensitivity, flags);
    }

    // Pass two: phase vocoder and overlap-add.
    const totalLength = Math.max(targetLength + offset, synthesisStart(count, hopLength, rate) + fftSize);
    const keptLength = Math.min(totalLength - offset, targetLength);
    const output = new Float32Array(keptLength);
    const ring = new Float64Array(fftSize);
    const windowSum = new Float64Array(fftSize);
    let flushed = 0;
    const flushTo = (end: number) => {
        for (; flushed < end; flushed += 1) {
            const slot = flushed % fftSize;
            const kept = flushed - offset;
            if (kept >= 0 && kept < keptLength) output[kept] = ring[slot] / normalise(windowSum[slot]);
            ring[slot] = 0;
            windowSum[slot] = 0;
        }
    };

    const omega = new Float64Array(bins);
    for (let binIndex = 0; binIndex < bins; binIndex += 1) {
        omega[binIndex] = (2 * Math.PI * binIndex) / fftSize;
    }
    const previousPhase = new Float64Array(bins);
    const phaseAccumulator = new Float64Array(bins);
    const outRe = new Float64Array(bins);
    const outIm = new Float64Array(bins);
    let previousStart = 0;

    for (let frameIndex = 0; frameIndex < count; frameIndex += 1) {
        const start = synthesisStart(frameIndex, hopLength, rate);
        const advance = start - previousStart;
        previousStart = start;
        spectrumAt(frameIndex * hopLength);
        for (let binIndex = 0; binIndex < bins; binIndex += 1) {
            const realPart = real[binIndex];
            const imaginary = imag[binIndex];
            const magnitude = Math.hypot(realPart, imaginary);
            const phase = Math.atan2(imaginary, realPart);

            if (frameIndex === 0 || flags[frameIndex]) {
                phaseAccumulator[binIndex] = phase;
            } else {
                const delta = wrapPhase(phase - previousPhase[binIndex] - (omega[binIndex] * hopLength));
                const trueFrequency = omega[binIndex] + (delta / hopLength);
                phaseAccumulator[binIndex] += trueFrequency * advance;
            }

            outRe[binIndex] = magnitude * Math.cos(phaseAccumulator[binIndex]);
            outIm[binIndex] = magnitude * Math.sin(phaseAccumulator[binIndex]);
            previousPhase[binIndex] = phase;
        }

        // Inverse transform of the half spectrum, mirrored, into the same scratch arrays.
        real.fill(0);
        imag.fill(0);
        for (let index = 0; index < bins; index += 1) {
            real[index] = outRe[index];
            imag[index] = outIm[index];
        }
        for (let index = 1; index < bins - 1; index += 1) {
            const mirrorIndex = fftSize - index;
            real[mirrorIndex] = outRe[index];
            imag[mirrorIndex] = -outIm[index];
        }
        fftInPlace(real, imag, true);

        flushTo(start);
        for (let sampleIndex = 0; sampleIndex < fftSize; sampleIndex += 1) {
            const weight = analysisWindow[sampleIndex];
            const slot = (start + sampleIndex) % fftSize;
            ring[slot] += real[sampleIndex] * weight;
            windowSum[slot] += weight * weight;
        }
    }
    flushTo(totalLength);

    return keptLength === targetLength ? output : resampleToLength(output, targetLength);
}

export function stretchMultichannel(
    channels: Float32Array[],
    options: StretchOptions,
): Float32Array[] {
    if (channels.length === 0) {
        return [];
    }

    return channels.map((channel) => stretchChannel(channel, options));
}
