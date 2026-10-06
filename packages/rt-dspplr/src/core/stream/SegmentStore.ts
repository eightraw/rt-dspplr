import type { AudioManifest } from './manifest';
import { decodeRun } from './RunDecoder';
import { segmentFromRun } from './sourceRuns';

// ---------------------------------------------------------------------------
// SegmentStore — fetches segments on demand (byte ranges of the clip's source,
// decoded by RunDecoder) and keeps a byte-bounded LRU of decoded ones. The player tells it, on every pump, which
// segments matter and in what order (playing, next, loop start, on screen,
// prefetch); eviction drops everything else first, least recently used first,
// then the least important wanted ones, but never the first `essential`.
// A segment that fails (HTTP error, bad data) is retried with a growing pause
// (250 ms doubling to 8 s), never on every pump; onError() reports each failure.
// ---------------------------------------------------------------------------

const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 8000;

export interface SegmentStoreOptions {
    fetchOptions?: RequestInit;
    /** Decoded-audio budget in bytes. */
    maxBytes: number;
    /** Parallel fetches. Default 3. */
    concurrency?: number;
}

export interface SegmentStoreStats {
    cachedSegments: number;
    cachedBytes: number;
    /** Highest cachedBytes seen. */
    peakCachedBytes: number;
    maxBytes: number;
    fetches: number;
    fetchedBytes: number;
    /** Average fetch and decode times of the segments loaded, ms. */
    avgFetchMs: number;
    avgDecodeMs: number;
    evictions: number;
}

interface Entry {
    buffer: AudioBuffer;
    bytes: number;
    used: number;
}

interface Job {
    index: number;
    controller: AbortController;
    promise: Promise<AudioBuffer | null>;
    resolve: (buffer: AudioBuffer | null) => void;
    started: boolean;
}

export class SegmentStore {
    private readonly _sourceUrl: string;
    private readonly _manifest: AudioManifest;
    private readonly _options: Required<Omit<SegmentStoreOptions, 'fetchOptions'>> & { fetchOptions?: RequestInit };
    private readonly _cache = new Map<number, Entry>();
    private readonly _jobs = new Map<number, Job>();
    private _queue: Job[] = [];
    private _active = 0;
    private _tick = 0;
    private _bytes = 0;
    private _disposed = false;
    private _listeners = new Set<(index: number) => void>();
    private _errorListeners = new Set<(index: number, error: Error, failures: number) => void>();
    /** Segments that failed: how often in a row, and when the next try may start. */
    private readonly _failures = new Map<number, { count: number; retryAt: number }>();
    private readonly _stats = { peak: 0, fetches: 0, fetchedBytes: 0, fetchMs: 0, decodeMs: 0, evictions: 0 };

    constructor(manifestUrl: string, manifest: AudioManifest, options: SegmentStoreOptions) {
        this._manifest = manifest;
        this._sourceUrl = new URL(manifest.segments.source.url, manifestUrl).href;
        this._options = { concurrency: 3, ...options };
    }

    /** A decoded segment, or null. Marks it as used. */
    get(index: number): AudioBuffer | null {
        const entry = this._cache.get(index);
        if (!entry) return null;
        entry.used = ++this._tick;
        return entry.buffer;
    }

    has(index: number): boolean {
        return this._cache.has(index);
    }

    isLoading(index: number): boolean {
        return this._jobs.has(index);
    }

