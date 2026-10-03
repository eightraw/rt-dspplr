// The list of clips in the bucket (newest first).

import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { Clip } from './types';
import { displayName, formatBytes, formatDuration } from './format';

export type ClipListHandle = {
    focusClip: (clipId: string) => void;
};

type Props = {
    clips: Clip[];
    durations: Record<string, number>;
    activeClipId: string | null;
    playingClipId: string | null;
    isPlaying: boolean;
    loaded: boolean;
    error: string | null;
    onClipClick: (clip: Clip) => void;
};

export const ClipList = forwardRef<ClipListHandle, Props>(function ClipList({
    clips,
    durations,
    activeClipId,
    playingClipId,
    isPlaying,
    loaded,
    error,
    onClipClick,
}, ref) {
    const listRef = useRef<HTMLUListElement | null>(null);

    useImperativeHandle(ref, () => ({
        focusClip(clipId: string) {
            const el = listRef.current?.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(clipId)}"] button`);
            if (!el) return;
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            el.focus({ preventScroll: true });
        },
    }), []);

    if (error && clips.length === 0) {
        return <p className="clips__empty">Storage unavailable: {error}</p>;
    }

    if (!loaded) {
        return <p className="clips__empty">Loading…</p>;
    }

    if (clips.length === 0) {
        return (
            <p className="clips__empty">
                Nothing here yet. Put audio files into <code>storage/clips/</code> or drop them onto the page.
            </p>
        );
    }

    return (
        <ul className="clips" ref={listRef}>
            {clips.map((clip) => {
                const { object } = clip;
                const meta = object.metadata;
                const name = displayName(object.key, meta?.label);
                const isActive = clip.id === activeClipId;
                const isCurrent = clip.id === playingClipId;
                const fileName = object.key.slice(object.key.lastIndexOf('/') + 1);

                return (
                    <li key={clip.id} data-clip-id={clip.id}>
                        <button
                            type="button"
                            className="clip"
                            aria-current={isActive || undefined}
                            data-playing={(isCurrent && isPlaying) || undefined}
                            title={object.key}
                            onClick={() => onClipClick(clip)}
                        >
                            <span className="clip__main">
                                <span className="clip__name">{name}</span>
                                {name !== fileName && <span className="clip__file">{fileName}</span>}
                            </span>
                            <span className="clip__facts">
                                {typeof meta?.language === 'string' && <span className="clip__lang">{meta.language}</span>}
                                <span>{formatDuration(durations[clip.id])}</span>
                                <span>{formatBytes(object.size)}</span>
                                {object.keyB && <span className="pill">A/B</span>}
                            </span>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
});
