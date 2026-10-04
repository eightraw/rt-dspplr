import createPeaksWorker from './peaks.worker.ts?inline-worker';
import type { WaveformPeakPyramid } from './pyramid';
import type { WaveformProcessing } from './types';

// ---------------------------------------------------------------------------
// WaveformAnalyzer — main-thread handle for the peak pyramid worker
// ---------------------------------------------------------------------------
//
// Usage:
//   const analyzer = new WaveformAnalyzer(({ source, processed }) => draw(processed ?? source));
//   analyzer.setBuffers(buffer, bufferB, processing);  // new clip / stem B
//   analyzer.setProcessing(processing);                        // knob moved (debounced)
//   analyzer.dispose();

export interface WaveformPyramids {
    /** Peaks of the untouched clip. */
    source: WaveformPeakPyramid | null;
    /** Peaks after the DSP preview (what the listener hears). */
    processed: WaveformPeakPyramid | null;
}

type BufferReadyMessage = {
    type: 'bufferReady';
    requestId: number;
    sourcePyramid: WaveformPeakPyramid;
    processedPyramid: WaveformPeakPyramid;
};

type ProcessedReadyMessage = {
    type: 'processedReady';
    requestId: number;
    pyramid: WaveformPeakPyramid;
};

type WaveformWorkerMessage = BufferReadyMessage | ProcessedReadyMessage;

const PROCESSED_DEBOUNCE_MS = 16;

function copyChannels(buffer: AudioBuffer, into: ArrayBuffer[], transfers: ArrayBuffer[]): void {
    for (let index = 0; index < buffer.numberOfChannels; index += 1) {
        const copy = buffer.getChannelData(index).slice();
        into.push(copy.buffer);
        transfers.push(copy.buffer);
    }
}

export class WaveformAnalyzer {
    private _worker: Worker | null = null;
    private _loadRequestId = 0;
    private _processedRequestId = 0;
    private _debounce: ReturnType<typeof setTimeout> | null = null;
    private _hasBuffer = false;
    private _pyramids: WaveformPyramids = { source: null, processed: null };
    private readonly _onUpdate: (pyramids: WaveformPyramids) => void;

    constructor(onUpdate: (pyramids: WaveformPyramids) => void) {
        this._onUpdate = onUpdate;
        try {
            this._worker = createPeaksWorker();
        } catch (error) {
            // Typical cause: a Content-Security-Policy without `blob:` in worker-src.
            console.warn('[WaveformAnalyzer] Peak worker could not be started; waveform disabled', error);
            this._worker = null;
            return;
        }

        this._worker.onmessage = (event: MessageEvent<WaveformWorkerMessage>) => {
            const message = event.data;
            if (!message) {
                return;
            }

            if (message.type === 'bufferReady') {
                if (message.requestId === this._loadRequestId) {
                    this._pyramids = { source: message.sourcePyramid, processed: message.processedPyramid };
                    this._onUpdate(this._pyramids);
                }
                return;
            }

            if (message.requestId === this._processedRequestId) {
                this._pyramids = { ...this._pyramids, processed: message.pyramid };
                this._onUpdate(this._pyramids);
            }
        };
        // A worker that fails after starting (a CSP reported late, a crash) is
        // dropped with one warning; the waveform drawn so far stays.
        this._worker.onerror = (event) => {
            event.preventDefault?.();
            this._fail(event.message || event.error);
        };
        this._worker.onmessageerror = () => this._fail('message could not be read');
    }

    private _fail(reason: unknown): void {
        if (!this._worker) return;
        console.warn('[WaveformAnalyzer] Peak worker failed; waveform disabled', reason);
        this.dispose();
    }

    get pyramids(): WaveformPyramids {
        return this._pyramids;
    }

    /**
     * Analyse a new clip (and optionally its stem B). Channel data is
     * copied, so the buffers stay usable for playback.
     */
    setBuffers(buffer: AudioBuffer, bufferB: AudioBuffer | null, processing: WaveformProcessing): void {
        const worker = this._worker;
        if (!worker) return;

        const requestId = ++this._loadRequestId;
        // A pending processed-only rebuild belongs to the previous buffers.
        this._clearDebounce();
        this._processedRequestId += 1;
        this._hasBuffer = true;

        const channels: ArrayBuffer[] = [];
        const channelsB: ArrayBuffer[] = [];
        const transfers: ArrayBuffer[] = [];
        copyChannels(buffer, channels, transfers);
        if (bufferB) {
            copyChannels(bufferB, channelsB, transfers);
        }

        worker.postMessage({
            type: 'loadBuffer',
            sampleRate: buffer.sampleRate,
            length: buffer.length,
            channels,
            channelsB,
            processing,
            requestId,
        }, transfers);
    }

    /** Rebuild the processed pyramid for new DSP settings (debounced to one frame). */
    setProcessing(processing: WaveformProcessing): void {
        const worker = this._worker;
        if (!worker || !this._hasBuffer) return;

        const requestId = ++this._processedRequestId;
        this._clearDebounce();
        this._debounce = setTimeout(() => {
            this._debounce = null;
            worker.postMessage({
                type: 'buildProcessed',
                requestId,
                processing,
            });
        }, PROCESSED_DEBOUNCE_MS);
    }

    dispose(): void {
        this._clearDebounce();
        this._worker?.terminate();
        this._worker = null;
        this._hasBuffer = false;
    }

    private _clearDebounce(): void {
        if (this._debounce) {
            clearTimeout(this._debounce);
            this._debounce = null;
        }
    }
}
