// ---------------------------------------------------------------------------
// OfflineStretchCore — pitch-preserving time stretch (phase vocoder)
// ---------------------------------------------------------------------------
//
// Offline, whole-buffer processing: STFT with a periodic Hann window, phase
// advance per bin from the measured instantaneous frequency, phase reset on
// spectral-flux transients (keeps onsets crisp), overlap-add with a
// normalised synthesis window. Pure TypeScript, no dependencies, so it can run
// in any worker. Quality is below a dedicated library such as Rubber Band.

export interface StretchOptions {
    sampleRate: number;
    rate: number;
    transientSensitivity?: number;
    nFft?: number;
    hopLength?: number;
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

function synthesisWindow(analysisWindow: Float64Array, hopLength: number): Float64Array {
    const size = analysisWindow.length;
    const normalizer = new Float64Array(size);
    const span = Math.ceil(size / hopLength) + 1;

    for (let offsetIndex = -span; offsetIndex <= span; offsetIndex += 1) {
        const start = offsetIndex * hopLength;
        const visibleStart = Math.max(0, start);
        const visibleEnd = Math.min(size, start + size);
        const windowStart = Math.max(0, -start);
        const width = visibleEnd - visibleStart;

        if (width <= 0) {
            continue;
        }

        for (let sampleIndex = 0; sampleIndex < width; sampleIndex += 1) {
            const value = analysisWindow[windowStart + sampleIndex];
            normalizer[visibleStart + sampleIndex] += value * value;
        }
    }

    const output = new Float64Array(size);
    for (let index = 0; index < size; index += 1) {
        const norm = normalizer[index] < 1e-8 ? 1 : normalizer[index];
        output[index] = analysisWindow[index] / norm;
    }

    return output;
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

    const windowSize = Math.max(5, Math.floor(count / 20));
    const threshold = new Float64Array(count);
    const scale = 1.5 / sensitivity;

    for (let frameIndex = 0; frameIndex < count; frameIndex += 1) {
        const start = Math.max(0, frameIndex - windowSize);
        const end = Math.min(count, frameIndex + windowSize + 1);
        let total = 0;
        for (let index = start; index < end; index += 1) {
            total += flux[index];
        }
        threshold[frameIndex] = ((end - start) > 0 ? total / (end - start) : 0) * scale;
    }

    for (let frameIndex = 1; frameIndex < count - 1; frameIndex += 1) {
        const value = flux[frameIndex];
        if (
            value > threshold[frameIndex]
            && value >= flux[frameIndex - 1]
            && value >= flux[frameIndex + 1]
        ) {
            flags[frameIndex] = 1;
        }
    }

    return flags;
}

function wrapPhase(value: number): number {
    return value - (2 * Math.PI * Math.round(value / (2 * Math.PI)));
}

function phaseVocoder(
    frames: HalfSpectrum[],
    transientFlags: Uint8Array,
    hopLength: number,
    synthesisHop: number,
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
                phaseAccumulator[binIndex] += trueFrequency * synthesisHop;
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
    synthesisHop: number,
    synthesisWin: Float64Array,
    minLength: number,
): Float32Array {
    const totalLength = Math.max(minLength, (frames.length * synthesisHop) + fftSize);
    const output = new Float64Array(totalLength);

    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
        const grain = inverseRealFft(frames[frameIndex], fftSize);
        const start = frameIndex * synthesisHop;

        for (let sampleIndex = 0; sampleIndex < fftSize; sampleIndex += 1) {
            output[start + sampleIndex] += grain[sampleIndex] * synthesisWin[sampleIndex];
        }
    }

    return Float32Array.from(output);
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
    const synthesisHop = Math.max(1, Math.round(hopLength * rate));
    const transientSensitivity = options.transientSensitivity ?? 0.5;
    const analysisWindow = periodicHann(fftSize);
    const synthesisWin = synthesisWindow(analysisWindow, hopLength);

    const padding = fftSize;
    const padded = new Float64Array(channel.length + padding + padding + fftSize);
    for (let index = 0; index < channel.length; index += 1) {
        padded[index + padding] = channel[index];
    }

    const frames = analysisFrames(padded, fftSize, hopLength, analysisWindow);
    const transients = detectTransients(frames, transientSensitivity);
    const stretchedFrames = phaseVocoder(frames, transients, hopLength, synthesisHop, fftSize);

    const expectedLength = Math.ceil(channel.length * rate) + fftSize;
    let output = synthesisOverlapAdd(stretchedFrames, fftSize, synthesisHop, synthesisWin, expectedLength);
    output = output.subarray(padding);

    const targetLength = Math.max(1, Math.round(channel.length * rate));
    const trimmed = output.length > targetLength ? output.subarray(0, targetLength) : output;
    return trimmed.length === targetLength ? trimmed : resampleToLength(trimmed, targetLength);
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
