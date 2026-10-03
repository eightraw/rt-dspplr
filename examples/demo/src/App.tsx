// Example page: the bucket's clips on the left, the library's <AudioPlayer />
// card on the right (controlled with useAudioPlayer()), plus the code that
// renders it, generated from the current settings.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clearAudioCache, getAudioCacheStats, type AudioPlayerOptions } from '@saitdigital/rt-dspplr';
import { AudioPlayer, useAudioPlayer } from '@saitdigital/rt-dspplr/react';
import { rubberbandStretcher } from '@saitdigital/rt-dspplr/stretch-rubberband';
import type { Clip } from './types';
import { STORAGE_BUCKET, uploadToStorage, useStorageClips } from './storageClient';
import { ClipList, type ClipListHandle } from './ClipList';
import { useClipDurations } from './useClipDurations';
import { useAutoAdvance } from './useAutoAdvance';
import { displayName, formatTimestamp } from './format';
import { LicensePanel } from './LicensePanel';

type Engine = 'vocoder' | 'rubberband' | 'native';
type Theme = 'light' | 'dark' | 'auto';

const ENGINE_KEY = 'rtd-demo:engine';
const THEME_KEY = 'rtd-demo:theme';
const AUTO_PLAY_KEY = 'rtd-demo:autoplay';
const UPLOADABLE = /\.(wav|wave|mp3|ogg|oga|opus|m4a|mp4|aac|flac|webm|json)$/i;

const ENGINES: { value: Engine; label: string; hint: string }[] = [
    { value: 'vocoder', label: 'Built-in vocoder', hint: 'Phase vocoder in a worker, pitch preserved' },
    { value: 'rubberband', label: 'Rubber Band', hint: 'Optional entry, GPL, WASM loaded on first use' },
    { value: 'native', label: 'Native', hint: 'playbackRate only: pitch follows speed' },
];

const THEMES: { value: Theme; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'auto', label: 'Auto' },
];

type UploadNotice = { id: number; text: string; kind: 'info' | 'error' };

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    try {
        const value = window.localStorage.getItem(key);
        return allowed.includes(value as T) ? value as T : fallback;
    } catch {
        return fallback;
    }
}

function writePref(key: string, value: string): void {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // preference just won't persist
    }
}

export default function App() {
    const [engine, setEngine] = useState<Engine>(() => readPref(ENGINE_KEY, ['vocoder', 'rubberband', 'native'], 'vocoder'));
    const [theme, setTheme] = useState<Theme>(() => readPref(THEME_KEY, ['light', 'dark', 'auto'], 'light'));

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
    }, [theme]);

    // The stretch strategy is a construction-time option: switching it
    // remounts the page (and with it, the player).
    return (
        <Demo
            key={engine}
            engine={engine}
            theme={theme}
            onEngineChange={(next) => {
                writePref(ENGINE_KEY, next);
                setEngine(next);
            }}
            onThemeChange={(next) => {
                writePref(THEME_KEY, next);
                setTheme(next);
            }}
        />
    );
}

type DemoProps = {
    engine: Engine;
    theme: Theme;
    onEngineChange: (engine: Engine) => void;
    onThemeChange: (theme: Theme) => void;
};

function Segmented<T extends string>({ label, name, value, options, onChange }: {
    label: string;
    name: string;
    value: T;
    options: { value: T; label: string; hint?: string }[];
    onChange: (value: T) => void;
}) {
    return (
        <fieldset className="seg">
            <legend className="seg__legend">{label}</legend>
            <div className="seg__options">
                {options.map((option) => (
                    <label key={option.value} className="seg__option" title={option.hint} data-checked={option.value === value || undefined}>
                        <input
                            type="radio"
                            name={name}
                            value={option.value}
                            checked={option.value === value}
                            onChange={() => onChange(option.value)}
                        />
                        {option.label}
                    </label>
                ))}
            </div>
        </fieldset>
    );
}

function usageSnippet(engine: Engine, theme: Theme): string {
    const imports = [
        "import { AudioPlayer, useAudioPlayer } from '@saitdigital/rt-dspplr/react';",
        engine === 'rubberband' ? "import { rubberbandStretcher } from '@saitdigital/rt-dspplr/stretch-rubberband';" : null,
        "import '@saitdigital/rt-dspplr/styles.css';",
    ].filter(Boolean).join('\n');
    const options = engine === 'rubberband'
        ? '{ stretcher: rubberbandStretcher() }'
        : engine === 'native'
            ? "{ stretcher: 'native' }"
            : '';
    return `${imports}

function PlaylistExample({ clips }) {
  const player = useAudioPlayer(${options});
  const [auto, setAuto] = useState(false);

  return (
    <>
      <ClipList clips={clips} onPick={(clip) => player.play({
        id: clip.id, src: clip.url, srcB: clip.urlB,
      })} />
      <AudioPlayer
        player={player}
        theme="${theme}"
        autoPlayNext={auto}
        onAutoPlayNextChange={setAuto}
      />
    </>
  );
}`;
}

