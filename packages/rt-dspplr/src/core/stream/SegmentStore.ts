import { SourceError, type FileAccess } from './fileAccess';
import type { SegmentEntry } from './entriesFile';
import { LinkPriority } from './linkPriority';
import type { AudioManifest } from './manifest';
import { decodeRun, decoderReady, openRun, type StreamOut } from './RunDecoder';
import { segmentFromRun } from './sourceRuns';
import { decodeInterleaved } from './wavFormat';

/** A segment's frames, handed out as its bytes arrive: `planes` hold frames from `offset` of `total`. */
export type PartialListener = (index: number, offset: number, planes: Float32Array[], total: number) => void;

/** Parts of a segment arriving are handed out once at least this many seconds of it are in (or it is whole). */
const PART_MIN_SECONDS = 0.05;
/** A segment is fetched from an entry inside it (load's `at`) only when that saves at least this much of it. */
const ENTRY_MIN_SECONDS = 0.25;


// ---------------------------------------------------------------------------
// SegmentStore — fetches segments on demand (byte ranges of the clip's source,
// decoded by RunDecoder) and keeps a byte-bounded LRU of decoded ones. The player tells it, on every pump, which
// segments matter and in what order (playing, next, loop start, on screen,
// prefetch); eviction drops everything else first, least recently used first,
// then the least important wanted ones, but never the first `essential`.
// A segment that fails (HTTP error, bad data) is retried with a growing pause
// (250 ms doubling to 8 s), never on every pump; onError() reports each failure.
// A SourceError (the server ignores Range requests on a big file, the file
// changed, it decodes to another format) is not retried: it is reported once
// and the store fetches nothing more (`broken`).
// Segments are handed out in parts as their bytes arrive (onPartial): a WAV's
// PCM as it is, an MP3's, FLAC's or Opus's run through a decoder that takes
// its bytes as they come (when the manifest says each segment's `skip`).
// An urgent segment (the playhead waits for it) is fetched at once, whatever
// else is; the others give way to it on the link (LinkPriority, shared with
// the stem's store) and carry on from where they were once it is in. Asked for
// at a frame inside it (a seek), it is fetched from an entry near that frame
// first, then whole behind what the playhead waits for.
// ---------------------------------------------------------------------------

const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 8000;
/**
 * A source whose server ignores Range requests is read whole, once, and every
 * segment is cut from that copy, up to this size: a short clip on a plain
 * server plays (the copy is not counted in the decoded-audio budget). A
 * longer recording, what prepared clips are for, fails with a clear error
 * instead of a download of the whole file per segment.
 */
export const WHOLE_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

export interface SegmentStoreOptions {
    /** Decoded-audio budget in bytes. */
    maxBytes: number;
    /** Parallel fetches, urgent ones besides. Default 3. */
    concurrency?: number;
    /** Shared with the clip's other stores: whose urgent fetches these give way to. Default: this store's own. */
    priority?: LinkPriority;
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
    /** Asked for as urgent (the playhead waits for it): see LinkPriority. */
    urgent: boolean;
    /** Fetch from here first (a seek inside the segment), then the segment whole. */
    entry?: SegmentEntry;
}

export class SegmentStore {
    private readonly _sourceUrl: string;
    private readonly _manifest: AudioManifest;
    private readonly _files: FileAccess;
    private readonly _options: Required<SegmentStoreOptions>;
    private readonly _priority: LinkPriority;
    /** Aborted by dispose() and by the load's signal: ends the whole-file download too. */
    private readonly _life = new AbortController();
    private readonly _onAbort = () => this._cancelAll();
    /** The whole source, when its server answered a Range request with all of it (see WHOLE_SOURCE_MAX_BYTES). */
    private _whole: Promise<ArrayBuffer> | null = null;
    private _broken: SourceError | null = null;
    private readonly _cache = new Map<number, Entry>();
    /**
     * A segment decoded as it arrived came out wrong (its run not `skip` + `tail`, or the decode
     * failed): every segment after is decoded whole (see _streamOf).
     */
    private _wholeRuns = false;
    /** Segments on their way in parts: their frames [start, upto) as far as they have arrived (see arrived()). */
    private readonly _arriving = new Map<number, { job: Job; planes: Float32Array[]; start: number; upto: number }>();
    /** Each segment's entries (MP3, FLAC, Opus: setEntries()), in order of `at`. */
    private _entries: SegmentEntry[][] | null = null;
    private readonly _jobs = new Map<number, Job>();
    private _queue: Job[] = [];
    private _active = 0;
    private _tick = 0;
    private _bytes = 0;
    private _disposed = false;
    private _listeners = new Set<(index: number) => void>();
    private _partialListeners = new Set<PartialListener>();
    private _errorListeners = new Set<(index: number, error: Error, failures: number) => void>();
    /** Segments that failed: how often in a row, and when the next try may start. */
    private readonly _failures = new Map<number, { count: number; retryAt: number }>();
    private readonly _stats = { peak: 0, fetches: 0, fetchedBytes: 0, fetchMs: 0, decodeMs: 0, evictions: 0 };

