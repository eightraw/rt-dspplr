import { HIGH_PASS_MAX_HZ, LIMITER_CEILING_DB, OUTPUT_MAX_DB, OUTPUT_MIN_DB, formatHighPassLabel, formatOutputGainLabel, formatPercentLabel, outputGainDbToGain } from '../controls';
import { createCompressor, createDynamicsWorklet, createHighPass, createLimiter, createOutputGain } from '../dsp';
import { dbToGain } from '../dsp/compression';
import AudioEngine from '../engine/AudioEngine';
import { highPassResponse } from '../spectrogram/dspPaint';
import type { DspPlugin, PluginInstance } from './types';

// ---------------------------------------------------------------------------
// The built-in effects, as plugins of the public contract (dogfooding):
//
//   rtd.highpass   24 dB/oct Butterworth (two native biquads)
//   rtd.dynamics   compressor + output gain + ceiling (-0.01 dBFS) in one
//                  AudioWorklet pass sharing one detector; native nodes when
//                  the worklet is unavailable
//
// The compressor, the output gain and the limiter stay one plugin: they are
// one processor with one detector, and splitting them would change the sound.
// setHighPass / setCompression / setOutputGain are sugar for their params.
// Their previews run on dedicated code paths of the preview workers (exact,
// fast); the contract's preview hooks are what third-party plugins use.
// ---------------------------------------------------------------------------

/** @experimental Built-in high-pass, as a plugin. */
export const highPassPlugin: DspPlugin = {
    id: 'rtd.highpass',
    name: 'High-pass',
    version: '1.0.0',
    builtin: 'highpass',
    params: [
        { id: 'hz', label: 'High-pass', unit: 'Hz', min: 0, max: HIGH_PASS_MAX_HZ, default: 0, step: 10, format: formatHighPassLabel },
    ],
    realtime: {
        kind: 'nodes',
        create(ctx, params): PluginInstance {
            const node = createHighPass(ctx, params.hz);
            return {
                input: node.input,
                output: node.output,
                setParam: (_id, value) => node.setFrequency(value),
                dispose: () => node.disconnect(),
            };
        },
    },
    preview: {
        magnitudeResponse(params, freqs, sampleRate) {
            const amp = highPassResponse(freqs, params.hz, sampleRate);
            return amp.map((a) => 20 * Math.log10(Math.max(1e-6, a)));
        },
    },
};

/** @experimental Built-in compressor + output gain + ceiling, as a plugin. */
export const dynamicsPlugin: DspPlugin = {
    id: 'rtd.dynamics',
    name: 'Dynamics',
    version: '1.0.0',
    builtin: 'dynamics',
    params: [
        { id: 'amount', label: 'Compression', unit: '%', min: 0, max: 1, default: 0, step: 0.01, format: formatPercentLabel },
        { id: 'outputGainDb', label: 'Output gain', unit: 'dB', min: OUTPUT_MIN_DB, max: OUTPUT_MAX_DB, default: 0, step: 0.5, format: formatOutputGainLabel },
    ],
    realtime: {
        kind: 'nodes',
        create(ctx, params): PluginInstance {
            const engine = AudioEngine.getInstance();
            if (engine.workletAvailable && 'audioWorklet' in ctx) {
                try {
                    const dynamics = createDynamicsWorklet(ctx as AudioContext, {
                        amount: params.amount,
                        outputGain: outputGainDbToGain(params.outputGainDb),
                        ceilingGain: dbToGain(LIMITER_CEILING_DB),
                    });
                    return {
                        input: dynamics.input,
                        output: dynamics.output,
                        setParam(id, value) {
                            if (id === 'amount') dynamics.setAmount(value);
                            else dynamics.setGain(outputGainDbToGain(value));
                        },
                        dispose: () => dynamics.disconnect(),
                    };
                } catch (error) {
                    console.warn('[AudioPlayer] Failed to create dynamics worklet, using native fallback', error);
                }
            }
            // Native fallback: compressor, gain and a hard limiter at the ceiling.
            const compressor = createCompressor(ctx, params.amount);
            const gain = createOutputGain(ctx, outputGainDbToGain(params.outputGainDb));
            const limiter = createLimiter(ctx);
            compressor.output.connect(gain.input);
            gain.output.connect(limiter.input);
            return {
                input: compressor.input,
                output: limiter.output,
                setParam(id, value) {
                    if (id === 'amount') compressor.setAmount(value);
                    else gain.setGain(outputGainDbToGain(value));
                },
                dispose() {
                    compressor.disconnect();
                    gain.disconnect();
                    limiter.disconnect();
                },
            };
        },
    },
};

export const BUILTIN_PLUGINS = [highPassPlugin, dynamicsPlugin] as const;
