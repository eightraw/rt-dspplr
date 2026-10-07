// ---------------------------------------------------------------------------
// Offline stretch strategies — a worker that renders each speed of a whole
// clip ahead of playback (Rubber Band, from the optional ./stretch-rubberband
// entry, or your own). Without one the player stretches in realtime in its
// stream engine.
// ---------------------------------------------------------------------------

/**
 * A pluggable offline time-stretch backend. `createWorker` starts a Web Worker
 * that speaks the protocol in `./protocol.ts` (use `serveStretchWorker` to write
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
