import type { AudioPlayerState } from '../AudioPlayer';
import { outputGainDbToGain } from '../controls';
import { previewSettings } from '../effects/preview';
import { rowFrequencies } from '../spectrogram/dspPaint';
import type { AudioPlayerCore } from '../AudioPlayer';

/** What the preview needs from a player. */
export type PreviewPlayer = Pick<AudioPlayerCore, 'getState' | 'subscribe'> & Partial<Pick<AudioPlayerCore, 'on' | 'getWindowAudio'>>;
import { ApproxPreview } from './overviewPreviewClient';
import type { WaveformPeakLevel, WaveformPeakPyramid } from './pyramid';
import type { WaveformProcessing } from './types';
import type { GainTrack } from './gainTrack';
import { WaveformAnalyzer, type WaveformPyramids } from './WaveformAnalyzer';

// ---------------------------------------------------------------------------
// followWaveform — the waveform a timeline draws for a player, following the
// clip and the DSP settings, whatever the player's source:
//
//   whole clip (buffer source)  the peaks worker over the decoded clip: the
//                               source pyramid, then the processed preview.
//   prepared clip (segmented)   the stored peaks with an APPROXIMATE processed
//                               preview over the whole clip (approxPreview.ts),
//                               plus the EXACT preview of the decoded window
//                               around the view: the same peaks worker, run on
//                               the window's audio, its levels offset to the
//                               window's place (partial levels).
//
// Used by createTimeline() and by the React card.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 16;

/** The preview's view of the DSP: the effect chain (built-ins and plugins) and the mix. */
function processingOf(state: AudioPlayerState): WaveformProcessing {
    const fx = previewSettings(state);
    return {
        highPassHz: fx.highPassHz,
        compression: fx.compression,
        outputGain: outputGainDbToGain(fx.outputGainDb),
        mix: state.processing.mix,
        mixLaw: state.mixLaw,
        stages: fx.stages,
        key: fx.key,
    };
}

function sameProcessing(a: WaveformProcessing | null, b: WaveformProcessing): boolean {
    return a !== null && a.highPassHz === b.highPassHz && a.compression === b.compression
        && a.outputGain === b.outputGain && a.mix === b.mix && a.mixLaw === b.mixLaw && a.key === b.key;
}

/** What the previews draw: the processed waveform and the dynamics gain behind it. */
export interface DspPreview {
    pyramid: WaveformPeakPyramid | null;
    /** Gain over the whole clip (exact for a whole clip, approximate for a prepared one). */
    gain: GainTrack | null;
    /** Exact gain over the decoded window of a prepared clip. */
    windowGain: GainTrack | null;
}

type Publish = (preview: DspPreview) => void;

const hubs = new WeakMap<object, { subs: Set<Publish>; latest: DspPreview; stop: () => void }>();

/**
 * One preview computation per player, shared by every view that shows its
 * signal (waveforms, spectrograms, the card): each gets the latest preview
 * at once and every new one after. Returns an unsubscribe function.
 */
export function subscribeDspPreview(player: PreviewPlayer, listener: Publish): () => void {
    let hub = hubs.get(player);
    if (!hub) {
        const created = { subs: new Set<Publish>(), latest: { pyramid: null, gain: null, windowGain: null } as DspPreview, stop: (() => undefined) as () => void };
        hubs.set(player, created);
        created.stop = runPreview(player, (preview) => {
            created.latest = preview;
            for (const sub of [...created.subs]) sub(preview);
        });
        hub = created;
    }
    const h = hub;
    h.subs.add(listener);
    listener(h.latest);
    return () => {
        h.subs.delete(listener);
        if (h.subs.size === 0 && hubs.get(player) === h) {
            hubs.delete(player);
            h.stop();
        }
    };
}

/** Follow `player`'s waveform; `onPyramid` gets every new pyramid. Returns a stop function. */
export function followWaveform(player: PreviewPlayer, onPyramid: (pyramid: WaveformPeakPyramid | null) => void): () => void {
    let last: WaveformPeakPyramid | null | undefined;
    return subscribeDspPreview(player, ({ pyramid }) => {
        if (pyramid === last) return;
        last = pyramid;
        onPyramid(pyramid);
    });
}

