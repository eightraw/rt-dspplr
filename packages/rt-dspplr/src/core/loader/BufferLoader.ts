import { pcmCache } from '../cache/pcmCache';

// ---------------------------------------------------------------------------
// BufferLoader — full-file fetch + decodeAudioData
// ---------------------------------------------------------------------------
//
// The whole file is fetched once and decoded into an
// AudioBuffer. Everything after that (seek, loop, speed change, restart) works
// on the decoded buffer without touching the network again. Decoded buffers
// are kept in the shared, byte-bounded PcmCache keyed by URL.
//
// A whole clip costs its encoded size while it downloads and about 22 MiB of
// PCM per minute (48 kHz stereo) once decoded, so the optional limits fail a
// file that is too large early: by its Content-Length before the download,
// by the bytes read while it runs, and by its duration once decoded.

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface LoadProgress {
    status: LoadStatus;
    /** 0–1 download progress (NaN when the size is unknown: no Content-Length, or a Content-Encoding). */
    progress: number;
}

export interface LoadResult {
    buffer: AudioBuffer;
    url: string;
}

/** Size limits of whole clips (decoded in full). */
export interface ClipLimits {
    /** The largest file, in bytes (encoded). Default: no limit. */
    maxBytes?: number;
    /** The longest clip, in seconds, checked once decoded. Default: no limit. */
    maxSeconds?: number;
}

export interface BufferLoaderOptions extends ClipLimits {
    /** Extra fetch() options (credentials, headers, mode...). Their `signal`, if any, aborts the load as well. */
    fetchOptions?: RequestInit;
}

const MIB = 1024 * 1024;

function clipTooLarge(detail: string): Error {
    const error = new Error(`${detail}. Whole clips are decoded in full; play long recordings prepared, with play({ manifest }).`);
    error.name = 'ClipTooLargeError';
    return error;
}

/** A limit that means something: a positive number, else none. */
function limit(value: number | undefined): number | undefined {
    return typeof value === 'number' && value > 0 ? value : undefined;
}

/** Throws an Error named 'ClipTooLargeError' when `bytes` or `seconds` is over its limit. */
export function checkClipLimits(limits: ClipLimits, size: { bytes?: number; seconds?: number }): void {
    const maxBytes = limit(limits.maxBytes);
    const maxSeconds = limit(limits.maxSeconds);
    if (maxBytes !== undefined && size.bytes !== undefined && size.bytes > maxBytes) {
        throw clipTooLarge(`The file is ${(size.bytes / MIB).toFixed(1)} MiB, over the limit of ${(maxBytes / MIB).toFixed(1)} MiB`);
    }
    if (maxSeconds !== undefined && size.seconds !== undefined && size.seconds > maxSeconds) {
        throw clipTooLarge(`The clip is ${span(size.seconds)} long, over the limit of ${span(maxSeconds)}`);
    }
}

function span(seconds: number): string {
    return seconds < 120 ? `${Number(seconds.toFixed(2))} s` : `${Number((seconds / 60).toFixed(1))} min`;
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

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('The load was aborted', 'AbortError');
}

export class BufferLoader {
    private _abortController: AbortController | null = null;
    private _status: LoadStatus = 'idle';
    private _progress = 0;
    private _fetchOptions: RequestInit | undefined;
    private _limits: ClipLimits;
    private _lastError: Error | null = null;

