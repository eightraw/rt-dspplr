import { useEffect, useRef, type CSSProperties } from 'react';
import type { AudioPlayerCore } from '../core/AudioPlayer';
import { createSpectrogram, type SpectrogramOptions, type SpectrogramView } from '../core/spectrogram/SpectrogramView';
import type { UseAudioPlayerResult } from './useAudioPlayer';

// ---------------------------------------------------------------------------
// <Spectrogram /> — a canvas filling its box with the player's clip
// ---------------------------------------------------------------------------
//
// It follows the player's clip, stem B and mix. Give the box a size; the
// canvas recomputes at its pixel size. Playhead and seeking are left to the
// interface around it.

export interface SpectrogramProps extends SpectrogramOptions {
    player: AudioPlayerCore | UseAudioPlayerResult;
    /** Part of the clip to show, in seconds. Default: all of it. */
    range?: { start: number; end: number } | null;
    className?: string;
    style?: CSSProperties;
}

function resolveCore(player: AudioPlayerCore | UseAudioPlayerResult): AudioPlayerCore {
    return 'player' in player && typeof (player as UseAudioPlayerResult).state === 'object'
        ? (player as UseAudioPlayerResult).player
        : player as AudioPlayerCore;
}

export function Spectrogram({ player, range = null, className, style, ...options }: SpectrogramProps) {
    const core = resolveCore(player);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewRef = useRef<SpectrogramView | null>(null);
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const optionsKey = JSON.stringify(options);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const view = createSpectrogram(canvas, core, optionsRef.current);
        viewRef.current = view;
        return () => {
            view.dispose();
            if (viewRef.current === view) viewRef.current = null;
        };
    }, [core]);

    useEffect(() => {
        viewRef.current?.setOptions(optionsRef.current);
    }, [optionsKey]);

    useEffect(() => {
        viewRef.current?.setRange(range);
    }, [range?.start, range?.end]);

    return (
        <canvas
            ref={canvasRef}
            className={className}
            aria-hidden="true"
            style={{ display: 'block', width: '100%', height: '100%', ...style }}
        />
    );
}