function runPreview(player: PreviewPlayer, onPyramid: Publish): () => void {
    let mode: 'buffer' | 'segmented' | null = null;
    let stopMode: (() => void) | null = null;
    const sync = () => {
        const next = player.getState().sourceKind === 'segmented' ? 'segmented' : 'buffer';
        if (next === mode) return;
        stopMode?.();
        mode = next;
        stopMode = next === 'segmented' ? followSegmented(player, onPyramid) : followBuffer(player, onPyramid);
    };
    const unsubscribe = player.subscribe(sync);
    sync();
    return () => {
        unsubscribe();
        stopMode?.();
        stopMode = null;
    };
}

/** Peak pyramids of a decoded clip, recomputed in a worker as the DSP changes. */
function followBuffer(player: PreviewPlayer, onPyramid: Publish): () => void {
    let latest: WaveformPyramids = { source: null, processed: null };
    const analyzer = new WaveformAnalyzer((pyramids) => {
        latest = pyramids;
        onPyramid({ pyramid: latest.processed ?? latest.source, gain: latest.gain ?? null, windowGain: null });
    });
    let buffers: { a: AudioBuffer | null; b: AudioBuffer | null; clip: string | null } = { a: null, b: null, clip: null };
    let applied: WaveformProcessing | null = null;
    const sync = () => {
        const state = player.getState();
        const processing = processingOf(state);
        // While the next clip loads the buffer is briefly null: the previous
        // waveform stays until the new one is analysed.
        if (state.buffer && (state.buffer !== buffers.a || state.bufferB !== buffers.b || state.clipId !== buffers.clip)) {
            buffers = { a: state.buffer, b: state.bufferB, clip: state.clipId };
            applied = processing;
            analyzer.setBuffers(state.buffer, state.bufferB, processing);
        } else if (!sameProcessing(applied, processing)) {
            applied = processing;
            analyzer.setProcessing(processing);
        }
    };
    const unsubscribe = player.subscribe(sync);
    sync();
    return () => {
        unsubscribe();
        analyzer.dispose();
    };
}