function Demo({ engine, theme, onEngineChange, onThemeChange }: DemoProps) {
    const options = useMemo<AudioPlayerOptions>(() => ({
        stretcher: engine === 'rubberband' ? rubberbandStretcher() : engine === 'native' ? 'native' : undefined,
    }), [engine]);
    const player = useAudioPlayer(options);
    const { state, play } = player;

    // Handle for poking at the player from DevTools.
    useEffect(() => {
        (window as unknown as Record<string, unknown>).__demo = { player: player.player, getAudioCacheStats, clearAudioCache };
    }, [player.player]);

    const { clips, uploadsEnabled, error, loaded, syncMode } = useStorageClips();
    const [activeClipId, setActiveClipId] = useState<string | null>(null);
    const [autoPlayNext, setAutoPlayNext] = useState(() => readPref(AUTO_PLAY_KEY, ['1', '0'], '0') === '1');
    const [isDragOver, setIsDragOver] = useState(false);
    const [notices, setNotices] = useState<UploadNotice[]>([]);
    const [copied, setCopied] = useState(false);
    const listRef = useRef<ClipListHandle | null>(null);
    const noticeSeqRef = useRef(0);

    const clipsById = useMemo(() => {
        const map: Record<string, Clip> = {};
        for (const clip of clips) map[clip.id] = clip;
        return map;
    }, [clips]);

    const currentClip = state.clipId ? clipsById[state.clipId] ?? null : null;

    const durations = useClipDurations(
        clips,
        state.status === 'ready' ? state.clipId : null,
        state.duration,
    );

    // ── Handlers ────────────────────────────────────────────────
    const handleClipClick = useCallback((clip: Clip) => {
        setActiveClipId(clip.id);
        requestAnimationFrame(() => listRef.current?.focusClip(clip.id));
        void play({ src: clip.url, srcB: clip.urlB, id: clip.id });
    }, [play]);

    const toggleAutoPlay = useCallback((next: boolean) => {
        writePref(AUTO_PLAY_KEY, next ? '1' : '0');
        setAutoPlayNext(next);
    }, []);

    useAutoAdvance(autoPlayNext, state, clips, handleClipClick);

    // ── Drag and drop upload (dev server only) ──────────────────
    const pushNotice = useCallback((text: string, kind: UploadNotice['kind']) => {
        const id = ++noticeSeqRef.current;
        setNotices((prev) => [...prev.slice(-3), { id, text, kind }]);
        window.setTimeout(() => {
            setNotices((prev) => prev.filter((notice) => notice.id !== id));
        }, kind === 'error' ? 6000 : 3500);
    }, []);

    useEffect(() => {
        let depth = 0;
        const hasFiles = (event: DragEvent) => !!event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files');

        const onDragEnter = (event: DragEvent) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            depth += 1;
            setIsDragOver(true);
        };
        const onDragOver = (event: DragEvent) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = uploadsEnabled ? 'copy' : 'none';
        };
        const onDragLeave = (event: DragEvent) => {
            if (!hasFiles(event)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) setIsDragOver(false);
        };
        const onDrop = (event: DragEvent) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            depth = 0;
            setIsDragOver(false);
            if (!uploadsEnabled) {
                pushNotice('Uploads work only under `npm run dev`. Copy files into the folder instead.', 'error');
                return;
            }
            const files = Array.from(event.dataTransfer?.files ?? []);
            void (async () => {
                for (const file of files) {
                    if (!UPLOADABLE.test(file.name)) {
                        pushNotice(`${file.name}: not an audio file, skipped`, 'error');
                        continue;
                    }
                    try {
                        await uploadToStorage(file);
                        pushNotice(`${file.name}: stored in ${STORAGE_BUCKET}`, 'info');
                    } catch (err) {
                        pushNotice(`${file.name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
                    }
                }
            })();
        };

        window.addEventListener('dragenter', onDragEnter);
        window.addEventListener('dragover', onDragOver);
        window.addEventListener('dragleave', onDragLeave);
        window.addEventListener('drop', onDrop);
        return () => {
            window.removeEventListener('dragenter', onDragEnter);
            window.removeEventListener('dragover', onDragOver);
            window.removeEventListener('dragleave', onDragLeave);
            window.removeEventListener('drop', onDrop);
        };
    }, [pushNotice, uploadsEnabled]);

    const playerTitle = currentClip ? displayName(currentClip.object.key, currentClip.object.metadata?.label) : undefined;
    const playerMeta = currentClip
        ? [formatTimestamp(currentClip.object.metadata?.recorded_at), currentClip.object.key].filter(Boolean).join(' · ')
        : undefined;
    const snippet = usageSnippet(engine, theme);

    const copySnippet = () => {
        void navigator.clipboard?.writeText(snippet).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        }, () => undefined);
    };

    return (
        <div className="page">
            <header className="top">
                <div className="top__intro">
                    <h1 className="top__title">RT-DSPPLR</h1>
                    <p className="top__lead">
                        A Web audio player with real-time DSP: pitch-preserving speed, loop,
                        a DSP chain and a two-track mixer for stems A and B. Pick a clip to try it.
                    </p>
                </div>
                <div className="top__settings">
                    <Segmented label="Theme" name="demo-theme" value={theme} options={THEMES} onChange={onThemeChange} />
                    <Segmented label="Time stretch" name="demo-engine" value={engine} options={ENGINES} onChange={onEngineChange} />
                </div>
            </header>

            <div className="layout">
                <section className="panel panel--list" aria-labelledby="clips-heading">
                    <header className="panel__head">
                        <h2 id="clips-heading" className="panel__title">
                            Clips <span className="count">{clips.length}</span>
                        </h2>
                        <span className={`sync sync--${syncMode}`}>
                            {syncMode === 'live' ? 'live' : 'polling 5 s'}
                        </span>
                    </header>
                    <ClipList
                        ref={listRef}
                        clips={clips}
                        durations={durations}
                        activeClipId={activeClipId}
                        playingClipId={state.clipId}
                        isPlaying={state.isPlaying}
                        loaded={loaded}
                        error={error}
                        onClipClick={handleClipClick}
                    />
                    <p className="panel__foot">
                        Add audio to <code>storage/clips/</code>{uploadsEnabled ? ' or drop files anywhere on the page' : ''}.
                        The list updates by itself.
                    </p>
                </section>

                <div className="stack">
                    <AudioPlayer
                        player={player}
                        title={playerTitle}
                        meta={playerMeta}
                        emptyText="Pick a clip from the list"
                        autoPlayNext={autoPlayNext}
                        onAutoPlayNextChange={toggleAutoPlay}
                        theme={theme}
                    />

                    <section className="panel" aria-labelledby="code-heading">
                        <header className="panel__head">
                            <h2 id="code-heading" className="panel__title">Usage</h2>
                            <button type="button" className="ghost" onClick={copySnippet}>{copied ? 'Copied' : 'Copy'}</button>
                        </header>
                        <pre className="code"><code>{snippet}</code></pre>
                    </section>
                </div>

                <aside className="aside" aria-label="Keyboard and mouse">
                    <section className="panel" aria-labelledby="keys-heading">
                        <header className="panel__head">
                            <h2 id="keys-heading" className="panel__title">Keyboard and mouse</h2>
                        </header>
                        <ul className="keys">
                            <li><span className="keys__what">Buttons</span><span>back to start · −0.5 / +0.5 s steps (skipSeconds)</span></li>
                            <li><span className="keys__what">Waveform focused</span><span><kbd>←</kbd> <kbd>→</kbd> ±1 s · <kbd>PgUp</kbd> <kbd>PgDn</kbd> ±5 s · <kbd>Home</kbd> <kbd>End</kbd> · <kbd>+</kbd> <kbd>−</kbd> zoom · <kbd>Esc</kbd> clears the loop</span></li>
                            <li><span className="keys__what">Waveform</span><span>click seeks · drag selects a loop · drag the handles to adjust · wheel zooms · <kbd>Shift</kbd> + wheel pans</span></li>
                            <li><span className="keys__what">Sliders</span><span>double-click resets to the default</span></li>
                        </ul>
                    </section>
                </aside>
            </div>

            <LicensePanel />

            {isDragOver && (
                <div className="drop">
                    <div className="drop__box">
                        {uploadsEnabled
                            ? <>Drop to store the files in <code>{STORAGE_BUCKET}/</code></>
                            : 'Uploads work only under npm run dev'}
                    </div>
                </div>
            )}

            {notices.length > 0 && (
                <div className="toasts" role="status">
                    {notices.map((notice) => (
                        <div key={notice.id} className={`toast toast--${notice.kind}`}>{notice.text}</div>
                    ))}
                </div>
            )}
        </div>
    );
}
