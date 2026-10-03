// A listening exercise: a phrase in a loop, slower speeds, and a button that
// plays the phrase again from its start ('reset' pause mode). A gentle
// high-pass and compression keep a recorded voice clear.

import { Timeline, useAudioPlayer } from '@saitdigital/rt-dspplr/react';
import { PlayIcon, useFileDrop, useSource } from '../shared';
import { describe, type CardProps } from '../source';
import './Lesson.css';

const SPEEDS = [0.75, 1, 1.25];

export function Lesson({ source, onFiles }: CardProps) {
    const player = useAudioPlayer({
        speeds: SPEEDS,
        prewarmSpeeds: [0.75, 1.25],
        pauseMode: 'reset',
        processing: { highPassHz: 120, compression: 0.5 },
    });
    // Start with a phrase-sized loop a little way into the file.
    useSource(player.player, source, false, (core) => {
        const duration = core.getState().duration;
        const start = Math.min(duration * 0.15, Math.max(0, duration - 3.4));
        core.setLoop({ start, end: Math.min(duration, start + 3.4) });
    });
    const drop = useFileDrop(onFiles);
    const { state } = player;
    const speed = state.pendingSpeed ?? state.processing.speed;

    return (
        <section className="g-card g-lesson" ref={player.ref} {...drop}>
            <div className="ls-head">
                <span className="ls-badge">LISTENING</span>
                <h3>{source ? describe(source.a).title : 'Your recording'}</h3>
                <p>Loop a phrase, slow it down, say it with the reader</p>
            </div>
            <div className="ls-wave">
                <Timeline player={player} waveformStyle="bars" ruler={false} wheelZoom="modifier" emptyText="Drop a file on this card" />
            </div>
            <div className="ls-controls">
                <button className="ls-play" aria-label={state.isPlaying ? 'Pause' : 'Play'} disabled={!source} onClick={() => void player.toggle()}>
                    <PlayIcon playing={state.isPlaying} />
                </button>
                <button className="ls-repeat" disabled={!source} onClick={() => void player.play()}>⟲ Repeat phrase</button>
                <div className="ls-speed" role="group" aria-label="Speed">
                    {SPEEDS.map((value) => (
                        <button key={value} className={speed === value ? 'is-on' : undefined} aria-pressed={speed === value} disabled={!source} onClick={() => void player.setSpeed(value)}>
                            {value}×
                        </button>
                    ))}
                </div>
                <span className="ls-note">Clean voice · high-pass + compression</span>
            </div>
        </section>
    );
}
