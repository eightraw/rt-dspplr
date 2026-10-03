import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { AudioPlayerCore } from '../core/AudioPlayer';
import type { SpectrogramOptions } from '../core/spectrogram/SpectrogramView';
import { Scrubber, type ScrubberHandle } from './Scrubber';
import { useAudioPlayerState, type UseAudioPlayerResult } from './useAudioPlayer';
import { useWaveform } from './useWaveform';

// ---------------------------------------------------------------------------
// <Timeline /> — the card's seek bar on its own, for interfaces of your own
// ---------------------------------------------------------------------------
//
// Click to seek, drag to loop (with handles), wheel to zoom, Shift + wheel or
// the overview strip to pan, keyboard for all of it, and a time ruler. It
// draws the waveform, the spectrogram, or both, and fills the box you give it.
// Import the stylesheet once; the --rtd-* tokens theme it.

export interface TimelineProps {
    player: AudioPlayerCore | UseAudioPlayerResult;
    /** 'waveform' (default), 'spectrogram', or 'both': the waveform as an outline over the spectrogram. */
    display?: 'waveform' | 'spectrogram' | 'both';
    /** Look of the waveform: 'envelope' (default) or 'bars'. */
    waveformStyle?: 'envelope' | 'bars';
    /** Colours and axis of the spectrogram. */
    spectrogram?: SpectrogramOptions;
    /** 'plain' (default): the wheel zooms. 'modifier': only Ctrl/Cmd + wheel, so the page keeps scrolling. */
    wheelZoom?: 'plain' | 'modifier';
    /**
     * Zoom and pan with the wheel, a pinch, the keys and the overview strip. Default true.
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
    emptyText?: ReactNode;
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

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

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
    const state = useAudioPlayerState(core);
    const pyramid = useWaveform(state, display !== 'spectrogram');
    const scrubberRef = useRef<ScrubberHandle>(null);
    const hasAudio = state.clipId !== null;
    const onSeekRef = useRef(onSeek);
    onSeekRef.current = onSeek;

    // The playhead is moved from an animation frame while playing, outside React.
    useIsomorphicLayoutEffect(() => {
        if (!state.isPlaying) scrubberRef.current?.setTime(hasAudio ? state.currentTime : 0, false);
    }, [state.currentTime, state.isPlaying, hasAudio]);

    useEffect(() => {
        if (!state.isPlaying) return undefined;
        let frame = 0;
        const tick = () => {
            scrubberRef.current?.setTime(Math.min(core.getCurrentTime(), core.getState().duration), true);
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [state.isPlaying, core]);

    const onUserSeek = useCallback((seconds: number) => onSeekRef.current?.(seconds), []);

    return (
        <div className={className ? `rtd rtd-timeline ${className}` : 'rtd rtd-timeline'} data-theme={theme} style={style}>
            <Scrubber
                ref={scrubberRef}
                core={core}
                hasAudio={hasAudio}
                duration={state.duration}
                loop={state.loop}
                pyramid={hasAudio ? pyramid : null}
                paletteKey={theme}
                loading={state.status === 'loading'}
                emptyText={emptyText}
                resetKey={`${state.clipId ?? ''}:${state.playRequestId}`}
                onUserSeek={onUserSeek}
                label={label}
                display={display}
                waveformStyle={waveformStyle}
                spectrogram={spectrogram}
                wheelZoom={wheelZoom}
                zoomable={zoom}
                ruler={ruler}
            />
        </div>
    );
}
