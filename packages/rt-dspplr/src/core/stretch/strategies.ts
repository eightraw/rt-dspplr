import createVocoderWorker from './vocoder.worker.ts?inline-worker';
import type { VocoderMemory } from './OfflineStretchCore';

// ---------------------------------------------------------------------------
// Stretch strategies — which algorithm renders pitch-preserving speed variants
// ---------------------------------------------------------------------------

/**
 * A pluggable time-stretch backend. `createWorker` starts a Web Worker that
 * speaks the protocol in `./protocol.ts` (use `serveStretchWorker` to write
 * one). Return `null` to signal that no worker is available; playback then
 * falls back to the native `playbackRate`, which changes pitch.
 */
export interface StretchStrategy {
    /** Stable id. Players that pass strategies with the same id share one worker pool and cache. */
    readonly id: string;
    createWorker(): Worker | null;
    /** Max parallel workers. Default: min(2, hardwareConcurrency - 1), at least 1. */
    readonly poolSize?: number;
    /** Settings handed to the worker with every request (the protocol's `options`). Plain, cloneable data. */
    readonly options?: Readonly<Record<string, unknown>>;
}

function safeCreate(factory: () => Worker, label: string): Worker | null {
    try {
        return factory();
    } catch (error) {
        // Typical cause: a Content-Security-Policy without `blob:` in worker-src.
        console.warn(`[rtd] ${label} worker could not be started; speed changes will use native playbackRate`, error);
        return null;
    }
}

export interface VocoderStretcherOptions {
    /**
     * 'auto' (default): long clips are stretched frame by frame ('lean'), short ones
     * with the whole clip in memory ('fast'). 'lean' always: about 1/30 of the memory
     * and the same samples, bit for bit, at a few per cent more time. 'fast' always.
     */
    memory?: VocoderMemory;
}

export type VocoderStretcher = StretchStrategy & ((options?: VocoderStretcherOptions) => StretchStrategy);

function vocoderWith(memory: VocoderMemory): StretchStrategy {
    return Object.freeze({
        id: memory === 'auto' ? 'vocoder' : `vocoder:${memory}`,
        options: Object.freeze({ memory }),
        createWorker: () => safeCreate(createVocoderWorker, 'Vocoder stretch'),
    });
}

/**
 * Default strategy: the built-in phase vocoder (OfflineStretchCore), run in an
 * inlined Blob-URL worker. No extra files, no bundler configuration. Use it as
 * it is, or call it to choose how it holds the clip:
 * `vocoderStretcher({ memory: 'lean' })`.
 */
export const vocoderStretcher: VocoderStretcher = Object.freeze(Object.assign(
    (options: VocoderStretcherOptions = {}) => vocoderWith(options.memory ?? 'auto'),
    vocoderWith('auto'),
));

/**
 * No offline rendering at all: speed changes use AudioBufferSourceNode
 * playbackRate (pitch follows speed, "chipmunk" effect). Zero CPU cost.
 */
export const nativeStretcher: StretchStrategy = Object.freeze({
    id: 'native',
    createWorker: () => null,
});
