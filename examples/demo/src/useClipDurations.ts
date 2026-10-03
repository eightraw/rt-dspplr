// Durations for the list. The browser reads them from the file header with a
// metadata-only <audio> probe (a couple of small Range requests), a few at a
// time. Once the player has decoded a clip, its exact duration wins.

import { useEffect, useRef, useState } from 'react';
import type { Clip } from './types';

const MAX_PARALLEL_PROBES = 3;
const PROBE_TIMEOUT_MS = 15000;

function probeDuration(url: string): Promise<number | null> {
    return new Promise((resolve) => {
        const audio = new Audio();
        let settled = false;
        const finish = (value: number | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            audio.removeAttribute('src');
            audio.load();
            resolve(value);
        };
        const timer = window.setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
        audio.preload = 'metadata';
        audio.muted = true;
        audio.onloadedmetadata = () => {
            const value = audio.duration;
            finish(Number.isFinite(value) && value > 0 ? value : null);
        };
        audio.onerror = () => finish(null);
        audio.src = url;
    });
}

export function useClipDurations(
    clips: Clip[],
    decodedClipId: string | null,
    decodedDuration: number,
): Record<string, number> {
    const [durations, setDurations] = useState<Record<string, number>>({});
    const requestedRef = useRef(new Set<string>());
    const activeRef = useRef(0);
    const queueRef = useRef<Clip[]>([]);
    const unmountedRef = useRef(false);

    useEffect(() => {
        unmountedRef.current = false;
        return () => {
            unmountedRef.current = true;
        };
    }, []);

    useEffect(() => {
        const pump = () => {
            while (activeRef.current < MAX_PARALLEL_PROBES && queueRef.current.length > 0) {
                const clip = queueRef.current.shift();
                if (!clip) break;
                activeRef.current += 1;
                void probeDuration(clip.url).then((value) => {
                    activeRef.current -= 1;
                    if (unmountedRef.current) return;
                    if (value !== null) {
                        setDurations((prev) => (prev[clip.id] ? prev : { ...prev, [clip.id]: value }));
                    }
                    pump();
                });
            }
        };

        for (const clip of clips) {
            if (requestedRef.current.has(clip.id)) continue;
            requestedRef.current.add(clip.id);
            queueRef.current.push(clip);
        }
        pump();
    }, [clips]);

    useEffect(() => {
        const clipId = decodedClipId;
        if (!clipId || !(decodedDuration > 0)) return;
        setDurations((prev) => (prev[clipId] === decodedDuration ? prev : { ...prev, [clipId]: decodedDuration }));
    }, [decodedClipId, decodedDuration]);

    return durations;
}