    /** `files`: how the manifest's files are fetched (their URLs, the host's options, the load's signal). */
    constructor(files: FileAccess, manifest: AudioManifest, options: SegmentStoreOptions) {
        this._manifest = manifest;
        this._files = files;
        this._sourceUrl = files.resolve(manifest.segments.source.url, 'segments.source.url');
        this._options = { concurrency: 3, priority: new LinkPriority(), ...options };
        this._priority = this._options.priority;
        if (files.signal?.aborted) this._life.abort();
        else files.signal?.addEventListener('abort', this._onAbort);
    }

    /** Why the source cannot be played (see SourceError), or null. */
    get broken(): SourceError | null {
        return this._broken;
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

    /**
     * Called with each segment's frames as its bytes arrive, before it is whole (a WAV's PCM as
     * it comes; an MP3's, FLAC's or Opus's when its segments say their `skip`, else once its run
     * is whole). The listener may transfer the arrays.
     */
    onPartial(listener: PartialListener): () => void {
        this._partialListeners.add(listener);
        return () => this._partialListeners.delete(listener);
    }

    /**
     * The frames of a segment still on its way: [from, to) of its `total` are in, in `planes`
     * (the segment's length; not copies: read, do not keep). Null when none are. For a listener
     * that was not there, or did not want the segment yet, when its parts were handed out.
     */
    arrived(index: number): { from: number; to: number; planes: Float32Array[]; total: number } | null {
        const part = this._arriving.get(index);
        if (!part || part.upto <= part.start) return null;
        return { from: part.start, to: part.upto, planes: part.planes, total: part.planes[0].length };
    }

    /** The entries inside each segment (an MP3's, FLAC's or Opus's: its entries file), by segment. */
    setEntries(entries: SegmentEntry[][] | null): void {
        this._entries = entries;
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
     * Fetch + decode (deduplicated). `urgent` jumps the queue. `at` (urgent only): the playhead
     * waits for the segment's frames from there, so they are fetched first, from an entry near
     * it, and a fetch of it from its start still far from there is let go for that. Resolves
     * (with the whole segment) null if cancelled, at once while a failed segment waits for its
     * next retry, and at once for good once the source is `broken`.
     */
    load(index: number, urgent = false, at?: number): Promise<AudioBuffer | null> {
        const cached = this.get(index);
        if (cached) return Promise.resolve(cached);
        if (index < 0 || index >= this._manifest.segments.list.length || this._disposed || this._broken || this._life.signal.aborted) return Promise.resolve(null);
        const failed = this._failures.get(index);
        if (failed && performance.now() < failed.retryAt && !this._jobs.has(index)) return Promise.resolve(null);
        const entry = urgent && at !== undefined ? this._entryFor(index, at) : null;
        let existing = this._jobs.get(index);
        if (existing && entry && !existing.entry) {
            const arrived = this._arriving.get(index);
            const have = arrived?.job === existing ? arrived.upto : 0;
            if (entry.at - have >= ENTRY_MIN_SECONDS * this._manifest.sampleRate) {
                existing.controller.abort();
                this._finish(existing, null);
                existing = undefined;
            }
        }
        if (existing) {
            if (urgent && !existing.urgent) {
                existing.urgent = true;
                this._priority.set(existing, true);
                if (!existing.started) this._queue = [existing, ...this._queue.filter((j) => j !== existing)];
                this._drain();
            }
            return existing.promise;
        }
        let resolve!: (b: AudioBuffer | null) => void;
        const promise = new Promise<AudioBuffer | null>((r) => { resolve = r; });
        const job: Job = { index, controller: new AbortController(), promise, resolve, started: false, urgent, ...(entry ? { entry } : {}) };
        this._jobs.set(index, job);
        if (urgent) {
            this._queue.unshift(job);
            this._priority.set(job, true);
        } else {
            this._queue.push(job);
        }
        this._drain();
        return promise;
    }

    /**
     * An entry of segment `index` at or before frame `at` worth fetching from (it saves at least
     * ENTRY_MIN_SECONDS), or null. A WAV's is any frame; an MP3's, FLAC's or Opus's, the last of
     * its entries at or before `at`, while its runs are decoded as they arrive.
     */
    private _entryFor(index: number, at: number): SegmentEntry | null {
        const source = this._manifest.segments.source;
        const seg = this._manifest.segments.list[index];
        if (!seg.range || this._partialListeners.size === 0) return null;
        const lead = seg.lead ?? 0;
        const least = lead + ENTRY_MIN_SECONDS * this._manifest.sampleRate;
        if (source.codec === 'wav') {
            const pcm = source.pcm;
            const target = Math.min(Math.floor(at), lead + seg.tail - 1, seg.frames - 1);
            if (!pcm || target < least) return null;
            // The run frame of the segment's first sample, then the target's.
            const first = Math.floor((seg.range[1] - seg.range[0]) / pcm.blockAlign) - seg.tail;
            if (first < 0) return null;
            return { at: target, byte: seg.range[0] + (first + target - lead) * pcm.blockAlign, skip: 0 };
        }
        if (this._wholeRuns) return null;
        let best: SegmentEntry | null = null;
        for (const e of this._entries?.[index] ?? []) {
            if (e.at > at) break;
            best = e;
        }
        return best && best.at >= least ? best : null;
    }

    /**
     * Segments asked for as urgent that are not in `urgent` (the playhead has moved: a seek) are
     * fetched on as any other, giving way to the new playhead's.
     */
    relaxExcept(urgent: Set<number>): void {
        for (const job of this._jobs.values()) {
            if (!job.urgent || urgent.has(job.index)) continue;
            job.urgent = false;
            this._priority.set(job, false);
        }
        this._queue = [...this._queue.filter((j) => j.urgent), ...this._queue.filter((j) => !j.urgent)];
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
        this._files.signal?.removeEventListener('abort', this._onAbort);
        this._cancelAll();
        this._whole = null;
        this._cache.clear();
        this._bytes = 0;
        this._listeners.clear();
        this._partialListeners.clear();
        this._errorListeners.clear();
        this._failures.clear();
    }

    /** Abort every fetch, the whole-file download included; nothing is fetched after. */
    private _cancelAll(): void {
        this._life.abort();
        for (const job of [...this._jobs.values()]) {
            job.controller.abort();
            this._finish(job, null);
        }
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
        if (this._arriving.get(job.index)?.job === job) this._arriving.delete(job.index);
        this._queue = this._queue.filter((j) => j !== job);
        this._priority.set(job, false);
        job.resolve(buffer);
    }

    private _drain(): void {
        // An urgent job starts at once: the others give way to it on the link (see _fetchRun).
        while (this._queue.length > 0 && (this._active < this._options.concurrency || this._queue[0].urgent)) {
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
        let stream: ReturnType<SegmentStore['_streamOf']>;
        try {
            if (this._broken) {
                this._finish(job, null);
                return;
            }
            const seg = this._manifest.segments.list[job.index];
            const source = this._manifest.segments.source;
            let bytes: ArrayBuffer | null = null;
            let fetched = 0;
            let fromEntry = false;
            if (seg.range && job.entry) {
                // The frames the playhead waits for first, from the entry; then the segment whole,
                // behind whatever else the playhead waits for (no parts: those are handed out).
                fromEntry = true;
                const entry = job.entry;
                stream = source.codec === 'wav' ? undefined : this._streamOf(job, entry);
                if (stream) await decoderReady(source).catch(() => {});
                ({ fetched } = await this._fetchRun(job, entry.byte, seg.range[1], stream?.onBytes ?? this._partsOf(job, entry)));
                if (stream) await stream.settled();
                stream?.close();
                stream = undefined;
                if (job.controller.signal.aborted || this._disposed) {
                    this._finish(job, null);
                    return;
                }
                job.entry = undefined;
                if (job.urgent) {
                    job.urgent = false;
                    this._priority.set(job, false);
                }
            }
            if (seg.range) {
                // The codec's decoder before the run's bytes, the first time a clip of it plays:
                // fetched together, they would share the bandwidth the first sound waits for.
                if (!fromEntry) stream = this._streamOf(job);
                if (stream) await decoderReady(source).catch(() => {});
                const more = await this._fetchRun(job, seg.range[0], seg.range[1], fromEntry ? undefined : stream?.onBytes ?? this._partsOf(job));
                bytes = more.bytes;
                fetched += more.fetched;
                if (job.controller.signal.aborted || this._disposed) {
                    this._finish(job, null);
                    return;
                }
            }
            const t1 = performance.now();
            const streamed = stream ? await stream.settled() : !fromEntry;
            // Handed out in parts to the end: those frames are the segment, decoded already.
            const arrived = this._arriving.get(job.index);
            const whole = streamed && arrived?.job === job && arrived.start === 0 && arrived.upto === seg.frames ? arrived.planes : null;
            const run = bytes && !whole ? await decodeRun(source, bytes) : null;
            // (Should parts handed out have come out wrong, the listener gets the segment whole now: onLoad.)
            const buffer = this._toBuffer(whole ?? segmentFromRun(run, seg, this._manifest.channels));
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
            if (job.controller.signal.aborted || this._disposed || this._life.signal.aborted) {
                this._finish(job, null);
                return;
            }
            if (error instanceof SourceError) {
                // Reported once; the other segments would fail the same way: nothing more is fetched.
                const first = !this._broken;
                this._broken ??= error;
                this._finish(job, null);
                if (!first) return;
                console.warn('[AudioPlayer]', error.message);
                for (const other of [...this._jobs.values()]) {
                    other.controller.abort();
                    this._finish(other, null);
                }
                for (const listener of [...this._errorListeners]) listener(job.index, error, 1);
                return;
            }
            const count = (this._failures.get(job.index)?.count ?? 0) + 1;
            this._failures.set(job.index, { count, retryAt: performance.now() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (count - 1)) });
            console.warn('[AudioPlayer] segment failed', job.index, error);
            this._finish(job, null);
            const err = error instanceof Error ? error : new Error(String(error));
            for (const listener of [...this._errorListeners]) listener(job.index, err, count);
        } finally {
            stream?.close();
        }
    }

    /**
     * For a WAV source, what hands a segment's frames out as its bytes arrive (onPartial): the run's
     * frames as they come, placed as segmentFromRun places them (`lead` silence, the run counted
     * back from its end, `trail` silence), and kept for arrived(). Other codecs: undefined (their
     * runs decode whole).
     */
    private _partsOf(job: Job, entry?: SegmentEntry): ((bytes: Uint8Array, received: number) => void) | undefined {
        const source = this._manifest.segments.source;
        const pcm = source.pcm;
        const seg = this._manifest.segments.list[job.index];
        if (source.codec !== 'wav' || !pcm || !seg.range || this._partialListeners.size === 0) return undefined;
        // From an entry: a run from its byte, its first frame the segment's frame `at`.
        const start = entry?.at ?? 0;
        const lead = entry ? entry.at : seg.lead ?? 0;
        const tail = entry ? seg.tail - (entry.at - (seg.lead ?? 0)) : seg.tail;
        const rangeBytes = seg.range[1] - (entry?.byte ?? seg.range[0]);
        const runFrames = Math.floor(rangeBytes / pcm.blockAlign);
        const from = runFrames - tail;
        if (from < 0) return undefined;
        const count = Math.max(0, Math.min(seg.frames - lead - (seg.trail ?? 0), tail));
        const channels = this._manifest.channels;
        const minPart = Math.max(1, Math.round(PART_MIN_SECONDS * this._manifest.sampleRate));
        // The segment as far as it has come; each part handed out is a copy of its new frames.
        const kept = { job, planes: Array.from({ length: channels }, () => new Float32Array(seg.frames)), start, upto: start };
        this._arriving.set(job.index, kept);
        let sent = start;
        return (bytes, received) => {
            if (job.controller.signal.aborted || this._disposed) return;
            const whole = received >= rangeBytes;
            const runIn = Math.floor(received / pcm.blockAlign);
            const upto = whole ? seg.frames : Math.min(seg.frames, lead + Math.max(0, Math.min(count, runIn - from)));
            if (upto <= sent || (!whole && upto - sent < minPart)) return;
            // The part's frames that carry audio (not lead or trail silence).
            const audioFrom = Math.max(sent, lead);
            const audioTo = Math.min(upto, lead + count);
            if (audioTo > audioFrom) {
                const r0 = from + audioFrom - lead;
                const frames = audioTo - audioFrom;
                const run = decodeInterleaved({ encoding: pcm.encoding, bitsPerSample: pcm.bitsPerSample, channels: source.channels }, bytes.subarray(r0 * pcm.blockAlign, (r0 + frames) * pcm.blockAlign), frames);
                for (let c = 0; c < channels; c += 1) kept.planes[c].set(run[c % run.length], audioFrom);
            }
            const offset = sent;
            sent = upto;
            kept.upto = upto;
            for (const listener of [...this._partialListeners]) listener(job.index, offset, kept.planes.map((p) => p.slice(offset, upto)), seg.frames);
        };
    }

    /**
     * For an MP3, FLAC or Opus source whose segments say their `skip`, what decodes a segment's
     * run as its bytes arrive (RunDecoder.openRun, in the decode worker) and hands its frames out
     * as they come (onPartial), placed as segmentFromRun places them, and kept for arrived().
     * settled() resolves true once all of the segment came out so, false when it did not (the
     * decode failed, or the run did not come to `skip` + `tail` samples): the run is then
     * decoded whole, as without `skip`. Else undefined.
     */
    private _streamOf(job: Job, entry?: SegmentEntry): { onBytes: (bytes: Uint8Array, received: number) => void; settled: () => Promise<boolean>; close: () => void } | undefined {
        const source = this._manifest.segments.source;
        const seg = this._manifest.segments.list[job.index];
        const skip = entry ? entry.skip : seg.skip;
        if (source.codec === 'wav' || !seg.range || skip === undefined || this._wholeRuns || this._partialListeners.size === 0) return undefined;
        // From an entry: a run from its byte, its samples after `skip` the segment's from `at`.
        const start = entry?.at ?? 0;
        const lead = entry ? entry.at : seg.lead ?? 0;
        const tail = entry ? seg.tail - (entry.at - (seg.lead ?? 0)) : seg.tail;
        const rangeBytes = seg.range[1] - (entry?.byte ?? seg.range[0]);
        const count = Math.max(0, Math.min(seg.frames - lead - (seg.trail ?? 0), tail));
        const channels = this._manifest.channels;
        const minPart = Math.max(1, Math.round(PART_MIN_SECONDS * this._manifest.sampleRate));
        const kept = { job, planes: Array.from({ length: channels }, () => new Float32Array(seg.frames)), start, upto: start };
        this._arriving.set(job.index, kept);
        const opening = openRun(source);
        opening.catch(() => {});
        let fed = 0;
        let decoded = 0;
        let sent = start;
        let ended = false;
        let failed = false;
        /** The frames a push completed, placed; handed out once there are enough of them (or the run ended). */
        const place = (out: StreamOut, end: boolean) => {
            if (out.channels && (out.sampleRate !== source.sampleRate || out.channels !== source.channels)) {
                throw new Error(`the run decodes to ${out.sampleRate} Hz, ${out.channels} channel(s)`);
            }
            for (const block of out.planes) {
                const n = block[0].length;
                const from = Math.max(decoded, skip);
                const to = Math.min(decoded + n, skip + count);
                if (to > from) for (let c = 0; c < channels; c += 1) kept.planes[c].set(block[c % block.length].subarray(from - decoded, to - decoded), lead + from - skip);
                decoded += n;
            }
            if (end && decoded !== skip + tail) throw new Error(`its run came to ${decoded} samples, not ${skip} + ${tail}`);
            const upto = end ? seg.frames : Math.min(seg.frames, lead + Math.max(0, Math.min(count, decoded - skip)));
            ended = end;
            if (upto <= sent || (!end && upto - sent < minPart)) return;
            const offset = sent;
            sent = upto;
            kept.upto = upto;
            for (const listener of [...this._partialListeners]) listener(job.index, offset, kept.planes.map((p) => p.slice(offset, upto)), seg.frames);
        };
        let chain: Promise<void> = Promise.resolve();
        return {
            onBytes: (bytes, received) => {
                if (failed || job.controller.signal.aborted || this._disposed) return;
                const end = received >= rangeBytes;
                const piece = bytes.slice(fed, received);
                fed = received;
                chain = chain.then(async () => {
                    if (failed || job.controller.signal.aborted || this._disposed) return;
                    try {
                        place(await (await opening).push(piece, end), end);
                    } catch (error) {
                        if (job.controller.signal.aborted || this._disposed) return;
                        failed = true;
                        // A decoder that cannot be loaded fails the whole decode too; anything else
                        // is this way of decoding at fault: the rest are decoded whole.
                        this._wholeRuns = true;
                        console.warn(`[AudioPlayer] segment ${seg.index} could not be decoded as it arrived; decoding runs whole`, error);
                    }
                });
            },
            settled: () => chain.then(() => !failed && ended),
            close: () => {
                failed = true;
                void opening.then((decoding) => decoding.close(), () => {});
            },
        };
    }

    /**
     * The bytes [start, end) of the source: a Range request, checked; or, when
     * the server answers with the whole file, a slice of that (kept, see
     * WHOLE_SOURCE_MAX_BYTES). `fetched`: the bytes this call downloaded.
     * `onBytes`: called with the bytes so far as they arrive. A job the playhead does not wait for
     * gives way while one it waits for is on its way (this store's or the stem's: LinkPriority):
     * it lets go of its request, and once the link is free asks for the rest, from the byte it
     * had come to.
     */
    private async _fetchRun(job: Job, start: number, end: number, onBytes?: (bytes: Uint8Array, received: number) => void): Promise<{ bytes: ArrayBuffer; fetched: number }> {
        const signal = job.controller.signal;
        const kept = this._whole;
        if (kept) return { bytes: (await kept).slice(start, end), fetched: 0 };
        const url = this._sourceUrl;
        // A controller of its own: should this response be the whole file, it serves every
        // segment, and only the store's end stops it (not this segment's cancellation).
        let request = new AbortController();
        const cancel = () => request.abort();
        signal.addEventListener('abort', cancel);
        try {
            const response = await fetch(url, this._files.init(url, { range: `bytes=${start}-${end - 1}`, signal: request.signal }));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const whole = start === 0 && end === this._manifest.segments.source.bytes;
            if (response.status === 206 || whole) {
                if (response.status === 206) this._checkContentRange(response.headers.get('content-range'), start, end);
                // Read as it comes: its frames may be wanted before it is whole, and it may give way.
                if (response.body) {
                    const length = end - start;
                    const buf = new Uint8Array(length);
                    let reader = response.body.getReader();
                    let received = 0;
                    for (;;) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        if (received + value.byteLength > length) throw new Error(`more than ${length} bytes for a range of ${length}`);
                        buf.set(value, received);
                        received += value.byteLength;
                        onBytes?.(buf, received);
                        if (received === length || job.urgent || !this._priority.busy(job)) continue;
                        request.abort();
                        void reader.cancel().catch(() => {});
                        await this._priority.idle(job, signal);
                        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
                        request = new AbortController();
                        const rest = await fetch(url, this._files.init(url, { range: `bytes=${start + received}-${end - 1}`, signal: request.signal }));
                        if (rest.status !== 206 || !rest.body) throw new Error(`HTTP ${rest.status} for the rest of a range`);
                        this._checkContentRange(rest.headers.get('content-range'), start + received, end);
                        reader = rest.body.getReader();
                    }
                    if (received !== length) throw new Error(`${received} bytes for a range of ${length}`);
                    return { bytes: buf.buffer, fetched: received };
                }
                const bytes = await response.arrayBuffer();
                if (bytes.byteLength !== end - start) throw new Error(`${bytes.byteLength} bytes for a range of ${end - start}`);
                return { bytes, fetched: bytes.byteLength };
            }
            // 200: the server ignored the Range header and sends all of the file. Another
            // segment's answer may be bringing it already.
            if (this._whole) {
                void response.body?.cancel().catch(() => {});
                return { bytes: (await this._whole).slice(start, end), fetched: 0 };
            }
            signal.removeEventListener('abort', cancel);
            this._life.signal.addEventListener('abort', cancel);
            const reading = this._readWhole(response);
            this._whole = reading;
            // A failed download is tried again by the next segment (a SourceError breaks the store instead).
            reading.catch(() => {
                if (this._whole === reading) this._whole = null;
            });
            const all = await reading;
            return { bytes: all.slice(start, end), fetched: all.byteLength };
        } finally {
            signal.removeEventListener('abort', cancel);
            this._life.signal.removeEventListener('abort', cancel);
        }
    }

    /**
     * A 206's Content-Range must start at the byte asked for, and give the size the
     * manifest has (another size: the file was replaced). Unreadable cross-origin
     * without Access-Control-Expose-Headers (null): not checked then.
     */
    private _checkContentRange(header: string | null, start: number, end: number): void {
        const m = header === null ? null : /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
        if (!m) return;
        const bytes = this._manifest.segments.source.bytes;
        if (Number(m[1]) !== start) throw new SourceError(`${this._sourceUrl} answered bytes ${m[1]}-${m[2]} to a request for ${start}-${end - 1}`);
        if (m[3] !== '*' && Number(m[3]) !== bytes) throw new SourceError(`${this._sourceUrl} is ${m[3]} bytes, its manifest says ${bytes}: the file changed`);
    }

    /** The whole source from a 200 to a Range request, up to WHOLE_SOURCE_MAX_BYTES; a bigger one is refused, its download cancelled. */
    private async _readWhole(response: Response): Promise<ArrayBuffer> {
        const refuse = () => new SourceError(`The server ignores HTTP Range requests: ${this._sourceUrl} (a prepared clip over ${WHOLE_SOURCE_MAX_BYTES / 2 ** 20} MB needs them)`);
        const header = response.headers.get('content-length');
        const declared = header === null ? NaN : Number(header);
        if (declared > WHOLE_SOURCE_MAX_BYTES) {
            void response.body?.cancel().catch(() => {});
            throw refuse();
        }
        const reader = response.body?.getReader();
        let all: ArrayBuffer;
        if (!reader) {
            all = await response.arrayBuffer();
        } else {
            // Into one buffer of the declared size when there is one (a compressed response may grow it).
            let out = new Uint8Array(declared > 0 ? declared : 1 << 20);
            let total = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (total + value.byteLength > WHOLE_SOURCE_MAX_BYTES) {
                    void reader.cancel().catch(() => {});
                    throw refuse();
                }
                if (total + value.byteLength > out.length) {
                    const grown = new Uint8Array(Math.min(WHOLE_SOURCE_MAX_BYTES, Math.max(2 * out.length, total + value.byteLength)));
                    grown.set(out.subarray(0, total));
                    out = grown;
                }
                out.set(value, total);
                total += value.byteLength;
            }
            all = total === out.length ? out.buffer : out.slice(0, total).buffer;
        }
        const bytes = this._manifest.segments.source.bytes;
        if (all.byteLength !== bytes) throw new SourceError(`${this._sourceUrl} is ${all.byteLength} bytes, its manifest says ${bytes}: the file changed`);
        return all;
    }

    /** The segment's frames at the timeline's rate (the engine converts to the context's). */
    private _toBuffer(planes: Float32Array[]): AudioBuffer {
        const buffer = new AudioBuffer({ length: Math.max(1, planes[0]?.length ?? 1), numberOfChannels: planes.length, sampleRate: this._manifest.sampleRate });
        planes.forEach((data, c) => buffer.copyToChannel(data, c));
        return buffer;
    }
}
