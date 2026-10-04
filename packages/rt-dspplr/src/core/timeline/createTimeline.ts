import type { AudioPlayerCore, AudioPlayerState } from '../AudioPlayer';
import { outputGainDbToGain } from '../controls';
import type { SpectrogramOptions } from '../spectrogram/SpectrogramView';
import { WaveformAnalyzer } from '../waveform/WaveformAnalyzer';
import type { WaveformPeakPyramid } from '../waveform/pyramid';
import type { WaveformProcessing } from '../waveform/types';
import { TimelineCore, type TimelineDisplay } from './TimelineCore';

// ---------------------------------------------------------------------------
// createTimeline — the seek bar of the React card, for any framework.
// ---------------------------------------------------------------------------
//
// Builds a `.rtd.rtd-timeline` element in the container given and keeps it in
// step with the player: the waveform (computed in a worker, following the
// DSP), the spectrogram, the playhead, the loop, zoom and pan. It fills the
// box it is given. The stylesheet (`@saitdigital/rt-dspplr/styles.css`) styles
// it, and the `--rtd-*` tokens theme it.

export interface TimelineOptions {
    /** 'waveform' (default), 'spectrogram', or 'both': the waveform as an outline over the spectrogram. */
    display?: TimelineDisplay;
    /** 'envelope' (default) or 'bars'. */
    waveformStyle?: 'envelope' | 'bars';
    /** Colours and axis of the spectrogram. */
    spectrogram?: SpectrogramOptions;
    /** 'modifier' (default): Ctrl/Cmd + wheel zooms, the wheel alone scrolls the page. 'plain': the wheel alone zooms. */
    wheelZoom?: 'plain' | 'modifier';
    /** Zoom and pan with the wheel, the keys and the overview strip. Default true. */
    zoom?: boolean;
    /** Time ruler and zoom overview under the track. Default true. */
    ruler?: boolean;
    /** 'light' (default), 'dark', or 'auto' (follows prefers-color-scheme). */
    theme?: 'light' | 'dark' | 'auto';
    /** Accessible name of the seek slider. Default 'Seek'. */
    label?: string;
    /** Shown in the track before a clip. Default 'No audio loaded'. */
    emptyText?: string;
    /** Called when the listener moves the playhead (click, drag, keyboard). */
    onSeek?: (seconds: number) => void;
}

export interface TimelineView {
    /** The `.rtd.rtd-timeline` element. */
    readonly element: HTMLElement;
    /** Change any option; the others keep their values. */
    setOptions(options: TimelineOptions): void;
    /** Redraw with the current colours, after you changed the `--rtd-*` tokens. */
    refreshColors(): void;
    /** Stop following the player and remove the element. */
    dispose(): void;
}

