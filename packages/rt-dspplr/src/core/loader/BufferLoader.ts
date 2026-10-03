import { pcmCache } from '../cache/pcmCache';

// ---------------------------------------------------------------------------
// BufferLoader — full-file fetch + decodeAudioData
// ---------------------------------------------------------------------------
//
// The whole file is fetched once and decoded into an
// AudioBuffer. Everything after that (seek, loop, speed change, restart) works
// on the decoded buffer without touching the network again. Decoded buffers
// are kept in the shared, byte-bounded PcmCache keyed by URL.

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface LoadProgress {
    status: LoadStatus;
    /** 0–1 download progress (NaN if content-length is unknown). */
    progress: number;
}

export interface LoadResult {
    buffer: AudioBuffer;
    url: string;
}

export interface BufferLoaderOptions {
    /** Extra fetch() options (credentials, headers, mode...). The signal is managed by the loader. */
    fetchOptions?: RequestInit;
}

function decodedCacheKey(url: string): string {
    return `decoded:${url}`;
}

function resolveUrl(src: string): string {
    if (typeof window === 'undefined') return src;
    try {
        return new URL(src, window.location.href).toString();
    } catch {
        return src;
    }
}

export class BufferLoader {
    private _abortController: AbortController | null = null;
    private _status: LoadStatus = 'idle';
    private _progress = 0;
    private _fetchOptions: RequestInit | undefined;
    private _lastError: Error | null = null;

    constructor(options?: BufferLoaderOptions) {
        this._fetchOptions = options?.fetchOptions;
    }

    get status(): LoadStatus {
        return this._status;
    }

    get progress(): number {
        return this._progress;
    }

    /** The error of the last failed load, if any. */
    get lastError(): Error | null {
        return this._lastError;
    }

    /**
     * Fetch and decode an audio file into an AudioBuffer.
     *
     * Aborts any in-flight load for this loader instance.
     * Returns null if aborted or on failure (see `lastError`).
     */
    async load(
        url: string,
        context: BaseAudioContext,
        onProgress?: (p: LoadProgress) => void,
    ): Promise<LoadResult | null> {
        // Abort previous load
        this.abort();

        const controller = new AbortController();
        this._abortController = controller;
        this._status = 'loading';
        this._progress = 0;
        this._lastError = null;
        onProgress?.({ status: 'loading', progress: 0 });

        const resolvedUrl = resolveUrl(url);
        const cachedBuffer = pcmCache.get(decodedCacheKey(resolvedUrl));
        if (cachedBuffer) {
            this._status = 'ready';
            this._progress = 1;
            onProgress?.({ status: 'ready', progress: 1 });
            return { buffer: cachedBuffer, url: resolvedUrl };
        }

        try {
            const response = await fetch(resolvedUrl, {
                ...this._fetchOptions,
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Stream body for progress tracking
            const contentLength = Number(response.headers.get('content-length') || 0);
            const hasLength = contentLength > 0;

            let arrayBuffer: ArrayBuffer;

            if (hasLength && response.body) {
                // Read with progress
                const reader = response.body.getReader();
                const chunks: Uint8Array[] = [];
                let received = 0;

                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    chunks.push(value);
                    received += value.length;
                    this._progress = Math.min(1, received / contentLength);
                    onProgress?.({ status: 'loading', progress: this._progress });
                }

                // Concatenate chunks
                const merged = new Uint8Array(received);
                let offset = 0;
                for (const chunk of chunks) {
                    merged.set(chunk, offset);
                    offset += chunk.length;
                }
                arrayBuffer = merged.buffer;
            } else {
                // Fallback: no content-length or no body stream
                arrayBuffer = await response.arrayBuffer();
                this._progress = 1;
                onProgress?.({ status: 'loading', progress: 1 });
            }

            if (controller.signal.aborted) return null;

            // Decode
            const buffer = await context.decodeAudioData(arrayBuffer);

            if (controller.signal.aborted) return null;

            this._status = 'ready';
            this._progress = 1;
            pcmCache.set(decodedCacheKey(resolvedUrl), buffer);
            onProgress?.({ status: 'ready', progress: 1 });

            return { buffer, url: resolvedUrl };
        } catch (error: unknown) {
            if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
                return null;
            }
            console.error('[BufferLoader] Load failed', url, error);
            this._lastError = error instanceof Error ? error : new Error(String(error));
            this._status = 'failed';
            onProgress?.({ status: 'failed', progress: this._progress });
            return null;
        }
    }

    /**
     * Abort any in-flight load.
     */
    abort(): void {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
        this._status = 'idle';
        this._progress = 0;
    }

    dispose(): void {
        this.abort();
    }
}
