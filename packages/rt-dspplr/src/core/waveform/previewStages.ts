import type { PreviewStage } from '../effects/preview';
import type { PluginPreviewProcess } from '../effects/types';
import { HIGH_PASS_SECTION_Q, clampHighPassHz, computeHighPassCoefficients } from '../dsp/highPass';

// ---------------------------------------------------------------------------
// Sample-level preview stages, run in a preview worker over the clip's audio,
// chunk by chunk: the built-in high-pass (stateful biquads) and third-party
// plugins' process() functions (their source compiled once per worker, from a
// Blob URL with importScripts, so no eval). A stage that throws is skipped from
// then on and reported; the rest of the preview goes on.
// ---------------------------------------------------------------------------

declare const importScripts: ((...urls: string[]) => void) | undefined;

const compiled = new Map<string, PluginPreviewProcess | null>();

function compile(code: string): PluginPreviewProcess | null {
    if (compiled.has(code)) return compiled.get(code)!;
    let fn: PluginPreviewProcess | null = null;
    try {
        const scope = self as unknown as { __rtdStage?: PluginPreviewProcess };
        scope.__rtdStage = undefined;
        const url = URL.createObjectURL(new Blob([`self.__rtdStage = (${code});`], { type: 'text/javascript' }));
        try {
            if (typeof importScripts === 'function') importScripts(url);
        } finally {
            URL.revokeObjectURL(url);
        }
        fn = typeof scope.__rtdStage === 'function' ? scope.__rtdStage : null;
    } catch (error) {
        console.warn('[preview] a plugin preview could not be compiled; it is left out', error);
        fn = null;
    }
    compiled.set(code, fn);
    return fn;
}

export interface StageRunner {
    /** Process one chunk (planar, in place); returns per-stage RMS ratio per gain bin when asked to measure. */
    run(chunk: Float32Array[], sampleRate: number): void;
    /** Per-gain-bin level ratio of the stages that asked to be measured (out / in, RMS), or null. */
    readonly levelRatio: Float32Array | null;
    readonly failed: string[];
}

/**
 * A runner for `stages` over `frames` of audio at `sampleRate`, measuring the
 * level change of `level` stages per `gainBin` frames (for the spectrogram's
 * column gain).
 */
export function createStageRunner(stages: PreviewStage[], channelCount: number, frames: number, gainBin: number): StageRunner {
    const hpState = stages.map(() => Array.from({ length: channelCount }, () => new Float64Array(8)));
    const pluginState = stages.map(() => ({} as Record<string, unknown>));
    const fns = stages.map((s) => (s.kind === 'process' ? compile(s.code) : null));
    const measure = stages.some((s) => s.kind === 'process' && s.level);
    const bins = Math.ceil(frames / gainBin);
    const before = measure ? new Float64Array(bins) : null;
    const after = measure ? new Float64Array(bins) : null;
    const failed: string[] = [];
    let position = 0;

    const sumSquares = (chunk: Float32Array[], into: Float64Array) => {
        for (const ch of chunk) {
            for (let i = 0; i < ch.length; i += 1) into[((position + i) / gainBin) | 0] += ch[i] * ch[i];
        }
    };

    return {
        get levelRatio() {
            if (!before || !after) return null;
            const out = new Float32Array(bins);
            for (let b = 0; b < bins; b += 1) out[b] = before[b] > 1e-20 ? Math.sqrt(after[b] / before[b]) : 1;
            return out;
        },
        failed,
        run(chunk, sampleRate) {
            stages.forEach((stage, k) => {
                const levelStage = stage.kind === 'process' && stage.level;
                if (levelStage && before) sumSquares(chunk, before);
                if (stage.kind === 'highpass') {
                    const freq = clampHighPassHz(stage.hz, sampleRate);
                    const sections = HIGH_PASS_SECTION_Q.map((q) => computeHighPassCoefficients(sampleRate, freq, q));
                    chunk.forEach((x, c) => {
                        const st = hpState[k][c];
                        for (let j = 0; j < 2; j += 1) {
                            const f = sections[j];
                            const o = j * 4;
                            let x1 = st[o], x2 = st[o + 1], y1 = st[o + 2], y2 = st[o + 3];
                            for (let i = 0; i < x.length; i += 1) {
                                const v = x[i];
                                const y = f.b0 * v + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
                                x2 = x1; x1 = v; y2 = y1; y1 = y;
                                x[i] = y;
                            }
                            st[o] = x1; st[o + 1] = x2; st[o + 2] = y1; st[o + 3] = y2;
                        }
                    });
                } else {
                    const fn = fns[k];
                    if (fn) {
                        try {
                            fn(chunk, sampleRate, stage.params, pluginState[k]);
                        } catch (error) {
                            console.warn(`[preview] plugin "${stage.id}" threw; it is left out of the preview`, error);
                            fns[k] = null;
                            failed.push(stage.id);
                        }
                    }
                }
                if (levelStage && after) sumSquares(chunk, after);
            });
            position += chunk[0]?.length ?? 0;
        },
    };
}
