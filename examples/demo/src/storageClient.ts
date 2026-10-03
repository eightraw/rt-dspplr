// Talks to the example's object-storage plugin. In dev the server pushes
// `storage:changed` over Vite's HMR socket and the list is re-read; without
// that socket (vite preview, static hosting) the list is polled every 5 s.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Clip, StorageListResponse, StorageObject } from './types';

export const STORAGE_BUCKET = 'clips';
const POLL_INTERVAL_MS = 5000;

function toClip(object: StorageObject): Clip {
    return {
        // The ETag is part of the id so that replacing a file under the same
        // name counts as a new clip for the player (fresh load, fresh waveform).
        id: `${object.key}#${object.etag.replace(/"/g, '').slice(0, 12)}`,
        url: object.url,
        urlB: object.urlB,
        object,
    };
}

export async function fetchStorageList(signal?: AbortSignal): Promise<StorageListResponse> {
    const response = await fetch('/api/storage/list', { signal, cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json() as Promise<StorageListResponse>;
}

export async function uploadToStorage(file: File, signal?: AbortSignal): Promise<void> {
    const key = file.name.replace(/[\/]/g, '_');
    const response = await fetch(`/storage/${STORAGE_BUCKET}/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        signal,
    });
    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
            const body = await response.json() as { message?: string };
            if (body?.message) detail = body.message;
        } catch {
            // keep the status text
        }
        throw new Error(detail);
    }
}

export type StorageSyncMode = 'live' | 'polling';

export function useStorageClips() {
    const [clips, setClips] = useState<Clip[]>([]);
    const [uploadsEnabled, setUploadsEnabled] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [syncMode, setSyncMode] = useState<StorageSyncMode>(import.meta.hot ? 'live' : 'polling');
    const inflightRef = useRef<AbortController | null>(null);

    const refresh = useCallback(async () => {
        inflightRef.current?.abort();
        const controller = new AbortController();
        inflightRef.current = controller;
        try {
            const list = await fetchStorageList(controller.signal);
            if (controller.signal.aborted) return;
            setClips(list.objects.map(toClip));
            setUploadsEnabled(list.uploadsEnabled);
            setError(null);
        } catch (err) {
            if (controller.signal.aborted) return;
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            if (!controller.signal.aborted) setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void refresh();

        const hot = import.meta.hot;
        let pollId: number | null = null;
        const startPolling = () => {
            if (pollId !== null) return;
            setSyncMode('polling');
            pollId = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
        };
        const stopPolling = () => {
            if (pollId === null) return;
            window.clearInterval(pollId);
            pollId = null;
            setSyncMode('live');
        };

        if (!hot) {
            startPolling();
            return () => {
                if (pollId !== null) window.clearInterval(pollId);
                inflightRef.current?.abort();
            };
        }

        const onChanged = () => void refresh();
        const onDisconnect = () => startPolling();
        const onConnect = () => {
            stopPolling();
            void refresh();
        };
        hot.on('storage:changed', onChanged);
        hot.on('vite:ws:disconnect', onDisconnect);
        hot.on('vite:ws:connect', onConnect);

        return () => {
            hot.off('storage:changed', onChanged);
            hot.off('vite:ws:disconnect', onDisconnect);
            hot.off('vite:ws:connect', onConnect);
            if (pollId !== null) window.clearInterval(pollId);
            inflightRef.current?.abort();
        };
    }, [refresh]);

    return { clips, uploadsEnabled, error, loaded, syncMode, refresh };
}
