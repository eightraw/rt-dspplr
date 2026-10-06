import { HIGH_PASS_MAX_HZ, formatHighPassLabel, formatPercentLabel } from '../controls';
import { createCompressor, createDynamicsWorklet, createHighPass } from '../dsp';
import AudioEngine from '../engine/AudioEngine';
import { highPassResponse } from '../spectrogram/dspPaint';
import type { DspPlugin, PluginInstance } from './types';

// ---------------------------------------------------------------------------
// The built-in effects, as plugins of the public contract (dogfooding):
//
//   rtd.highpass   24 dB/oct Butterworth (two native biquads)
//   rtd.dynamics   the peak compressor (an AudioWorklet; native nodes when
//                  the worklet is unavailable)
//
// The input gain, the output gain and the -0.01 dBFS ceiling are not plugins:
// they are the chain's own first and last stages (EffectChain).
// setHighPass / setCompression are sugar for these plugins' params.
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

/** @experimental Built-in compressor, as a plugin. */
export const dynamicsPlugin: DspPlugin = {
    id: 'rtd.dynamics',
    name: 'Dynamics',
    version: '1.0.0',
    builtin: 'dynamics',
    params: [
        { id: 'amount', label: 'Compression', unit: '%', min: 0, max: 1, default: 0, step: 0.01, format: formatPercentLabel },
    ],
    realtime: {
        kind: 'nodes',
        create(ctx, params): PluginInstance {
            const engine = AudioEngine.getInstance();
            if (engine.workletAvailable && 'audioWorklet' in ctx) {
                try {
                    // Unity gain and no clipping here: the chain's ceiling is its last stage.
                    const dynamics = createDynamicsWorklet(ctx as AudioContext, { amount: params.amount, outputGain: 1, ceilingGain: 1e6 });
                    return {
                        input: dynamics.input,
                        output: dynamics.output,
                        setParam(id, value) {
                            if (id === 'amount') dynamics.setAmount(value);
                        },
                        dispose: () => dynamics.disconnect(),
                    };
                } catch (error) {
                    console.warn('[AudioPlayer] Failed to create dynamics worklet, using native fallback', error);
                }
            }
            // Native fallback: a DynamicsCompressorNode.
            const compressor = createCompressor(ctx, params.amount);
            return {
                input: compressor.input,
                output: compressor.output,
                setParam(id, value) {
                    if (id === 'amount') compressor.setAmount(value);
                },
                dispose: () => compressor.disconnect(),
            };
        },
    },
};

export const BUILTIN_PLUGINS = [highPassPlugin, dynamicsPlugin] as const;