    /** Called with the index of every segment that finishes decoding. */
    onLoad(listener: (index: number) => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /** Called when a segment fails, with how many times in a row it has. */
    onError(listener: (index: number, error: Error, failures: number) => void): () => void {
        this._errorListeners.add(listener);
        return () => this._errorListeners.delete(listener);
    }

    /** Failures in a row of a segment (0 once it loads). */
    failures(index: number): number {
        return this._failures.get(index)?.count ?? 0;
    }

    /**
     * Fetch + decode (deduplicated). `urgent` jumps the queue. Resolves null if
     * cancelled, or at once while a failed segment waits for its next retry.
     */
    load(index: number, urgent = false): Promise<AudioBuffer | null> {
        const cached = this.get(index);
        if (cached) return Promise.resolve(cached);
        if (index < 0 || index >= this._manifest.segments.list.length || this._disposed) return Promise.resolve(null);
        const failed = this._failures.get(index);
        if (failed && performance.now() < failed.retryAt && !this._jobs.has(index)) return Promise.resolve(null);
        const existing = this._jobs.get(index);
        if (existing) {
            if (urgent && !existing.started) {
                this._queue = [existing, ...this._queue.filter((j) => j !== existing)];
            }
            return existing.promise;
        }
        let resolve!: (b: AudioBuffer | null) => void;
        const promise = new Promise<AudioBuffer | null>((r) => { resolve = r; });
        const job: Job = { index, controller: new AbortController(), promise, resolve, started: false };
        this._jobs.set(index, job);
        if (urgent) this._queue.unshift(job);
        else this._queue.push(job);
        this._drain();
        return promise;
    }

    /** Cancel loads of segments not in `wanted` (a seek far away). */
    cancelExcept(wanted: Set<number>): void {
        for (const job of [...this._jobs.values()]) {
            if (wanted.has(job.index)) continue;
            job.controller.abort();
            this._finish(job, null);
        }
    }

    /**
     * Enforce the budget. `wanted` is in priority order; the first `essential`
     * of them are never evicted.
     */
    evict(wanted: number[], essential: number): void {
        this._retain = { wanted, essential };
        this._enforce(null);
    }

    /** Evict down to the budget with the last priorities; `fresh` (just decoded) goes last. */
    private _enforce(fresh: number | null): void {
        if (this._bytes <= this._options.maxBytes) return;
        const { essential } = this._retain;
        const wanted = fresh === null || this._retain.wanted.includes(fresh) ? this._retain.wanted : [fresh, ...this._retain.wanted];
        const keep = new Set(wanted);
        const loose = [...this._cache.entries()].filter(([i]) => !keep.has(i)).sort((a, b) => a[1].used - b[1].used);
        for (const [index] of loose) {
            if (this._bytes <= this._options.maxBytes) return;
            this._drop(index);
        }
        for (let k = wanted.length - 1; k >= essential && this._bytes > this._options.maxBytes; k -= 1) {
            if (this._cache.has(wanted[k]) && wanted[k] !== fresh) this._drop(wanted[k]);
        }
    }

    private _retain: { wanted: number[]; essential: number } = { wanted: [], essential: 2 };

    /**
     * The leading part of `wanted` (priority order) whose decoded audio fits the
     * budget: loading more would only evict it again on the next pump.
     */
    withinBudget(wanted: number[]): number[] {
        const list = this._manifest.segments.list;
        const out: number[] = [];
        let bytes = 0;
        for (const i of wanted) {
            const seg = list[i];
            if (!seg) continue;
            bytes += seg.frames * this._manifest.channels * 4;
            if (bytes > this._options.maxBytes && out.length > 0) break;
            out.push(i);
        }
        return out;
    }

    stats(): SegmentStoreStats {
        const loaded = Math.max(1, this._stats.fetches);
        return {
            cachedSegments: this._cache.size,
            cachedBytes: this._bytes,
            peakCachedBytes: this._stats.peak,
            maxBytes: this._options.maxBytes,
            fetches: this._stats.fetches,
            fetchedBytes: this._stats.fetchedBytes,
            avgFetchMs: this._stats.fetchMs / loaded,
            avgDecodeMs: this._stats.decodeMs / loaded,
            evictions: this._stats.evictions,
        };
    }

    dispose(): void {
        this._disposed = true;
        for (const job of [...this._jobs.values()]) {
            job.controller.abort();
            this._finish(job, null);
        }
        this._cache.clear();
        this._bytes = 0;
        this._listeners.clear();
        this._errorListeners.clear();
        this._failures.clear();
    }

    private _drop(index: number): void {
        const entry = this._cache.get(index);
        if (!entry) return;
        this._cache.delete(index);
        this._bytes -= entry.bytes;
        this._stats.evictions += 1;
    }

    private _finish(job: Job, buffer: AudioBuffer | null): void {
        if (this._jobs.get(job.index) === job) this._jobs.delete(job.index);
        this._queue = this._queue.filter((j) => j !== job);
        job.resolve(buffer);
    }

    private _drain(): void {
        while (this._active < this._options.concurrency && this._queue.length > 0) {
            const job = this._queue.shift()!;
            job.started = true;
            this._active += 1;
            void this._run(job).finally(() => {
                this._active -= 1;
                this._drain();
            });
        }
    }

    private async _run(job: Job): Promise<void> {
        const t0 = performance.now();
        try {
            const seg = this._manifest.segments.list[job.index];
            let bytes: ArrayBuffer | null = null;
            let fetched = 0;
            if (seg.range) {
                const [start, end] = seg.range;
                const headers = new Headers(this._options.fetchOptions?.headers);
                headers.set('range', `bytes=${start}-${end - 1}`);
                const response = await fetch(this._sourceUrl, { ...this._options.fetchOptions, headers, signal: job.controller.signal });
                if (!response.ok) throw new Error(`Segment ${job.index}: HTTP ${response.status}`);
                bytes = await response.arrayBuffer();
                fetched = bytes.byteLength;
                // A server that ignores ranges sends the whole file: the run is cut out of it.
                if (response.status === 200 && bytes.byteLength > end - start) bytes = bytes.slice(start, end);
            }
            const t1 = performance.now();
            const run = bytes ? await decodeRun(this._manifest.segments.source, bytes) : null;
            const buffer = this._toBuffer(segmentFromRun(run, seg, this._manifest.channels));
            const t2 = performance.now();
            if (job.controller.signal.aborted || this._disposed) {
                this._finish(job, null);
                return;
            }
            this._failures.delete(job.index);
            this._stats.fetches += 1;
            this._stats.fetchedBytes += fetched;
            this._stats.fetchMs += t1 - t0;
            this._stats.decodeMs += t2 - t1;
            const size = buffer.length * buffer.numberOfChannels * 4;
            this._cache.set(job.index, { buffer, bytes: size, used: ++this._tick });
            this._bytes += size;
            this._enforce(job.index);
            this._stats.peak = Math.max(this._stats.peak, this._bytes);
            this._finish(job, buffer);
            for (const listener of [...this._listeners]) listener(job.index);
        } catch (error) {
            if (job.controller.signal.aborted || this._disposed) {
                this._finish(job, null);
                return;
            }
            const count = (this._failures.get(job.index)?.count ?? 0) + 1;
            this._failures.set(job.index, { count, retryAt: performance.now() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (count - 1)) });
            console.warn('[AudioPlayer] segment failed', job.index, error);
            this._finish(job, null);
            const err = error instanceof Error ? error : new Error(String(error));
            for (const listener of [...this._errorListeners]) listener(job.index, err, count);
        }
    }

    /** The segment's frames at the timeline's rate (the engine converts to the context's). */
    private _toBuffer(planes: Float32Array[]): AudioBuffer {
        const buffer = new AudioBuffer({ length: Math.max(1, planes[0]?.length ?? 1), numberOfChannels: planes.length, sampleRate: this._manifest.sampleRate });
        planes.forEach((data, c) => buffer.copyToChannel(data, c));
        return buffer;
    }
}
