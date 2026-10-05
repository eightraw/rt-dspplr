// ---------------------------------------------------------------------------
// The DSP plugin contract ("bring your own effect").
//
// A plugin is plain data plus functions. It describes its parameters, how it
// runs in the audio graph (realtime), and how the previews show it (what is
// heard is what is drawn). The built-in
// high-pass and dynamics are plugins of this same contract (builtins.ts).
//
// Chain order, for every source:
//
//   source (mix A/B → realtime stretch, in the stream engine)
//     → effect 1 → effect 2 → … (inserts, in the order of player.effects)
//       → volume (the fader, smoothed) → analyser (meters) → output
//
// Effects come after the mix and the stretcher: they process what is heard,
// at the speed it is heard (a compressor's time constants, a gate's hold, a
// reverb's tail stay right at 2x), they run once instead of once per stem,
// and the stretcher gets the dry signal it is designed for. The fader comes
// after the inserts, as on a mixing desk: moving it never changes how a
// compressor or a gate reacts.
//
// EXPERIMENTAL: every type and helper here may change in minor releases before 1.0.
// ---------------------------------------------------------------------------

/** @experimental */
export type ParamScale = 'linear' | 'log';

/** @experimental */
export interface PluginParam {
    /** Stable id (the AudioParam name for worklet plugins). */
    id: string;
    label: string;
    /** Shown after the value: 'Hz', 'dB', '%', '' … */
    unit?: string;
    min: number;
    max: number;
    default: number;
    /** How a slider maps to the value. Default 'linear'. */
    scale?: ParamScale;
    /** Slider step in value units (linear) or 0 for continuous. */
    step?: number;
    /** 'a-rate' or 'k-rate' for worklet plugins. Default 'k-rate'. */
    automationRate?: 'a-rate' | 'k-rate';
    /** Display text for a value (default: the number with its unit). */
    format?: (value: number) => string;
}

/** @experimental */
export type PluginParams = Record<string, number>;

/** What a realtime plugin returns from create(): its nodes and how to drive them. @experimental */
export interface PluginInstance {
    input: AudioNode;
    output: AudioNode;
    /** Apply a (validated) parameter value; smooth it so a move never clicks. */
    setParam(id: string, value: number, timeConstant?: number): void;
    dispose(): void;
}

/** @experimental */
export type PluginRealtime =
    | {
        kind: 'nodes';
        /** Build the plugin's nodes (any Web Audio nodes, or your own AudioWorkletNode). */
        create(ctx: BaseAudioContext, params: PluginParams): PluginInstance | Promise<PluginInstance>;
    }
    | {
        kind: 'worklet';
        /** Name given to registerProcessor(); every param becomes an AudioParam of that name. */
        processorName: string;
        /** The AudioWorklet module: a URL, or its code (loaded from a Blob URL). */
        moduleUrl?: string;
        moduleCode?: string;
        channelCount?: number;
        processorOptions?: unknown;
    };

/**
 * Sample-level preview: a pure function, run in the preview workers on the
 * clip's audio (chunk by chunk, `state` kept between chunks). It must be
 * self-contained — its source is sent to the worker (Function#toString), so it
 * cannot use closures or imports. Process `channels` in place.
 *
 * @experimental
 */
export type PluginPreviewProcess = (
    channels: Float32Array[],
    sampleRate: number,
    params: PluginParams,
    state: Record<string, unknown>,
) => void;

/** @experimental */
export interface PluginPreview {
    /** For the waveform (and, without magnitudeResponse, the spectrogram's column levels). */
    process?: PluginPreviewProcess;
    /**
     * For linear time-invariant effects: the amplitude response in dB at each
     * frequency. The spectrogram applies it per row, exactly, at paint time,
     * and the prepared overview approximates the waveform from it.
     */
    magnitudeResponse?: (params: PluginParams, freqsHz: Float32Array, sampleRate: number) => Float32Array;
}

/**
 * A DSP plugin: parameters, realtime processing, previews.
 *
 * @experimental The plugin API may change in minor releases before 1.0.
 */
export interface DspPlugin {
    id: string;
    name: string;
    version: string;
    params: PluginParam[];
    /** Processing delay in frames (reported in state.effectsLatencyFrames). */
    latencyFrames?: number;
    realtime: PluginRealtime;
    /** Without a preview, the UI says that the previews do not include this effect. */
    preview?: PluginPreview;
    /** @internal the built-ins' previews run on dedicated code paths. */
    builtin?: 'highpass' | 'dynamics';
}

/** An effect in a player's chain, as the state shows it. @experimental */
export interface EffectState {
    /** Instance id (unique in the chain). */
    id: string;
    plugin: DspPlugin;
    params: PluginParams;
    bypassed: boolean;
    /** Set when the effect failed (it is then bypassed). */
    error: string | null;
}

/** How completely the previews show the current chain. @experimental */
export interface PreviewCoverage {
    /** Every active effect is in the waveform preview (exact where audio is decoded). */
    waveform: boolean;
    /** Every active effect is in the spectrogram preview. */
    spectrogram: boolean;
    /** Every active effect is in a prepared clip's overview (before segments are decoded). */
    overview: boolean;
    /** Names of the effects a preview leaves out. */
    missing: string[];
}

/** Clamp to the schema; throw on an unknown parameter or a non-number. @experimental */
export function validateParam(plugin: DspPlugin, id: string, value: number): number {
    const spec = plugin.params.find((p) => p.id === id);
    if (!spec) throw new Error(`${plugin.id}: no parameter "${id}"`);
    if (typeof value !== 'number' || Number.isNaN(value)) throw new TypeError(`${plugin.id}.${id}: not a number`);
    return Math.min(spec.max, Math.max(spec.min, value));
}

/** Defaults of every parameter, overridden by `params` (validated). @experimental */
export function resolveParams(plugin: DspPlugin, params: PluginParams = {}): PluginParams {
    const out: PluginParams = {};
    for (const p of plugin.params) out[p.id] = p.default;
    for (const [id, value] of Object.entries(params)) out[id] = validateParam(plugin, id, value);
    return out;
}

/** Slider position 0..1 ⇄ value, by the param's scale. @experimental */
export function paramToUnit(spec: PluginParam, value: number): number {
    if (spec.scale === 'log' && spec.min > 0) return Math.log(value / spec.min) / Math.log(spec.max / spec.min);
    return (value - spec.min) / (spec.max - spec.min || 1);
}

/** @experimental */
export function unitToParam(spec: PluginParam, unit: number): number {
    const u = Math.min(1, Math.max(0, unit));
    if (spec.scale === 'log' && spec.min > 0) return spec.min * Math.pow(spec.max / spec.min, u);
    return spec.min + u * (spec.max - spec.min);
}
