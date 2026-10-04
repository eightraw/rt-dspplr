import createSpectrogramWorker from './spectrogram.worker.ts?inline-worker';
import type {
    SpectralPyramid,
    SpectrogramComputeMessage,
    SpectrogramPyramidMessage,
    SpectrogramPyramidResponse,
    SpectrogramResponse,
} from './protocol';

// ---------------------------------------------------------------------------
// SpectrogramAnalyzer — main-thread handle for the spectrogram worker
// ---------------------------------------------------------------------------
//
// Usage:
//   const analyzer = new SpectrogramAnalyzer((data) => paint(data));
//   analyzer.setBuffers(bufferA, bufferB);          // new clip / stem B arrived
//   analyzer.request({ start, end, columns, rows, minHz, maxHz, fftSize });
//   analyzer.buildPyramid({ rows, minHz, maxHz, rangeDb });   // then draw from it
//   analyzer.dispose();
//
// Every analyzer on the page shares one worker. It starts with the first clip
// handed to any of them and stops when the last one is disposed, and each
// analyzer's audio is dropped from it on dispose. Only the latest request of
// an analyzer is computed: while one is in the worker, a newer one waits and
// replaces any other waiting.

export type SpectrogramData = Omit<SpectrogramResponse, 'type' | 'viewId' | 'requestId' | 'loadId'>;
export type SpectrogramRequest = Omit<SpectrogramComputeMessage, 'type' | 'viewId' | 'requestId' | 'loadId'>;
export type SpectralPyramidRequest = Omit<SpectrogramPyramidMessage, 'type' | 'viewId' | 'requestId' | 'loadId'>;

type Answer = SpectrogramResponse | SpectrogramPyramidResponse | { type: 'failed' };

interface Shared {
    worker: Worker;
    views: Map<number, (message: Answer) => void>;
}

let shared: Shared | null = null;
let workerFailed = false;
let nextViewId = 1;

/** The shared worker is gone: every view hears so, and no view starts another. */
function fail(reason: unknown): void {
    const failed = shared;
    shared = null;
    workerFailed = true;
    console.warn('[SpectrogramAnalyzer] Spectrogram worker failed; spectrogram disabled', reason);
    if (!failed) return;
    try {
        failed.worker.terminate();
    } catch {
        // no-op
    }
    for (const view of failed.views.values()) view({ type: 'failed' });
}

function join(viewId: number, onMessage: (message: Answer) => void): Worker | null {
    if (!shared) {
        if (workerFailed) return null;
        let worker: Worker;
        try {
            worker = createSpectrogramWorker();
        } catch (error) {
            // Typical cause: a Content-Security-Policy without `blob:` in worker-src.
            console.warn('[SpectrogramAnalyzer] Spectrogram worker could not be started; spectrogram disabled', error);
            workerFailed = true;
            return null;
        }
        const views = new Map<number, (message: Answer) => void>();
        worker.onmessage = (event: MessageEvent<Exclude<Answer, { type: 'failed' }>>) => {
            const message = event.data;
            if (message) views.get(message.viewId)?.(message);
        };
        worker.onerror = (event) => {
            event.preventDefault?.();
            fail(event.message || event.error);
        };
        worker.onmessageerror = () => fail('message could not be read');
        shared = { worker, views };
    }
    shared.views.set(viewId, onMessage);
    return shared.worker;
}

function leave(viewId: number): void {
    if (!shared || !shared.views.has(viewId)) return;
    shared.views.delete(viewId);
    if (shared.views.size === 0) {
        shared.worker.terminate();
        shared = null;
        return;
    }
    shared.worker.postMessage({ type: 'unload', viewId });
}

/** Mono, 16-bit copy of a buffer: the mean of its channels, clipped to ±1. */
function downmix(buffer: AudioBuffer): ArrayBuffer {
    const sum = new Float32Array(buffer.length);
    const channels = buffer.numberOfChannels;
    for (let c = 0; c < channels; c += 1) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < sum.length; i += 1) sum[i] += data[i];
    }
    const scale = 32767 / Math.max(1, channels);
    const out = new Int16Array(buffer.length);
    for (let i = 0; i < out.length; i += 1) out[i] = Math.max(-32767, Math.min(32767, Math.round(sum[i] * scale)));
    return out.buffer;
}

