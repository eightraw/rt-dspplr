import type { AudioPlayerState } from '../AudioPlayer';
import type { SpectrogramOptions } from '../spectrogram/SpectrogramView';
import { followWaveform } from '../waveform/followWaveform';
import { TimelineCore, type TimelineDisplay, type TimelinePlayer } from './TimelineCore';

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
    /** 'plain' (default): the wheel alone zooms. 'modifier': only Ctrl/Cmd + wheel zooms, the wheel alone scrolls the page. */
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


/** What identifies the clip a timeline shows: a new value resets its view. */
export function clipIdentity(state: AudioPlayerState): string {
    return `${state.clipId ?? ''}|${state.src ?? ''}|${state.sourceKind ?? ''}`;
}

export function createTimeline(container: HTMLElement, player: TimelinePlayer, options: TimelineOptions = {}): TimelineView {
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
export function mountTimeline(root: HTMLElement, player: TimelinePlayer, options: TimelineOptions = {}): Omit<TimelineView, 'element'> {
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
        wheelZoom: current.wheelZoom ?? 'plain',
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
    // The view (zoom, pan, a draft loop) belongs to the clip: it is reset only when
    // another clip comes, never by play, pause, seek, speed, loops or a restart.
    let clipKey = clipIdentity(state);
    const tick = () => {
        const s = player.getState();
        timeline.setTime(Math.min(player.getCurrentTime(), s.duration), true);
        frame = requestAnimationFrame(tick);
    };
    const onState = () => {
        const s = player.getState();
        timeline.update(inputOf(s));
        const key = clipIdentity(s);
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
                wheelZoom: current.wheelZoom ?? 'plain',
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
