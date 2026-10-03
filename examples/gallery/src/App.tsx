// Five interfaces on one engine. No audio ships with the gallery: choose files,
// or drop them on the page (all cards) or on one card (that card only).

import { useCallback, useState, type ChangeEvent } from 'react';
import { Editorial } from './designs/Editorial';
import { Lesson } from './designs/Lesson';
import { NowPlaying } from './designs/NowPlaying';
import { StudioAB } from './designs/StudioAB';
import { VoiceNote } from './designs/VoiceNote';
import { pickFiles, useFileDrop } from './shared';
import { sourceOf, type Source } from './source';

const CARDS = [
    { id: 'voice', Card: VoiceNote },
    { id: 'now-playing', Card: NowPlaying },
    { id: 'studio', Card: StudioAB },
    { id: 'editorial', Card: Editorial },
    { id: 'lesson', Card: Lesson },
] as const;

type CardId = (typeof CARDS)[number]['id'];
type Sources = Partial<Record<CardId, Source | null>>;

export default function App() {
    const [sources, setSources] = useState<Sources>({});

    const loadAll = useCallback((files: File[]) => {
        const source = sourceOf(files);
        setSources(Object.fromEntries(CARDS.map(({ id }) => [id, source])));
    }, []);
    const loadOne = (id: CardId) => (files: File[]) => setSources((current) => ({ ...current, [id]: sourceOf(files) }));
    const drop = useFileDrop(loadAll);

    const onChoose = (event: ChangeEvent<HTMLInputElement>) => {
        const files = pickFiles(event.currentTarget.files);
        if (files.length > 0) loadAll(files);
        event.currentTarget.value = '';
    };

    return (
        <div className="page" {...drop}>
            <header className="page-head">
                <h1>RT-DSPPLR gallery</h1>
                <p>
                    Five interfaces built on <code>useAudioPlayer()</code> and <code>&lt;Timeline&gt;</code>.
                    Choose an audio file, or drop it on the page. Drop on a card to change that card only.
                    Two files at once: the second becomes stem B for the stem comparison.
                </p>
                <label className="pick">
                    Choose audio…
                    <input type="file" accept="audio/*" multiple onChange={onChoose} />
                </label>
            </header>
            <main className="cards">
                {CARDS.map(({ id, Card }) => (
                    <Card key={id} source={sources[id] ?? null} onFiles={loadOne(id)} />
                ))}
            </main>
        </div>
    );
}
