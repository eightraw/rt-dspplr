import createPeaksWorker from './peaks.worker.ts?inline-worker';
import { markPreviewBroken } from '../effects/preview';
import type { WaveformPeakPyramid } from './pyramid';
import type { WaveformProcessing } from './types';
import type { GainTrack } from './gainTrack';

// ---------------------------------------------------------------------------
// WaveformAnalyzer — main-thread handle for the peak pyramid worker
// ---------------------------------------------------------------------------
//
// Usage:
//   const analyzer = new WaveformAnalyzer(({ source, processed }) => draw(processed ?? source));
//   analyzer.setBuffers(buffer, bufferB, processing);  // new clip / stem B
//   analyzer.setProcessing(processing);                        // knob moved
//   analyzer.dispose();
//
// One request is in the worker at a time and only the latest one waits: a
// knob dragged over a long clip (a rebuild can take most of a second) never
// queues up work, and the waveform follows as fast as the worker can go. The
// result of a request that belongs to an earlier clip is dropped.

export interface WaveformPyramids {
    /** Peaks of the untouched clip. */
    source: WaveformPeakPyramid | null;
    /** Peaks after the DSP preview (what the listener hears). */
    processed: WaveformPeakPyramid | null;
    /** The dynamics gain over time behind `processed` (for the spectrogram). */
    gain?: GainTrack | null;
}

type BufferReadyMessage = {
    type: 'bufferReady';
    requestId: number;
    sourcePyramid: WaveformPeakPyramid;
    processedPyramid: WaveformPeakPyramid;
    gain: GainTrack | null;
    uncompiled?: string[];
};

type ProcessedReadyMessage = {
    type: 'processedReady';
    requestId: number;
    pyramid: WaveformPeakPyramid;
    gain: GainTrack | null;
    uncompiled?: string[];
};

type WaveformWorkerMessage = BufferReadyMessage | ProcessedReadyMessage;

type Job =
    | { type: 'loadBuffer'; requestId: number; buffer: AudioBuffer; bufferB: AudioBuffer | null; processing: WaveformProcessing }
    | { type: 'buildProcessed'; requestId: number; loadId: number; processing: WaveformProcessing };

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
    /** The request the worker is on, and the one to send when it is done (the latest only). */
    private _inFlight: Job | null = null;
    private _waiting: Job | null = null;
    private _hasBuffer = false;
    private _pyramids: WaveformPyramids = { source: null, processed: null };
    private readonly _onUpdate: (pyramids: WaveformPyramids) => void;
    private readonly _onPreviewBroken: (() => void) | undefined;

    /** `onPreviewBroken`: a plugin's preview did not compile in the worker (previewCode() now leaves it out). */
    constructor(onUpdate: (pyramids: WaveformPyramids) => void, onPreviewBroken?: () => void) {
        this._onUpdate = onUpdate;
        this._onPreviewBroken = onPreviewBroken;
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
            const job = this._inFlight;
            this._inFlight = null;
            const next = this._waiting;
            this._waiting = null;
            if (next) this._post(next);

            if (message.uncompiled && message.uncompiled.filter(markPreviewBroken).length > 0) this._onPreviewBroken?.();

            if (message.type === 'bufferReady') {
                if (message.requestId === this._loadRequestId) {
                    this._pyramids = { source: message.sourcePyramid, processed: message.processedPyramid, gain: message.gain };
                    this._onUpdate(this._pyramids);
                }
                return;
            }

            // A rebuild for the clip still loaded is shown even when newer settings wait:
            // it is closer to them than what is drawn.
            if (job?.type === 'buildProcessed' && job.loadId === this._loadRequestId) {
                this._pyramids = { ...this._pyramids, processed: message.pyramid, gain: message.gain };
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
     * copied when the request goes to the worker, so the buffers stay usable
     * for playback.
     */
    setBuffers(buffer: AudioBuffer, bufferB: AudioBuffer | null, processing: WaveformProcessing): void {
        if (!this._worker) return;
        this._hasBuffer = true;
        // Supersedes whatever waits, and a rebuild in the worker belongs to the previous buffers.
        this._send({ type: 'loadBuffer', requestId: ++this._loadRequestId, buffer, bufferB, processing });
    }

    /** Rebuild the processed pyramid for new DSP settings (the latest settings win while the worker is busy). */
    setProcessing(processing: WaveformProcessing): void {
        if (!this._worker || !this._hasBuffer) return;
        const waiting = this._waiting;
        if (waiting?.type === 'loadBuffer') {
            // The waiting load builds its processed pyramid with these settings.
            waiting.processing = processing;
            return;
        }
        this._send({ type: 'buildProcessed', requestId: ++this._processedRequestId, loadId: this._loadRequestId, processing });
    }

    dispose(): void {
        this._worker?.terminate();
        this._worker = null;
        this._inFlight = null;
        this._waiting = null;
        this._hasBuffer = false;
    }

    private _send(job: Job): void {
        if (this._inFlight) {
            this._waiting = job;
            return;
        }
        this._post(job);
    }

    private _post(job: Job): void {
        const worker = this._worker;
        if (!worker) return;
        this._inFlight = job;
        if (job.type === 'buildProcessed') {
            worker.postMessage({ type: 'buildProcessed', requestId: job.requestId, processing: job.processing });
            return;
        }
        const channels: ArrayBuffer[] = [];
        const channelsB: ArrayBuffer[] = [];
        const transfers: ArrayBuffer[] = [];
        copyChannels(job.buffer, channels, transfers);
        if (job.bufferB) {
            copyChannels(job.bufferB, channelsB, transfers);
        }
        worker.postMessage({
            type: 'loadBuffer',
            sampleRate: job.buffer.sampleRate,
            length: job.buffer.length,
            channels,
            channelsB,
            processing: job.processing,
            requestId: job.requestId,
        }, transfers);
    }
}
