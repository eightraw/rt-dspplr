export const HIGH_PASS_SLOPE_DB_PER_OCT = 24;
/** Linear Q of the two Butterworth sections (a BiquadFilterNode takes them in dB). */
export const HIGH_PASS_SECTION_Q = [
    0.541196100146197,
    1.306562964876377,
] as const;

const HIGH_PASS_MIN_HZ = 20;

export interface HighPassCoefficients {
    b0: number;
    b1: number;
    b2: number;
    a1: number;
    a2: number;
}

export function clampHighPassHz(hz: number, sampleRate: number): number {
    return Math.max(HIGH_PASS_MIN_HZ, Math.min(20000, sampleRate * 0.45, hz));
}

export function computeHighPassCoefficients(
    sampleRate: number,
    hz: number,
    q: number,
): HighPassCoefficients {
    const freq = clampHighPassHz(hz, sampleRate);
    const omega = (2 * Math.PI * freq) / sampleRate;
    const cosW = Math.cos(omega);
    const sinW = Math.sin(omega);
    const alpha = sinW / (2 * q);
    const a0Inv = 1 / (1 + alpha);

    return {
        b0: ((1 + cosW) * 0.5) * a0Inv,
        b1: (-(1 + cosW)) * a0Inv,
        b2: ((1 + cosW) * 0.5) * a0Inv,
        a1: (-2 * cosW) * a0Inv,
        a2: (1 - alpha) * a0Inv,
    };
}

export function createFourthOrderHighPassStages(context: BaseAudioContext): [BiquadFilterNode, BiquadFilterNode] {
    const first = context.createBiquadFilter();
    const second = context.createBiquadFilter();

    first.type = 'highpass';
    second.type = 'highpass';
    // A highpass BiquadFilterNode reads Q in dB (alpha = sin w0 / (2 * 10^(Q/20))),
    // unlike the linear q of computeHighPassCoefficients. The linear values here
    // gave a +3.8 dB bump above the cutoff instead of Butterworth's -3 dB at it.
    first.Q.value = 20 * Math.log10(HIGH_PASS_SECTION_Q[0]);
    second.Q.value = 20 * Math.log10(HIGH_PASS_SECTION_Q[1]);

    return [first, second];
}

export function scheduleFourthOrderHighPassFrequency(
    stages: readonly [BiquadFilterNode, BiquadFilterNode],
    hz: number,
    now: number,
    rampSeconds: number,
): void {
    const targetHz = Math.max(HIGH_PASS_MIN_HZ, hz || HIGH_PASS_MIN_HZ);

    for (const stage of stages) {
        stage.frequency.cancelScheduledValues(now);
        stage.frequency.setValueAtTime(stage.frequency.value, now);
        stage.frequency.linearRampToValueAtTime(targetHz, now + rampSeconds);
    }
}
