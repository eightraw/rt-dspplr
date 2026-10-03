/// <reference path="./audioworklet-env.d.ts" />

import {
    dbToGain,
    gainToDb,
    computeCompressorParams,
    computeCompressorTimeConstants,
    computeGainReductionDb,
    type CompressorParams,
    type CompressorTimeConstants,
} from './compression';

const MIN_GAIN = 1e-6;

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function readParamValue(values: Float32Array | undefined, index: number, fallback: number): number {
    if (!values || values.length === 0) return fallback;
    if (values.length === 1) return values[0];
    return values[index] ?? fallback;
}

class DynamicsProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors(): AudioParamDescriptor[] {
        return [
            {
                name: 'compAmount',
                defaultValue: 0,
                minValue: 0,
                maxValue: 1,
                automationRate: 'k-rate',
            },
            {
                name: 'outputGain',
                defaultValue: 1,
                minValue: 0,
                automationRate: 'k-rate',
            },
            {
                name: 'ceilingGain',
                defaultValue: 1,
                minValue: MIN_GAIN,
                automationRate: 'k-rate',
            },
        ];
    }

    private compAmount = 0;
    private params: CompressorParams = computeCompressorParams(0);
    private readonly tc: CompressorTimeConstants = computeCompressorTimeConstants(sampleRate);

    private detectorEnvelope = 0;
    private appliedGain = 1;

    process(
        inputs: Float32Array[][],
        outputs: Float32Array[][],
        parameters: Record<string, Float32Array>,
    ): boolean {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || !output || input.length === 0) {
            return true;
        }

        const compAmountValues = parameters.compAmount;
        const outputGainValues = parameters.outputGain;
        const ceilingGainValues = parameters.ceilingGain;

        const initialCompAmount = clamp01(readParamValue(compAmountValues, 0, this.compAmount));
        if (Math.abs(initialCompAmount - this.compAmount) > 1e-6) {
            this.compAmount = initialCompAmount;
            this.params = computeCompressorParams(this.compAmount);
        }

        const channelCount = Math.min(input.length, output.length);
        const blockSize = input[0].length;

        let detEnv = this.detectorEnvelope;
        let appGain = this.appliedGain;
        let activeCompAmount = this.compAmount;
        let activeParams = this.params;

        for (let i = 0; i < blockSize; i += 1) {
            const compAmount = clamp01(readParamValue(compAmountValues, i, activeCompAmount));
            if (Math.abs(compAmount - activeCompAmount) > 1e-6) {
                activeCompAmount = compAmount;
                activeParams = computeCompressorParams(activeCompAmount);
            }

            const outputGain = Math.max(0, readParamValue(outputGainValues, i, 1));
            const ceilingGain = Math.max(MIN_GAIN, readParamValue(ceilingGainValues, i, 1));

            let peak = 0;
            for (let ch = 0; ch < channelCount; ch += 1) {
                const sample = input[ch][i];
                const abs = sample < 0 ? -sample : sample;
                if (abs > peak) peak = abs;
            }

            if (peak > detEnv) {
                detEnv = detEnv * this.tc.envAttack + peak * (1 - this.tc.envAttack);
            } else {
                detEnv = detEnv * this.tc.envRelease + peak * (1 - this.tc.envRelease);
            }

            let targetGain = 1;
            if (compAmount > 0) {
                const envDb = gainToDb(detEnv);
                const reductionDb = computeGainReductionDb(envDb, activeParams);
                targetGain = dbToGain(reductionDb);
            }

            if (targetGain < appGain) {
                appGain = targetGain + (appGain - targetGain) * this.tc.gainAttack;
            } else {
                appGain = targetGain + (appGain - targetGain) * this.tc.gainRelease;
            }

            const totalGain = appGain * outputGain;
            for (let ch = 0; ch < channelCount; ch += 1) {
                let sample = input[ch][i] * totalGain;
                if (sample > ceilingGain) sample = ceilingGain;
                else if (sample < -ceilingGain) sample = -ceilingGain;
                output[ch][i] = sample;
            }
        }

        this.compAmount = activeCompAmount;
        this.params = activeParams;
        this.detectorEnvelope = detEnv;
        this.appliedGain = appGain;

        return true;
    }
}

registerProcessor('rtd-dynamics-processor', DynamicsProcessor);
