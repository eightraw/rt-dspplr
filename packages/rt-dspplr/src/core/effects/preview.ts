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
    /** Before all processing. */
    inputGainDb: number;
    highPassHz: number;
    compression: number;
    /** After all processing, before the ceiling. */
    outputGainDb: number;
    /** Sample-level stages in chain order, when a third-party effect has a process() preview. */
    stages: PreviewStage[] | null;
    /** Active third-party effects with a magnitude response (LTI), for the spectrogram rows. */
    lti: Array<{ plugin: DspPlugin; params: PluginParams }>;
    /** A key that changes whenever anything above does. */
    key: string;
}

const codes = new WeakMap<DspPlugin, string | null>();
/** Sources a preview worker could not compile: left out of the previews, and counted as missing. */
const broken = new Set<string>();

/**
 * The source of a plugin's process() preview: the function's own text, which
 * the preview worker compiles (previewStages.ts). null without a preview, and
 * for one that cannot run there: an async function or a generator (the
 * worker reads the channels back as soon as the call returns), a bound or
 * built-in function (it has no source), or a source a worker could not compile.
 */
export function previewCode(plugin: DspPlugin): string | null {
    const fn = plugin.preview?.process;
    if (!fn) return null;
    let code = codes.get(plugin);
    if (code === undefined) {
        code = sourceOf(plugin, fn);
        codes.set(plugin, code);
    }
    return code !== null && !broken.has(code) ? code : null;
}

function sourceOf(plugin: DspPlugin, fn: (...args: never[]) => unknown): string | null {
    const kind = Object.prototype.toString.call(fn);
    if (kind !== '[object Function]') {
        const what = kind === '[object AsyncFunction]' ? 'an async function' : 'a generator';
        console.warn(`[preview] ${plugin.name}: preview.process is ${what}; it must process the channels before it returns. It is left out of the previews.`);
        return null;
    }
    const code = fn.toString().trim();
    if (/\{\s*\[native code\]\s*\}$/.test(code)) {
        console.warn(`[preview] ${plugin.name}: preview.process has no source (a bound or built-in function). It is left out of the previews.`);
        return null;
    }
    return code;
}

/** A preview worker could not compile `code`. Returns whether that is news (the coverage changes). */
export function markPreviewBroken(code: string): boolean {
    if (broken.has(code)) return false;
    broken.add(code);
    return true;
}

const active = (e: EffectState) => !e.bypassed && !e.error;

export function previewSettings(state: AudioPlayerState): PreviewSettings {
    const effects = state.effects ?? [];
    const hp = effects.find((e) => e.plugin.builtin === 'highpass' && active(e));
    const dyn = effects.find((e) => e.plugin.builtin === 'dynamics' && active(e));
    const third = effects.filter((e) => !e.plugin.builtin && active(e));
    const withProcess = third.filter((e) => previewCode(e.plugin) !== null);
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
        inputGainDb: state.processing.inputGainDb,
        highPassHz: hp ? hp.params.hz : 0,
        compression: dyn ? dyn.params.amount : 0,
        outputGainDb: state.processing.outputGainDb,
        stages,
        lti,
    };
    // The output gain is left out: a gain track is rescaled for it without a recompute.
    const key = JSON.stringify([settings.inputGainDb, settings.highPassHz, settings.compression,
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
        // A process() that cannot run in the worker (previewCode) counts as none.
        const process = previewCode(e.plugin) !== null;
        if (!process) { waveform = false; missing.add(e.plugin.name); }
        if (!process && !p?.magnitudeResponse) { spectrogram = false; missing.add(e.plugin.name); }
        if (!(p?.magnitudeResponse && hasSpectrogramFile)) { overview = false; if (!p?.magnitudeResponse) missing.add(e.plugin.name); }
    }
    return { waveform, spectrogram, overview, missing: [...missing] };
}