/** Peak pyramids of the player's clip, recomputed in a worker as the DSP changes. */
function followWaveform(player: AudioPlayerCore, onPyramid: (pyramid: WaveformPeakPyramid | null) => void): () => void {
    let latest: { source: WaveformPeakPyramid | null; processed: WaveformPeakPyramid | null } = { source: null, processed: null };
    const analyzer = new WaveformAnalyzer((pyramids) => {
        latest = pyramids;
        onPyramid(latest.processed ?? latest.source);
    });
    const processingOf = (state: AudioPlayerState): WaveformProcessing => ({
        highPassHz: state.processing.highPassHz,
        compression: state.processing.compression,
        outputGain: outputGainDbToGain(state.processing.outputGainDb),
        mix: state.processing.mix,
        mixLaw: state.mixLaw,
    });
    let buffers: { a: AudioBuffer | null; b: AudioBuffer | null; clip: string | null } = { a: null, b: null, clip: null };
    let applied: WaveformProcessing | null = null;
    const same = (a: WaveformProcessing | null, b: WaveformProcessing) => a !== null
        && a.highPassHz === b.highPassHz && a.compression === b.compression && a.outputGain === b.outputGain
        && a.mix === b.mix && a.mixLaw === b.mixLaw;
    const sync = () => {
        const state = player.getState();
        const processing = processingOf(state);
        // While the next clip loads the buffer is briefly null: the previous
        // waveform stays until the new one is analysed.
        if (state.buffer && (state.buffer !== buffers.a || state.bufferB !== buffers.b || state.clipId !== buffers.clip)) {
            buffers = { a: state.buffer, b: state.bufferB, clip: state.clipId };
            applied = processing;
            analyzer.setBuffers(state.buffer, state.bufferB, processing);
        } else if (!same(applied, processing)) {
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

export function createTimeline(container: HTMLElement, player: AudioPlayerCore, options: TimelineOptions = {}): TimelineView {
    const doc = container.ownerDocument;
    const root = doc.createElement('div');
    root.className = 'rtd rtd-timeline';
    container.append(root);
    const view = mountTimeline(root, player, options);
    let theme = options.theme ?? 'light';
    root.dataset.theme = theme;

    return {
        element: root,
        setOptions(next) {
            if (next.theme !== undefined && next.theme !== theme) {
                theme = next.theme;
                root.dataset.theme = theme;
                view.refreshColors();
            }
            view.setOptions(next);
        },
        refreshColors: () => view.refreshColors(),
        dispose() {
            view.dispose();
            root.remove();
        },
    };
}

/**
 * The timeline inside an element you made yourself (the React `<Timeline>` uses this
 * for its own root). Theme attributes and classes on that element stay yours.
 */
export function mountTimeline(root: HTMLElement, player: AudioPlayerCore, options: TimelineOptions = {}): Omit<TimelineView, 'element'> {
    let current: TimelineOptions = { ...options };
    const inputOf = (state: AudioPlayerState) => ({
        hasAudio: state.clipId !== null,
        duration: state.duration,
        loop: state.loop,
        loading: state.status === 'loading',
    });
    const display = () => current.display ?? 'waveform';

    const state = player.getState();
    const box = root.ownerDocument.createElement('div');
    root.append(box);
    const timeline = new TimelineCore(box, player, {
        ...inputOf(state),
        pyramid: null,
        label: current.label ?? 'Seek',
        emptyText: current.emptyText ?? 'No audio loaded',
        display: display(),
        waveformStyle: current.waveformStyle ?? 'envelope',
        spectrogram: current.spectrogram,
        wheelZoom: current.wheelZoom ?? 'modifier',
        zoomable: current.zoom ?? true,
        ruler: current.ruler ?? true,
    }, (seconds) => current.onSeek?.(seconds));

    // A theme that follows the system scheme needs the canvases redrawn when it
    // flips; the colours are read from the stylesheet at draw time.
    const scheme = root.ownerDocument.defaultView?.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    const onScheme = () => timeline.refreshColors();
    scheme?.addEventListener?.('change', onScheme);

    // The waveform worker runs only while a waveform is drawn.
    let stopWaveform: (() => void) | null = null;
    const syncWaveform = () => {
        const wanted = display() !== 'spectrogram';
        if (wanted && !stopWaveform) stopWaveform = followWaveform(player, (pyramid) => timeline.update({ pyramid }));
        if (!wanted && stopWaveform) {
            stopWaveform();
            stopWaveform = null;
            timeline.update({ pyramid: null });
        }
    };
    syncWaveform();

    // The playhead: from the state while stopped, from the clock every frame while playing.
    let frame = 0;
    let clipKey = `${state.clipId ?? ''}:${state.playRequestId}`;
    const tick = () => {
        const s = player.getState();
        timeline.setTime(Math.min(player.getCurrentTime(), s.duration), true);
        frame = requestAnimationFrame(tick);
    };
    const onState = () => {
        const s = player.getState();
        timeline.update(inputOf(s));
        const key = `${s.clipId ?? ''}:${s.playRequestId}`;
        if (key !== clipKey) {
            clipKey = key;
            timeline.resetView();
        }
        if (s.isPlaying) {
            if (!frame) frame = requestAnimationFrame(tick);
        } else {
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
            timeline.setTime(s.clipId !== null ? s.currentTime : 0, false);
        }
    };
    const unsubscribe = player.subscribe(onState);
    onState();

    return {
        setOptions(next) {
            current = { ...current, ...next };
            timeline.update({
                label: current.label ?? 'Seek',
                emptyText: current.emptyText ?? 'No audio loaded',
                display: display(),
                waveformStyle: current.waveformStyle ?? 'envelope',
                spectrogram: current.spectrogram,
                wheelZoom: current.wheelZoom ?? 'modifier',
                zoomable: current.zoom ?? true,
                ruler: current.ruler ?? true,
            });
            syncWaveform();
        },
        refreshColors: () => timeline.refreshColors(),
        dispose() {
            scheme?.removeEventListener?.('change', onScheme);
            unsubscribe();
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
            stopWaveform?.();
            stopWaveform = null;
            timeline.dispose();
            box.remove();
        },
    };
}
