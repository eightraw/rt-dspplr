import { useEffect, useRef, type CSSProperties } from 'react';
import type { AudioPlayerCore } from '../core/AudioPlayer';
import type { SpectrogramOptions } from '../core/spectrogram/SpectrogramView';
import { mountTimeline, type TimelineOptions } from '../core/timeline/createTimeline';
import type { UseAudioPlayerResult } from './useAudioPlayer';

// ---------------------------------------------------------------------------
// <Timeline /> — the card's seek bar on its own, for interfaces of your own
// ---------------------------------------------------------------------------
//
// Click to seek, drag to loop (with handles), wheel to zoom, Shift + wheel or
// the overview strip to pan, keyboard for all of it, and a time ruler. It
// draws the waveform, the spectrogram, or both, and fills the box you give it.
// Import the stylesheet once; the --rtd-* tokens theme it. Without React the
// same timeline is createTimeline() from the main entry.

export interface TimelineProps {
    player: AudioPlayerCore | UseAudioPlayerResult;
    /** 'waveform' (default), 'spectrogram', or 'both': the waveform as an outline over the spectrogram. */
    display?: 'waveform' | 'spectrogram' | 'both';
    /** Look of the waveform: 'envelope' (default) or 'bars'. */
    waveformStyle?: 'envelope' | 'bars';
    /** Colours and axis of the spectrogram. */
    spectrogram?: SpectrogramOptions;
    /** 'plain' (default): the wheel alone zooms. 'modifier': only Ctrl/Cmd + wheel zooms, the wheel alone scrolls the page. */
    wheelZoom?: 'plain' | 'modifier';
    /**
     * Zoom and pan with the wheel, the keys and the overview strip. Default true.
     * false: the track always shows the whole clip and the wheel scrolls the page.
     */
    zoom?: boolean;
    /** Time ruler and zoom overview under the track. Default true. */
    ruler?: boolean;
    /** Default 'light'. 'auto' follows prefers-color-scheme. */
    theme?: 'light' | 'dark' | 'auto';
    /** Accessible name of the seek slider. Default 'Seek'. */
    label?: string;
    /** Shown in the track when nothing is loaded. */
    emptyText?: string;
    /** Called when the listener moves the playhead (click, drag, keyboard). */
    onSeek?: (seconds: number) => void;
    className?: string;
    style?: CSSProperties;
}

function resolveCore(player: AudioPlayerCore | UseAudioPlayerResult): AudioPlayerCore {
    return 'player' in player && typeof (player as UseAudioPlayerResult).state === 'object'
        ? (player as UseAudioPlayerResult).player
        : player as AudioPlayerCore;
}

export function Timeline({
    player,
    display = 'waveform',
    waveformStyle = 'envelope',
    spectrogram,
    wheelZoom = 'plain',
    zoom = true,
    ruler = true,
    theme = 'light',
    label = 'Seek',
    emptyText = 'No audio loaded',
    onSeek,
    className,
    style,
}: TimelineProps) {
    const core = resolveCore(player);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<ReturnType<typeof mountTimeline> | null>(null);
    const onSeekRef = useRef(onSeek);
    onSeekRef.current = onSeek;
    const options: TimelineOptions = {
        display,
        waveformStyle,
        spectrogram,
        wheelZoom,
        zoom,
        ruler,
        label,
        emptyText,
        onSeek: (seconds) => onSeekRef.current?.(seconds),
    };
    const optionsRef = useRef(options);
    optionsRef.current = options;

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return undefined;
        const view = mountTimeline(root, core, optionsRef.current);
        viewRef.current = view;
        return () => {
            view.dispose();
            if (viewRef.current === view) viewRef.current = null;
        };
    }, [core]);

    const spectrogramKey = JSON.stringify(spectrogram ?? {});
    useEffect(() => {
        viewRef.current?.setOptions(optionsRef.current);
    }, [display, waveformStyle, spectrogramKey, wheelZoom, zoom, ruler, label, emptyText]);

    // The canvases read the theme's colours when they draw.
    useEffect(() => {
        viewRef.current?.refreshColors();
    }, [theme]);

    return (
        <div
            ref={rootRef}
            className={className ? `rtd rtd-timeline ${className}` : 'rtd rtd-timeline'}
            data-theme={theme}
            style={style}
        />
    );
}
