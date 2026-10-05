import type { AudioPlayerState } from '../AudioPlayer';
import type { DspPlugin, EffectState, PluginParams, PreviewCoverage } from './types';

// ---------------------------------------------------------------------------
// What the previews need from the effect chain (the state's `effects`):
// the built-ins' settings (their dedicated preview paths) and the third-party
// effects' preview hooks, in chain order.
// ---------------------------------------------------------------------------

/** A sample-level preview stage, serialisable for the preview workers. */
export type PreviewStage =
    | { kind: 'highpass'; hz: number }
    | { kind: 'process'; id: string; code: string; params: PluginParams; /** measure its level change for the spectrogram */ level: boolean };

export interface PreviewSettings {
    highPassHz: number;
    compression: number;
    outputGainDb: number;
    /** Sample-level stages in chain order, when a third-party effect has a process() preview. */
    stages: PreviewStage[] | null;
    /** Active third-party effects with a magnitude response (LTI), for the spectrogram rows. */
    lti: Array<{ plugin: DspPlugin; params: PluginParams }>;
    /** A key that changes whenever anything above does. */
    key: string;
}

const codes = new WeakMap<DspPlugin, string>();

/** The source of a plugin's process() preview, as an expression the worker can evaluate. */
export function previewCode(plugin: DspPlugin): string | null {
    const fn = plugin.preview?.process;
    if (!fn) return null;
    let code = codes.get(plugin);
    if (!code) {
        code = fn.toString().trim();
        // A method shorthand (`process(channels) {…}`) is not an expression on its own.
        if (!/^(async\s+)?function\b/.test(code) && !/^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(code)) code = `function ${code}`;
        codes.set(plugin, code);
    }
    return code;
}

const active = (e: EffectState) => !e.bypassed && !e.error;

export function previewSettings(state: AudioPlayerState): PreviewSettings {
    const effects = state.effects ?? [];
    const hp = effects.find((e) => e.plugin.builtin === 'highpass' && active(e));
    const dyn = effects.find((e) => e.plugin.builtin === 'dynamics' && active(e));
    const third = effects.filter((e) => !e.plugin.builtin && active(e));
    const withProcess = third.filter((e) => e.plugin.preview?.process);
    let stages: PreviewStage[] | null = null;
    if (withProcess.length > 0) {
        stages = [];
        for (const e of effects) {
            if (!active(e)) continue;
            if (e.plugin.builtin === 'highpass' && e.params.hz > 0) stages.push({ kind: 'highpass', hz: e.params.hz });
            const code = !e.plugin.builtin ? previewCode(e.plugin) : null;
            if (code) stages.push({ kind: 'process', id: e.id, code, params: { ...e.params }, level: !e.plugin.preview?.magnitudeResponse });
        }
    }
    const lti = third.filter((e) => e.plugin.preview?.magnitudeResponse).map((e) => ({ plugin: e.plugin, params: e.params }));
    const settings = {
        highPassHz: hp ? hp.params.hz : 0,
        compression: dyn ? dyn.params.amount : 0,
        outputGainDb: dyn ? dyn.params.outputGainDb : 0,
        stages,
        lti,
    };
    const key = JSON.stringify([settings.highPassHz, settings.compression, settings.outputGainDb,
        third.map((e) => [e.id, e.plugin.id, e.params])]);
    return { ...settings, key };
}

/** Which previews leave an active effect out (the UI says so rather than drawing a lie). */
export function previewCoverage(effects: EffectState[], hasSpectrogramFile: boolean): PreviewCoverage {
    const missing = new Set<string>();
    let waveform = true;
    let spectrogram = true;
    let overview = true;
    for (const e of effects) {
        if (e.plugin.builtin || !active(e)) continue;
        const p = e.plugin.preview;
        if (!p?.process) { waveform = false; missing.add(e.plugin.name); }
        if (!p?.process && !p?.magnitudeResponse) { spectrogram = false; missing.add(e.plugin.name); }
        if (!(p?.magnitudeResponse && hasSpectrogramFile)) { overview = false; if (!p?.magnitudeResponse) missing.add(e.plugin.name); }
    }
    return { waveform, spectrogram, overview, missing: [...missing] };
}