    constructor(options?: BufferLoaderOptions) {
        this._fetchOptions = options?.fetchOptions;
        this._limits = { maxBytes: limit(options?.maxBytes), maxSeconds: limit(options?.maxSeconds) };
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
     * Returns null if aborted or on failure (see `lastError`). An abort through
     * `fetchOptions.signal` is a failure: the caller asked for it.
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

        // The caller's own signal stops the load too (fetch takes one signal).
        const callerSignal = this._fetchOptions?.signal ?? null;
        let callerAborted = false;
        const onCallerAbort = () => {
            callerAborted = true;
            controller.abort(callerSignal?.reason);
        };
        if (callerSignal?.aborted) onCallerAbort();
        else callerSignal?.addEventListener('abort', onCallerAbort);

        const resolvedUrl = resolveUrl(url);
        const key = decodedCacheKey(resolvedUrl);
        try {
            const cachedBuffer = pcmCache.get(key);
            if (cachedBuffer) {
                checkClipLimits(this._limits, { seconds: cachedBuffer.duration });
                this._status = 'ready';
                this._progress = 1;
                onProgress?.({ status: 'ready', progress: 1 });
                return { buffer: cachedBuffer, url: resolvedUrl };
            }

            const response = await fetch(resolvedUrl, {
                ...this._fetchOptions,
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const bytes = await this._readBody(response, onProgress);
            if (controller.signal.aborted) throw abortReason(controller.signal);

            // decodeAudioData cannot be stopped. What it makes is this URL's audio
            // whether or not the load was aborted meanwhile, so it is cached either
            // way: coming back to the clip then does not decode it again.
            const buffer = await context.decodeAudioData(bytes);
            const { maxSeconds } = this._limits;
            if (maxSeconds === undefined || buffer.duration <= maxSeconds) {
                pcmCache.set(key, buffer);
            }
            if (controller.signal.aborted) throw abortReason(controller.signal);
            checkClipLimits(this._limits, { seconds: buffer.duration });

            this._status = 'ready';
            this._progress = 1;
            onProgress?.({ status: 'ready', progress: 1 });

            return { buffer, url: resolvedUrl };
        } catch (error: unknown) {
            if (!callerAborted && (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError'))) {
                return null;
            }
            if (!callerAborted) console.error('[BufferLoader] Load failed', url, error);
            this._lastError = error instanceof Error ? error : new Error(String(error));
            this._status = 'failed';
            onProgress?.({ status: 'failed', progress: this._progress });
            return null;
        } finally {
            callerSignal?.removeEventListener('abort', onCallerAbort);
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

    /**
     * The response body, with progress and the size limit. A known length is
     * read straight into one buffer; otherwise the chunks are joined at the end.
     */
    private async _readBody(response: Response, onProgress?: (p: LoadProgress) => void): Promise<ArrayBuffer> {
        const declared = Number(response.headers.get('content-length') || 0);
        // With a Content-Encoding the header counts the compressed transfer, not
        // the body read here. (Over the limit compressed, it is over it unpacked too.)
        const encoding = response.headers.get('content-encoding');
        const length = declared > 0 && (!encoding || encoding === 'identity') ? declared : 0;
        if (this._limits.maxBytes !== undefined && declared > this._limits.maxBytes) {
            void response.body?.cancel().catch(() => undefined);
            checkClipLimits(this._limits, { bytes: declared });
        }
        const report = (received: number) => {
            this._progress = length > 0 ? Math.min(1, received / length) : NaN;
            onProgress?.({ status: 'loading', progress: this._progress });
        };

        if (!response.body) {
            const bytes = await response.arrayBuffer();
            checkClipLimits(this._limits, { bytes: bytes.byteLength });
            report(bytes.byteLength);
            return bytes;
        }

        const reader = response.body.getReader();
        let target = length > 0 ? new Uint8Array(length) : null;
        const chunks: Uint8Array[] = [];
        let received = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                checkClipLimits(this._limits, { bytes: received + value.length });
                if (target) {
                    if (received + value.length > target.length) {
                        // More than the header said: grow.
                        const grown = new Uint8Array(Math.max(target.length * 2, received + value.length));
                        grown.set(target.subarray(0, received));
                        target = grown;
                    }
                    target.set(value, received);
                } else {
                    chunks.push(value);
                }
                received += value.length;
                report(received);
            }
        } catch (error) {
            void reader.cancel().catch(() => undefined);
            throw error;
        }

        if (target) return received === target.length ? target.buffer : target.slice(0, received).buffer;
        const joined = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            joined.set(chunk, offset);
            offset += chunk.length;
        }
        return joined.buffer;
    }
}
