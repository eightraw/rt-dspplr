// A now-playing card whose colours breathe with the music: the output level,
// fast up and slow down, lights the cover and the background.

import { useCallback, useRef } from 'react';
import { Timeline, useAudioPlayer } from '@saitdigital/rt-dspplr/react';
import { clock, PlayIcon, useFileDrop, useNow, useOutputLevel, useSource } from '../shared';
import { describe, type CardProps } from '../source';
import './NowPlaying.css';

export function NowPlaying({ source, onFiles }: CardProps) {
    const player = useAudioPlayer();
    useSource(player.player, source);
    const now = useNow(player.player);
    const drop = useFileDrop(onFiles);
    const { state } = player;

    // The card element is the player's interface root and also carries the level.
    const card = useRef<HTMLElement | null>(null);
    const { ref: mount } = player;
    const ref = useCallback((element: HTMLElement | null) => {
        card.current = element;
        mount(element);
    }, [mount]);

    const level = useRef(0);
    useOutputLevel(player.player, (rms) => {
        const target = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-6) + 21) / 12));
        level.current = target > level.current
            ? level.current + (target - level.current) * 0.6
            : level.current * 0.88 + target * 0.12;
        card.current?.style.setProperty('--np-level', level.current.toFixed(3));
    });

    const info = source ? describe(source.a) : null;

    return (
        <section className="g-card g-np" ref={ref} {...drop}>
            <div className="np-art"><span>{info ? info.title.slice(0, 1).toUpperCase() : '♪'}</span></div>
            <div className="np-body">
                <div className="np-eyebrow">Now playing</div>
                <div className="np-title">{info?.title ?? 'Nothing yet'}</div>
                <div className="np-artist">{info ? info.artist ?? 'From your device' : 'Drop a file on this card'}</div>
                <div className="np-wave"><Timeline player={player} ruler={false} zoom={false} theme="dark" emptyText="" /></div>
                <div className="np-row">
                    <span className="np-time">{clock(now)}</span>
                    <div className="np-controls">
                        <button aria-label="Back 10 seconds" disabled={!source} onClick={() => void player.seek(Math.max(0, now - 10))}>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 6 4 12l7 6V6Zm9 0-7 6 7 6V6Z" /></svg>
                        </button>
                        <button className="np-play" aria-label={state.isPlaying ? 'Pause' : 'Play'} disabled={!source} onClick={() => void player.toggle()}>
                            <PlayIcon playing={state.isPlaying} />
                        </button>
                        <button aria-label="Forward 10 seconds" disabled={!source} onClick={() => void player.seek(Math.min(state.duration, now + 10))}>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 6 7 6-7 6V6ZM4 6l7 6-7 6V6Z" /></svg>
                        </button>
                    </div>
                    <span className="np-time">{clock(state.duration)}</span>
                </div>
            </div>
        </section>
    );
}
