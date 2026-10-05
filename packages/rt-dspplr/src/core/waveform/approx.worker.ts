// Overview preview worker for prepared clips: holds the stored finest peak
// level and the bands of one clip and answers processing changes with the
// approximate processed pyramid (approxPreview.ts), off the main thread like
// the peaks worker does for decoded clips. Bundled into a self-contained
// string at library build time.

import type { BandsFile } from '../stream/bandsFile';
import { approximateProcessed, type LtiOverview, type StemBOverview } from './approxPreview';
import type { WaveformPeakLevel, WaveformPeakPyramid } from './pyramid';
import type { WaveformProcessing } from './types';

export type ApproxWorkerMessage =
    | { type: 'load'; loadId: number; stored: WaveformPeakPyramid; bands: BandsFile | null; sampleRate: number }
    | { type: 'process'; loadId: number; requestId: number; processing: WaveformProcessing; rowAmp?: Float32Array | null }
    | { type: 'spectro'; loadId: number; spectro: LtiOverview['spectro'] }
    | { type: 'stemB'; loadId: number; stemB: StemBOverview | null };

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<ApproxWorkerMessage>) => void) | null;
    postMessage(message: unknown, transfer?: Transferable[]): void;
};

let clip: { loadId: number; stored: WaveformPeakPyramid; bands: BandsFile | null; sampleRate: number; spectro?: LtiOverview['spectro']; stemB?: StemBOverview | null } | null = null;

scope.onmessage = (event) => {
    const message = event.data;
    if (message.type === 'load') {
        clip = { loadId: message.loadId, stored: message.stored, bands: message.bands, sampleRate: message.sampleRate };
        return;
    }
    if (!clip || clip.loadId !== message.loadId) return;
    if (message.type === 'stemB') {
        clip.stemB = message.stemB;
        return;
    }
    if (message.type === 'spectro') {
        clip.spectro = message.spectro;
        return;
    }
    const lti = message.rowAmp && clip.spectro ? { rowAmp: message.rowAmp, spectro: clip.spectro } : null;
    const { pyramid, gain } = approximateProcessed(clip.stored, clip.bands, message.processing, clip.sampleRate, lti, clip.stemB);
    const transfers: Transferable[] = [];
    pyramid.levels.forEach((level: WaveformPeakLevel) => transfers.push(level.minPeaks.buffer, level.maxPeaks.buffer, level.rmsPeaks.buffer));
    if (gain) transfers.push(gain.values.buffer);
    scope.postMessage({ type: 'processed', loadId: message.loadId, requestId: message.requestId, pyramid, gain }, transfers);
};

export {};
