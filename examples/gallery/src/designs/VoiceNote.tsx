// A voice message bubble: bars, the duration, and a speed button that cycles 1×, 1.5×, 2×.

import { Timeline, useAudioPlayer } from '@saitdigital/rt-dspplr/react';
import { clock, PlayIcon, useFileDrop, useNow, useSource } from '../shared';
import type { CardProps } from '../source';
import './VoiceNote.css';

const SPEEDS = [1, 1.5, 2];

export function VoiceNote({ source, onFiles }: CardProps) {
    const player = useAudioPlayer({ speeds: SPEEDS, prewarmSpeeds: [1.5, 2] });
    useSource(player.player, source);
    const now = useNow(player.player);
    const drop = useFileDrop(onFiles);
    const { state } = player;
    const speed = state.pendingSpeed ?? state.processing.speed;
    const stamp = source
        ? new Date(source.a.lastModified).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

    return (
        <section className="g-card g-voice-wrap" ref={player.ref} {...drop}>
            <div className="g-voice">
                <button className="vn-play" aria-label={state.isPlaying ? 'Pause' : 'Play'} disabled={!source} onClick={() => void player.toggle()}>
                    <PlayIcon playing={state.isPlaying} />
                </button>
                <div className="vn-body">
                    <div className="vn-wave">
                        <Timeline player={player} waveformStyle="bars" ruler={false} zoom={false} label="Voice message" emptyText="Drop a file here" />
                    </div>
                    <div className="vn-meta">
                        <span>{clock(state.isPlaying ? now : state.duration)}</span>
                        <button className="vn-speed" disabled={!source} onClick={() => void player.setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}>
                            {speed}×
                        </button>
                    </div>
                </div>
            </div>
            <span className="vn-stamp">{stamp}</span>
        </section>
    );
}
