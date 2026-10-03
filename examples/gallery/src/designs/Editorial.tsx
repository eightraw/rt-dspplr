// An editorial layout: a large timecode, text links for the transport, a
// four-second loop and a high-pass that the waveform shows as you hear it.

import { Timeline, useAudioPlayer } from '@saitdigital/rt-dspplr/react';
import { clock, useFileDrop, useNow, useSource } from '../shared';
import { describe, formatSize, type CardProps } from '../source';
import './Editorial.css';

export function Editorial({ source, onFiles }: CardProps) {
    const player = useAudioPlayer({ prewarmSpeeds: false });
    useSource(player.player, source);
    const now = useNow(player.player);
    const drop = useFileDrop(onFiles);
    const { state } = player;
    const looping = state.loop !== null;
    const highPassOn = state.processing.highPassHz > 0;
    const info = source ? describe(source.a) : null;

    return (
        <section className="g-card g-ed" ref={player.ref} {...drop}>
            <div className="ed-top">
                <div className="ed-tc">{clock(now, true)}</div>
                <div className="ed-title">
                    <em>{info?.title ?? 'No file yet'}</em>
                    <span>{source ? info?.artist ?? formatSize(source.a.size) : 'Drop one on this card'}</span>
                </div>
            </div>
            <div className="ed-wave"><Timeline player={player} emptyText="" /></div>
            <nav className="ed-links">
                <button disabled={!source} onClick={() => void player.toggle()}>{state.isPlaying ? 'Pause' : 'Play'}</button>
                <button disabled={!source} onClick={() => player.setLoop(looping ? null : { start: now, end: Math.min(state.duration, now + 4) })}>
                    {looping ? 'Unloop' : 'Loop 4 s'}
                </button>
                <button disabled={!source} onClick={() => player.setHighPass(highPassOn ? 0 : 180)}>High-pass {highPassOn ? 'on' : 'off'}</button>
                <span>The waveform shows the high-pass as you hear it</span>
            </nav>
        </section>
    );
}
