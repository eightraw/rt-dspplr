import createApproxWorker from './approx.worker.ts?inline-worker';
import type { BandsFile } from '../stream/bandsFile';
import { approximateProcessed, type LtiOverview, type StemBOverview } from './approxPreview';
import type { GainTrack } from './gainTrack';
import type { WaveformPeakPyramid } from './pyramid';
import type { WaveformProcessing } from './types';

// ---------------------------------------------------------------------------
// Main-thread handle of approx.worker.ts. With the worker blocked (a CSP
// without blob:), the same function runs on the main thread instead.
// ---------------------------------------------------------------------------

export class ApproxPreview {
    private _worker: Worker | null = null;
    private _loadId = 0;
    private _requestId = 0;
    private _clip: { stored: WaveformPeakPyramid; bands: BandsFile | null; sampleRate: number; spectro?: LtiOverview['spectro']; stemB?: StemBOverview | null } | null = null;
    private readonly _onPyramid: (pyramid: WaveformPeakPyramid, gain: GainTrack | null) => void;

    constructor(onPyramid: (pyramid: WaveformPeakPyramid, gain: GainTrack | null) => void) {
        this._onPyramid = onPyramid;
        try {
            this._worker = createApproxWorker();
            this._worker.onmessage = (event: MessageEvent<{ loadId: number; requestId: number; pyramid: WaveformPeakPyramid; gain: GainTrack | null }>) => {
                const { loadId, requestId, pyramid, gain } = event.data;
                if (loadId === this._loadId && requestId === this._requestId) this._onPyramid(pyramid, gain);
            };
            this._worker.onerror = (event) => {
                event.preventDefault?.();
                console.warn('[ApproxPreview] worker failed; computing on the main thread', event.message);
                this._worker?.terminate();
                this._worker = null;
            };
        } catch {
            this._worker = null;
        }
    }

    /** A new clip's stored peaks and bands (the levels are copied to the worker). */
    load(stored: WaveformPeakPyramid, bands: BandsFile | null, sampleRate: number): void {
        this._loadId += 1;
        this._clip = { stored, bands, sampleRate };
        this._worker?.postMessage({ type: 'load', loadId: this._loadId, stored, bands, sampleRate });
    }

    /** The prepared spectrogram's finest level, for plugins with a magnitude response. */
    setSpectrogram(spectro: LtiOverview['spectro']): void {
        if (!this._clip) return;
        this._clip.spectro = spectro;
        this._worker?.postMessage({ type: 'spectro', loadId: this._loadId, spectro });
    }

    /** Stem B's stored overview, blended in by the mix. */
    setStemB(stemB: StemBOverview | null): void {
        if (!this._clip) return;
        this._clip.stemB = stemB;
        this._worker?.postMessage({ type: 'stemB', loadId: this._loadId, stemB });
    }

    process(processing: WaveformProcessing, rowAmp: Float32Array | null = null): void {
        const clip = this._clip;
        if (!clip) return;
        const requestId = ++this._requestId;
        if (this._worker) {
            this._worker.postMessage({ type: 'process', loadId: this._loadId, requestId, processing, rowAmp });
            return;
        }
        const lti = rowAmp && clip.spectro ? { rowAmp, spectro: clip.spectro } : null;
        const { pyramid, gain } = approximateProcessed(clip.stored, clip.bands, processing, clip.sampleRate, lti, clip.stemB);
        this._onPyramid(pyramid, gain);
    }

    dispose(): void {
        this._worker?.terminate();
        this._worker = null;
        this._clip = null;
    }
}