export class SpectrogramAnalyzer {
    private readonly _viewId = nextViewId++;
    private _worker: Worker | null = null;
    private _loadId = 0;
    private _requestId = 0;
    private _loaded = false;
    private _busy = false;
    private _waiting: SpectrogramRequest | null = null;
    private _disposed = false;
    private _pyramidId = 0;
    private readonly _onData: (data: SpectrogramData) => void;
    private readonly _onPyramid: ((pyramid: SpectralPyramid) => void) | undefined;

    constructor(onData: (data: SpectrogramData) => void, onPyramid?: (pyramid: SpectralPyramid) => void) {
        this._onData = onData;
        this._onPyramid = onPyramid;
    }

    /** Analyse a new clip. Channels are downmixed to a copy, so the buffers stay usable. */
    setBuffers(bufferA: AudioBuffer | null, bufferB: AudioBuffer | null): void {
        if (this._disposed) return;
        this._worker ??= join(this._viewId, (message) => this._receive(message));
        const worker = this._worker;
        if (!worker) return;
        const loadId = ++this._loadId;
        const stemA = bufferA ? downmix(bufferA) : null;
        const stemB = bufferB ? downmix(bufferB) : null;
        const transfers = [stemA, stemB].filter((b): b is ArrayBuffer => b !== null);
        worker.postMessage({
            type: 'load',
            viewId: this._viewId,
            loadId,
            sampleRate: bufferA?.sampleRate ?? 0,
            stemA,
            stemB,
        }, transfers);
        this._loaded = bufferA !== null;
        this._waiting = null;
    }

    /** Compute a window of the loaded clip. Call after setBuffers(); only the latest request is answered. */
    request(request: SpectrogramRequest): void {
        const worker = this._worker;
        if (!worker || !this._loaded || this._disposed) return;
        if (this._busy) {
            this._waiting = request;
            // Whatever is in the worker now is already out of date.
            ++this._requestId;
            return;
        }
        this._busy = true;
        worker.postMessage({
            type: 'compute',
            viewId: this._viewId,
            requestId: ++this._requestId,
            loadId: this._loadId,
            ...request,
        });
    }

    /**
     * Build the loaded clip's pyramid. Once it arrives the worker has let go of
     * this clip's audio: further requests need setBuffers() again.
     */
    buildPyramid(request: SpectralPyramidRequest): void {
        const worker = this._worker;
        if (!worker || !this._loaded || this._disposed) return;
        worker.postMessage({
            type: 'pyramid',
            viewId: this._viewId,
            requestId: ++this._pyramidId,
            loadId: this._loadId,
            ...request,
        });
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._loaded = false;
        this._waiting = null;
        leave(this._viewId);
        this._worker = null;
    }

    private _receive(message: Answer): void {
        if (message.type === 'failed') {
            // Nothing more will arrive: let go of the worker so the view does not wait.
            this._worker = null;
            this._loaded = false;
            this._busy = false;
            this._waiting = null;
            return;
        }
        if (message.type === 'pyramid') {
            if (message.loadId !== this._loadId || message.requestId !== this._pyramidId) return;
            this._loaded = false;
            this._onPyramid?.(message.pyramid);
            return;
        }
        this._busy = false;
        const waiting = this._waiting;
        this._waiting = null;
        if (waiting) this.request(waiting);
        if (message.requestId !== this._requestId || message.loadId !== this._loadId) return;
        this._onData({
            start: message.start,
            end: message.end,
            columns: message.columns,
            rows: message.rows,
            magA: message.magA,
            magB: message.magB,
            referenceSum: message.referenceSum,
            referenceMax: message.referenceMax,
        });
    }
}
