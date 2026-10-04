import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { LoopRange } from '../core/engine';
import type { AudioPlayerCore } from '../core/AudioPlayer';
import type { SpectrogramOptions } from '../core/spectrogram/SpectrogramView';
import type { WaveformPeakPyramid } from '../core/waveform/pyramid';
import { TimelineCore, type TimelineCoreInput } from '../core/timeline/TimelineCore';

// ---------------------------------------------------------------------------
// Scrubber — the card's seek bar: the core timeline, driven by the card.
//
// Everything it does (seek, loops, zoom, pan, keys, ruler, overview) lives in
// TimelineCore. The card hands it the clip's facts as props and moves the
// playhead through setTime() from its own animation frame, beside the time
// readout.
// ---------------------------------------------------------------------------

// Built before the first paint, so the card never shows an empty seek bar; plain
// effects during SSR, where React warns about layout ones.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface ScrubberHandle {
    setTime(seconds: number, following: boolean): void;
}

interface ScrubberProps {
    core: AudioPlayerCore;
    hasAudio: boolean;
    duration: number;
    loop: LoopRange | null;
    pyramid: WaveformPeakPyramid | null;
    /** Changes whenever colours may have changed (theme switch). */
    paletteKey: string;
    loading: boolean;
    emptyText: string;
    /** Resets zoom when it changes. */
    resetKey: string;
    /** Called when the user moved the playhead (for the time readout). */
    onUserSeek: (seconds: number) => void;
    label: string;
    display: 'waveform' | 'spectrogram' | 'both';
    waveformStyle: 'envelope' | 'bars';
    spectrogram?: SpectrogramOptions;
    wheelZoom: 'plain' | 'modifier';
    zoomable: boolean;
    ruler: boolean;
}

export const Scrubber = forwardRef<ScrubberHandle, ScrubberProps>(function Scrubber(props, ref) {
    const boxRef = useRef<HTMLDivElement | null>(null);
    const timelineRef = useRef<TimelineCore | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const { core, resetKey, paletteKey } = props;
    const input: TimelineCoreInput = {
        hasAudio: props.hasAudio,
        duration: props.duration,
        loop: props.loop,
        pyramid: props.pyramid,
        loading: props.loading,
        label: props.label,
        emptyText: props.emptyText,
        display: props.display,
        waveformStyle: props.waveformStyle,
        spectrogram: props.spectrogram,
        wheelZoom: props.wheelZoom,
        zoomable: props.zoomable,
        ruler: props.ruler,
    };
    const inputRef = useRef(input);
    inputRef.current = input;

    useIsomorphicLayoutEffect(() => {
        const box = boxRef.current;
        if (!box) return undefined;
        const timeline = new TimelineCore(box, core, inputRef.current, (seconds) => propsRef.current.onUserSeek(seconds));
        timelineRef.current = timeline;
        return () => {
            timeline.dispose();
            if (timelineRef.current === timeline) timelineRef.current = null;
        };
    }, [core]);

    // Every render hands the props over; the timeline does nothing when none changed.
    useIsomorphicLayoutEffect(() => {
        timelineRef.current?.update(input);
    });

    // A new clip or a restart, and a theme change: skipped on mount, where they change nothing.
    const seen = useRef({ resetKey, paletteKey });
    useEffect(() => {
        if (seen.current.resetKey === resetKey) return;
        seen.current.resetKey = resetKey;
        timelineRef.current?.resetView();
    }, [resetKey]);
    useEffect(() => {
        if (seen.current.paletteKey === paletteKey) return;
        seen.current.paletteKey = paletteKey;
        timelineRef.current?.refreshColors();
    }, [paletteKey]);

    useImperativeHandle(ref, () => ({
        setTime(seconds: number, following: boolean) {
            timelineRef.current?.setTime(seconds, following);
        },
    }), []);

    return <div ref={boxRef} className="rtd-wavebox" />;
});
