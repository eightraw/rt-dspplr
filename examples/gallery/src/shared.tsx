// Small pieces the five designs share. None of it is part of the package.

import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { AudioPlayerCore } from '@saitdigital/rt-dspplr/react';
import { idOf, type Source } from './source';

export function PlayIcon({ playing }: { playing: boolean }) {
    return playing
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.6" height="14" rx="1.2" /><rect x="13.4" y="5" width="3.6" height="14" rx="1.2" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.3v13.4a.8.8 0 0 0 1.2.7l10.4-6.7a.8.8 0 0 0 0-1.4L9.2 4.6A.8.8 0 0 0 8 5.3Z" /></svg>;
}

/** m:ss, or mm:ss.t with tenths. */
export function clock(seconds: number, tenths = false): string {
    const s = Math.max(0, seconds);
    const m = Math.floor(s / 60);
    const rest = s - m * 60;
    return tenths
        ? `${String(m).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`
        : `${m}:${String(Math.floor(rest)).padStart(2, '0')}`;
}

/** Loads the card's source into its player; stops when the source goes away. */
export function useSource(
    core: AudioPlayerCore,
    source: Source | null,
    withB = false,
    onReady?: (core: AudioPlayerCore) => void,
): void {
    const ready = useRef(onReady);
    ready.current = onReady;
    useEffect(() => {
        if (!source) {
            core.stop();
            return;
        }
        const srcB = withB ? source.b : null;
        void core.load({ id: idOf(source, withB), src: source.a, srcB }).then((ok) => {
            if (ok) ready.current?.(core);
        });
    }, [core, source, withB]);
}

/** The live position, every animation frame. */
export function useNow(core: AudioPlayerCore): number {
    const [now, setNow] = useState(0);
    useEffect(() => {
        let frame = 0;
        const tick = () => {
            setNow(core.getCurrentTime());
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [core]);
    return now;
}

/** Calls `onLevel` every animation frame with the output RMS (0 while paused). */
export function useOutputLevel(core: AudioPlayerCore, onLevel: (rms: number) => void): void {
    const callback = useRef(onLevel);
    callback.current = onLevel;
    useEffect(() => {
        let frame = 0;
        const data = new Float32Array(1024);
        const tick = () => {
            const analyser = core.analyser;
            let rms = 0;
            if (analyser && core.getState().isPlaying) {
                analyser.getFloatTimeDomainData(data);
                let sum = 0;
                for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
                rms = Math.sqrt(sum / data.length);
            }
            callback.current(rms);
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [core]);
}

function audioFiles(list: FileList | null): File[] {
    return [...(list ?? [])].filter((file) => file.type.startsWith('audio/') || /\.(wav|mp3|ogg|opus|m4a|flac|webm|aac)$/i.test(file.name));
}

/** Drop handlers for an element: one file plays as stem A, a second one becomes stem B. */
export function useFileDrop(onFiles: (files: File[]) => void) {
    const [over, setOver] = useState(false);
    const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
    return {
        'data-drop-over': over || undefined,
        onDragOver(event: DragEvent) {
            if (!carriesFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            setOver(true);
        },
        onDragLeave() {
            setOver(false);
        },
        onDrop(event: DragEvent) {
            if (!carriesFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            setOver(false);
            const files = audioFiles(event.dataTransfer.files);
            if (files.length > 0) onFiles(files);
        },
    };
}

export function pickFiles(list: FileList | null): File[] {
    return audioFiles(list);
}
