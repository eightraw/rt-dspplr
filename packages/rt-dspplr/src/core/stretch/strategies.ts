import createVocoderWorker from './vocoder.worker.ts?inline-worker';

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

/**
 * Default strategy: the built-in phase vocoder (OfflineStretchCore), run in an
 * inlined Blob-URL worker. No extra files, no bundler configuration.
 */
export const vocoderStretcher: StretchStrategy = Object.freeze({
    id: 'vocoder',
    createWorker: () => safeCreate(createVocoderWorker, 'Vocoder stretch'),
});

/**
 * No offline rendering at all: speed changes use AudioBufferSourceNode
 * playbackRate (pitch follows speed, "chipmunk" effect). Zero CPU cost.
 */
export const nativeStretcher: StretchStrategy = Object.freeze({
    id: 'native',
    createWorker: () => null,
});
