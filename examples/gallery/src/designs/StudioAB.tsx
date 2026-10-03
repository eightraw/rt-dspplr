// A stem comparison panel: the spectrogram of both stems with the waveform over
// it, A and B buttons around the mix slider, a loop, and a level meter.
// Drop two files at once: the second one is stem B.

import { useRef, useState } from 'react';
import { Timeline, useAudioPlayer } from '@saitdigital/rt-dspplr/react';
import { clock, PlayIcon, useFileDrop, useNow, useOutputLevel, useSource } from '../shared';
import { describe, type CardProps } from '../source';
import './StudioAB.css';

type MixLaw = 'crossfade' | 'separation';

const stemLabel = (file: File | null | undefined, fallback: string) =>
    (file ? describe(file).title : fallback).toUpperCase().slice(0, 16);

export function StudioAB(props: CardProps) {
    // The mix law is read when the player is created, so a change remounts the panel.
    const [law, setLaw] = useState<MixLaw>('crossfade');
    return <StudioPanel key={law} {...props} law={law} onLawChange={setLaw} />;
}

function StudioPanel({ source, onFiles, law, onLawChange }: CardProps & { law: MixLaw; onLawChange: (law: MixLaw) => void }) {
    const player = useAudioPlayer({
        prewarmSpeeds: false,
        mixLaw: law,
        prefetchB: true,
        processing: { mix: law === 'separation' ? 0.5 : 0 },
    });
    useSource(player.player, source, true);
    const now = useNow(player.player);
    const drop = useFileDrop(onFiles);
    const { state } = player;

    const meter = useRef<HTMLSpanElement | null>(null);
    useOutputLevel(player.player, (rms) => {
        const db = 20 * Math.log10(rms + 1e-6);
        if (meter.current) meter.current.style.width = `${Math.max(0, Math.min(100, ((db + 48) / 48) * 100))}%`;
    });

    const mix = state.processing.mix;
    const hasB = !!source?.b;
    const looping = state.loop !== null;
    const file = source
        ? `${source.a.name}${source.b ? ` + ${source.b.name}` : ''} · ${source.b ? '2 stems' : '1 stem'}`
        : 'Drop one file, or two at once for stem B';

    return (
        <section className="g-card g-studio" ref={player.ref} {...drop}>
            <header className="st-head">
                <span className="st-title">STEM COMPARE</span>
                <span className="st-file">{file}</span>
                <span className="st-tc">{clock(now, true)}</span>
                {/* The player puts its ⓘ button here, at the end of the header. */}
                <span className="st-credit" data-rtd-credit="" />
            </header>
            <div className="st-view">
                <Timeline player={player} display="both" spectrogram={{ colorMode: 'dual' }} theme="dark" emptyText="No audio yet" />
            </div>
            <footer className="st-foot">
                <button className="st-btn st-play" aria-label={state.isPlaying ? 'Pause' : 'Play'} disabled={!source} onClick={() => void player.toggle()}>
                    <PlayIcon playing={state.isPlaying} />
                </button>
                <button
                    className={looping ? 'st-btn is-on' : 'st-btn'}
                    disabled={!source}
                    onClick={() => player.setLoop(looping ? null : { start: now, end: Math.min(state.duration, now + 3) })}
                >
                    LOOP
                </button>
                <div className="st-ab">
                    <button className={mix <= 0 ? 'is-on is-a' : 'is-a'} disabled={!hasB} onClick={() => player.setMix(0)}>A · {stemLabel(source?.a, 'STEM A')}</button>
                    <input
                        type="range"
                        aria-label="Mix"
                        min={0}
                        max={100}
                        value={Math.round(mix * 100)}
                        disabled={!hasB}
                        onChange={(event) => player.setMix(Number(event.currentTarget.value) / 100)}
                    />
                    <button className={mix >= 1 ? 'is-on is-b' : 'is-b'} disabled={!hasB} onClick={() => player.setMix(1)}>B · {stemLabel(source?.b, 'STEM B')}</button>
                </div>
                <div className="st-law" role="group" aria-label="Mix law">
                    {(['crossfade', 'separation'] as const).map((value) => (
                        <button key={value} className={law === value ? 'is-on' : undefined} aria-pressed={law === value} onClick={() => onLawChange(value)}>
                            {value.toUpperCase()}
                        </button>
                    ))}
                </div>
                <div className="st-meter"><span ref={meter} /></div>
            </footer>
        </section>
    );
}
