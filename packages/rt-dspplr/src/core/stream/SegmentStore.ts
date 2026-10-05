import type { AudioManifest } from './manifest';
import { parseWavFile } from './wavFormat';

// ---------------------------------------------------------------------------
// SegmentStore — fetches and decodes segments on demand and keeps a
// byte-bounded LRU of decoded ones. The player tells it, on every pump, which
// segments matter and in what order (playing, next, loop start, on screen,
// prefetch); eviction drops everything else first, least recently used first,
// then the least important wanted ones, but never the first `essential`.
// ---------------------------------------------------------------------------

/**
 * 'pcm' parses the 16-bit WAV on the main thread into an AudioBuffer at the
 * manifest's rate (no resampling, sample-exact). 'native' uses
 * decodeAudioData (off the main thread, but resamples to the context's rate
 * when it differs).
 */
export type SegmentDecode = 'pcm' | 'native';

export interface SegmentStoreOptions {
    decode?: SegmentDecode;
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
    private readonly _urls: string[];
    private readonly _ctx: BaseAudioContext;
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
    private readonly _stats = { peak: 0, fetches: 0, fetchedBytes: 0, fetchMs: 0, decodeMs: 0, evictions: 0 };

    constructor(manifestUrl: string, manifest: AudioManifest, ctx: BaseAudioContext, options: SegmentStoreOptions) {
        this._manifest = manifest;
        this._ctx = ctx;
        this._urls = manifest.segments.list.map((s) => new URL(s.url, manifestUrl).href);
        this._options = { decode: 'pcm', concurrency: 3, ...options };
    }

    get decode(): SegmentDecode {
        return this._options.decode;
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

    /** Fetch + decode (deduplicated). `urgent` jumps the queue. Resolves null if cancelled. */
    load(index: number, urgent = false): Promise<AudioBuffer | null> {
        const cached = this.get(index);
        if (cached) return Promise.resolve(cached);
        if (index < 0 || index >= this._urls.length || this._disposed) return Promise.resolve(null);
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
            const response = await fetch(this._urls[job.index], { ...this._options.fetchOptions, signal: job.controller.signal });
            if (!response.ok) throw new Error(`Segment ${job.index}: HTTP ${response.status}`);
            const bytes = await response.arrayBuffer();
            const t1 = performance.now();
            const buffer = await this._decode(bytes);
            const t2 = performance.now();
            if (job.controller.signal.aborted || this._disposed) {
                this._finish(job, null);
                return;
            }
            this._stats.fetches += 1;
            this._stats.fetchedBytes += bytes.byteLength;
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
            if (!job.controller.signal.aborted) console.warn('[StreamPlayer] segment failed', job.index, error);
            this._finish(job, null);
        }
    }

    private async _decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
        if (this._options.decode === 'native') {
            return this._ctx.decodeAudioData(bytes);
        }
        const wav = parseWavFile(bytes);
        const buffer = new AudioBuffer({ length: Math.max(1, wav.frames), numberOfChannels: wav.channels.length, sampleRate: wav.sampleRate || this._manifest.sampleRate });
        wav.channels.forEach((data, c) => buffer.copyToChannel(data, c));
        return buffer;
    }
}