/** Approximate preview over the stored peaks + exact preview of the decoded window. */
function followSegmented(player: PreviewPlayer, onPyramid: Publish): () => void {
    let approxGain: GainTrack | null = null;
    let sentSpectro: unknown = null;
    let sentB: unknown = null;
    let windowGain: GainTrack | null = null;
    let approx: WaveformPeakPyramid | null = null;
    let exact: WaveformPeakLevel[] = [];
    let applied: WaveformProcessing | null = null;
    let inputs: { peaks: WaveformPeakPyramid | null; bands: unknown } = { peaks: null, bands: null };
    let windowKey = '';
    let windowStart = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const publish = () => {
        if (!approx) {
            onPyramid({ pyramid: null, gain: null, windowGain: null });
            return;
        }
        if (exact.length === 0) {
            onPyramid({ pyramid: approx, gain: approxGain, windowGain: null });
            return;
        }
        // Finest first; at a tie the exact level wins (it is tried first).
        const levels = [...exact, ...approx.levels].sort((a, b) => a.binSize - b.binSize || (a.startBin === undefined ? 1 : -1));
        onPyramid({ pyramid: { totalSamples: approx.totalSamples, levels }, gain: approxGain, windowGain });
    };

    const analyzer = new WaveformAnalyzer(({ processed, source, gain }) => {
        windowGain = gain ? { ...gain, startFrame: windowStart } : null;
        const pyramid = processed ?? source;
        if (!pyramid || disposed) return;
        // Window-relative bins → partial levels at the window's place on the timeline;
        // levels with only a bin or two add nothing over the stored ones.
        exact = pyramid.levels
            .filter((level) => level.maxPeaks.length >= 4)
            .map((level) => ({ ...level, startBin: windowStart / level.binSize }));
        publish();
    });

    // The approximate preview over the whole clip runs in its own worker (≈ 0.1–0.25 s per change for an hour).
    const preview = new ApproxPreview((pyramid, gain) => {
        if (disposed) return;
        approx = pyramid;
        approxGain = gain;
        publish();
    });
    const recomputeApprox = () => {
        timer = null;
        if (!inputs.peaks) return;
        const state = player.getState();
        // Plugins with a magnitude response: their response at the prepared spectrogram's rows.
        const fx = previewSettings(state);
        const spectro = state.prepared?.spectrogram ?? null;
        let rowAmp: Float32Array | null = null;
        if (fx.lti.length > 0 && spectro) {
            if (spectro !== sentSpectro) {
                sentSpectro = spectro;
                const level = spectro.levels[0];
                preview.setSpectrogram({ a: level.a, hop: level.binSize, columns: level.frames, rows: spectro.rows, topDb: spectro.topDb, rangeDb: spectro.rangeDb, minHz: spectro.minHz, maxHz: spectro.maxHz });
            }
            const freqs = rowFrequencies(spectro.rows, spectro.minHz, spectro.maxHz);
            rowAmp = new Float32Array(spectro.rows).fill(1);
            for (const { plugin, params } of fx.lti) {
                try {
                    const db = plugin.preview!.magnitudeResponse!(params, freqs, spectro.sampleRate);
                    for (let r = 0; r < rowAmp.length; r += 1) rowAmp[r] *= Math.pow(10, (db[r] ?? 0) / 20);
                } catch {
                    // left out (the spectrogram warns)
                }
            }
        }
        preview.process(processingOf(state), rowAmp);
    };

    const syncWindow = () => {
        const audio = player.getWindowAudio?.() ?? null;
        if (!audio) {
            if (windowKey !== '') {
                windowKey = '';
                exact = [];
                windowGain = null;
                publish();
            }
            return;
        }
        if (audio.key === windowKey) return;
        windowKey = audio.key;
        windowStart = audio.startFrame;
        exact = [];
                windowGain = null;
        applied = processingOf(player.getState());
        analyzer.setBuffers(audio.buffer, audio.bufferB ?? null, applied);
    };

    const sync = () => {
        const state = player.getState();
        const processing = processingOf(state);
        const prepared = state.prepared;
        const changedInputs = prepared?.peaks !== inputs.peaks || prepared?.bands !== inputs.bands
            || (prepared?.spectrogram !== sentSpectro && previewSettings(state).lti.length > 0);
        if (changedInputs) {
            inputs = { peaks: prepared?.peaks ?? null, bands: prepared?.bands ?? null };
            if (prepared?.peaks) {
                preview.load(prepared.peaks, prepared.bands, state.manifest?.sampleRate ?? 48000);
                sentSpectro = null;
            }
            if (!prepared?.peaks) {
                approx = null;
                exact = [];
                windowGain = null;
                windowKey = '';
                publish();
            }
        }
        // Stem B's stored overview, once the mix has fetched it.
        const peaksB = prepared?.peaks ? prepared.peaksB ?? null : null;
        let changedB = false;
        if (peaksB !== sentB || (changedInputs && peaksB)) {
            sentB = peaksB;
            changedB = true;
            const stem = state.stem ? state.manifest?.stems?.[state.stem] : undefined;
            preview.setStemB(peaksB ? { stored: peaksB, bands: prepared?.bandsB ?? null, correlated: prepared?.correlated ?? true, gain: Math.pow(10, (stem?.gainDb ?? 0) / 20) } : null);
        }
        if (changedInputs || changedB || !sameProcessing(applied, processing)) {
            const processingChanged = !sameProcessing(applied, processing);
            applied = processing;
            // Debounced to a frame, like the worker's processed rebuild.
            if (!timer) timer = setTimeout(recomputeApprox, DEBOUNCE_MS);
            if (processingChanged && windowKey) analyzer.setProcessing(processing);
        }
        syncWindow();
    };

    const unsubscribe = player.subscribe(sync);
    const off = player.on?.('sourceupdate', () => sync()) ?? null;
    sync();
    return () => {
        disposed = true;
        unsubscribe();
        off?.();
        if (timer) clearTimeout(timer);
        analyzer.dispose();
        preview.dispose();
    };
}
