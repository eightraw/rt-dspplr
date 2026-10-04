import { audioBufferId, pcmCache } from '../cache/pcmCache';
import { normalizeSpeed } from '../controls';
import type { StretchWorkerMessage, StretchWorkerRequest } from './protocol';
import type { StretchStrategy } from './strategies';

// ---------------------------------------------------------------------------
// StretchService — pool of stretch workers + cache of rendered speed variants
// ---------------------------------------------------------------------------
//
// A "variant" is the source clip pre-rendered at another speed with the pitch
// preserved. Playing it at playbackRate 1 sounds like the clip at that speed.
// Variants are rendered off the main thread, once per (source buffer, speed),
// and stored in the shared PcmCache so they count against the same byte
// budget as decoded audio.
//
// Scheduling:
//   - 'playback' jobs (the speed the listener actually selected) always run
//     before 'prewarm' jobs, and a queued prewarm job is promoted when the
//     same variant is requested for playback;
//   - prewarm jobs of a clip can be cancelled (e.g. when the listener moves on
//     to another clip) as long as they have not reached a worker yet;
//   - channel data is copied for the worker only at dispatch time, so a long
//     prewarm queue does not hold extra copies of the PCM.

export type StretchPriority = 'playback' | 'prewarm';

/** Thrown when the strategy has no worker (native strategy, CSP, worker crash loop). */
export class StretchUnavailableError extends Error {
    constructor(message = 'No stretch worker available') {
        super(message);
        this.name = 'StretchUnavailableError';
    }
}

function abortError(): Error {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('Stretch job cancelled', 'AbortError');
    }
    const error = new Error('Stretch job cancelled');
    error.name = 'AbortError';
    return error;
}

interface Job {
    key: string;
    sourceId: number;
    source: AudioBuffer;
    speed: number;
    transientSensitivity: number;
    context: BaseAudioContext;
    priority: StretchPriority;
    seq: number;
    resolve: (buffer: AudioBuffer) => void;
    reject: (error: unknown) => void;
}

interface WorkerSlot {
    worker: Worker | null;
    busy: boolean;
    current: { requestId: number; job: Job } | null;
    /** Crashes in a row; a job that completes resets it. */
    failures: number;
    /** The watchdog of the running job. */
    timer: ReturnType<typeof setTimeout> | null;
}

const MAX_WORKER_RESTARTS = 3;

function defaultPoolSize(): number {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 2 : 2;
    return Math.max(1, Math.min(2, cores - 1 || 1));
}

function speedCacheKey(speed: number): string {
    return normalizeSpeed(speed).toFixed(4);
}

function isUnitSpeed(speed: number): boolean {
    return Math.abs(speed - 1) < 1e-6;
}

export class StretchService {
    private static readonly _byStrategy = new Map<string, StretchService>();

    /** One service per strategy id, shared by every player using that strategy. */
    static forStrategy(strategy: StretchStrategy): StretchService {
        let service = StretchService._byStrategy.get(strategy.id);
        if (!service) {
            service = new StretchService(strategy);
            StretchService._byStrategy.set(strategy.id, service);
        }
        return service;
    }

    /**
     * How long a job may run before its worker is taken for dead: at least
     * 10 s, and two seconds per second of audio per channel. A worker that dies
     * without an `error` event would otherwise keep its slot (and the player's
     * pending speed) forever. Replaceable, for tests.
     */
    static jobTimeoutMs = (seconds: number, channels: number): number => Math.max(10_000, seconds * channels * 2000);

    readonly strategy: StretchStrategy;

    private _nextRequestId = 1;
    private _nextSeq = 1;
    private _queue: Job[] = [];
    private _inflight = new Map<string, { job: Job; promise: Promise<AudioBuffer> }>();
    private _slots: WorkerSlot[] | null = null;

    private constructor(strategy: StretchStrategy) {
        this.strategy = strategy;
    }

    /** Whether at least one worker is (or can be) running. */
    get available(): boolean {
        return this._ensureSlots().some((slot) => slot.worker !== null);
    }

    /**
     * Resolve the variant of `source` at `speed`, rendering it if needed.
     * Speed 1 resolves to the source itself. Rejects with
     * StretchUnavailableError when no worker can run, so callers can fall back
     * to native playbackRate.
     */
    ensureVariant(
        context: BaseAudioContext,
        source: AudioBuffer,
        speed: number,
        priority: StretchPriority = 'playback',
        transientSensitivity = 0.5,
    ): Promise<AudioBuffer> {
        const normalizedSpeed = normalizeSpeed(speed);
        if (isUnitSpeed(normalizedSpeed)) {
            return Promise.resolve(source);
        }

        const sourceId = audioBufferId(source);
        // The strategy is part of the key: two algorithms produce different
        // renders of the same clip and must not reuse each other's.
        const key = `variant:${this.strategy.id}:${sourceId}:${speedCacheKey(normalizedSpeed)}`;

        const cached = pcmCache.get(key);
        if (cached) {
            return Promise.resolve(cached);
        }

        const inflight = this._inflight.get(key);
        if (inflight) {
            if (priority === 'playback' && inflight.job.priority === 'prewarm') {
                inflight.job.priority = 'playback';
                this._sortQueue();
            }
            return inflight.promise;
        }

        if (!this.available) {
            return Promise.reject(new StretchUnavailableError());
        }

        let job!: Job;
        const promise = new Promise<AudioBuffer>((resolve, reject) => {
            job = {
                key,
                sourceId,
                source,
                speed: normalizedSpeed,
                transientSensitivity,
                context,
                priority,
                seq: this._nextSeq++,
                resolve,
                reject,
            };
        });

        this._inflight.set(key, { job, promise });
        // Callers attach their own handlers; this one only keeps an
        // unobserved prewarm failure from surfacing as an unhandled rejection.
        promise.catch(() => undefined);

        this._queue.push(job);
        this._sortQueue();
        this._schedule();
        return promise;
    }

    /**
     * Queue background renders of `source` at `speeds`. `preferred` (usually
     * the currently selected speed) is queued first.
     */
    prewarm(
        context: BaseAudioContext,
        source: AudioBuffer,
        speeds: readonly number[],
        preferred?: number,
    ): void {
        if (!this.available) return;

        const isPreferred = (speed: number) => typeof preferred === 'number' && Math.abs(speed - preferred) < 1e-6;
        const ordered = speeds
            .filter((speed) => !isUnitSpeed(normalizeSpeed(speed)))
            .sort((a, b) => Number(isPreferred(b)) - Number(isPreferred(a)));

        // Speculative renders must fit beside what the cache already holds: the
        // decoded clips and variants of every player on the page. Counting only
        // this clip's source let a prewarm evict another player's variants.
        // Explicit playback requests may exceed the budget and remain uncached.
        let remaining = Math.max(0, pcmCache.budgetBytes - pcmCache.stats().usedBytes);
        for (const speed of [...new Set(ordered)]) {
            const bytes = Math.round(source.length / speed) * source.numberOfChannels * 4;
            if (bytes > remaining) continue;
            remaining -= bytes;
            void this.ensureVariant(context, source, speed, 'prewarm').catch((error: unknown) => {
                const name = (error as { name?: string } | null)?.name;
                if (name === 'AbortError' || name === 'StretchUnavailableError') return;
                console.warn('[StretchService] Failed to prewarm speed variant', speed, error);
            });
        }
    }

    /**
     * Drop queued prewarm jobs. With `source`, only that clip's jobs; without,
     * all of them. Jobs already running in a worker finish normally.
     */
    cancelPrewarm(source?: AudioBuffer): void {
        const sourceId = source ? audioBufferId(source) : null;
        const kept: Job[] = [];
        for (const job of this._queue) {
            if (job.priority === 'prewarm' && (sourceId === null || job.sourceId === sourceId)) {
                this._inflight.delete(job.key);
                job.reject(abortError());
            } else {
                kept.push(job);
            }
        }
        this._queue = kept;
    }

    /** Number of jobs waiting for a worker (diagnostics). */
    get queuedJobs(): number {
        return this._queue.length;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private _sortQueue(): void {
        this._queue.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority === 'playback' ? -1 : 1;
            return a.seq - b.seq;
        });
    }

    private _ensureSlots(): WorkerSlot[] {
        if (!this._slots) {
            const size = Math.max(1, Math.floor(this.strategy.poolSize ?? defaultPoolSize()));
            this._slots = Array.from({ length: size }, () => this._createSlot());
        }
        return this._slots;
    }

    private _schedule(): void {
        for (const slot of this._ensureSlots()) {
            if (slot.busy || slot.worker === null) {
                continue;
            }

            const job = this._queue.shift();
            if (!job) {
                return;
            }

            const requestId = this._nextRequestId++;
            const channels: ArrayBuffer[] = [];
            for (let index = 0; index < job.source.numberOfChannels; index += 1) {
                // A copy: the worker gets (and owns) its own PCM, the source
                // buffer stays playable on the main thread.
                channels.push(job.source.getChannelData(index).slice().buffer);
            }

            const request: StretchWorkerRequest = {
                type: 'stretch',
                requestId,
                sampleRate: job.source.sampleRate,
                speed: job.speed,
                transientSensitivity: job.transientSensitivity,
                channels,
                options: this.strategy.options,
            };

            slot.busy = true;
            slot.current = { requestId, job };
            try {
                slot.worker.postMessage(request, channels);
            } catch (error) {
                // Options that cannot be cloned (a function, say) never reach the worker:
                // the job fails here, the slot stays free, and playback falls back.
                slot.busy = false;
                slot.current = null;
                this._settle(job, new StretchUnavailableError(`The stretch request could not be sent: ${error instanceof Error ? error.message : String(error)}`));
                continue;
            }
            const worker = slot.worker;
            slot.timer = setTimeout(() => {
                slot.timer = null;
                if (slot.current?.requestId !== requestId || slot.worker !== worker) return;
                this._crash(slot, worker, new Error('Stretch job timed out'));
            }, StretchService.jobTimeoutMs(job.source.duration, job.source.numberOfChannels));
        }

        // No live worker left at all: fail what is queued so callers fall back.
        if (this._queue.length > 0 && !this._ensureSlots().some((slot) => slot.worker !== null)) {
            const queued = this._queue;
            this._queue = [];
            for (const job of queued) {
                this._settle(job, new StretchUnavailableError('Stretch workers stopped'));
            }
        }
    }

    private _settle(job: Job, result: AudioBuffer | Error): void {
        if (this._inflight.get(job.key)?.job === job) {
            this._inflight.delete(job.key);
        }
        if (result instanceof Error) {
            job.reject(result);
            return;
        }
        pcmCache.set(job.key, result);
        job.resolve(result);
    }

    /** Clear the watchdog of the slot's running job. */
    private _disarm(slot: WorkerSlot): void {
        if (slot.timer !== null) {
            clearTimeout(slot.timer);
            slot.timer = null;
        }
    }

    /**
     * A worker crashed, or its job ran past the watchdog: fail the job, drop the
     * worker and start another, but not forever. A worker that cannot even start
     * (bad script, blocked by CSP at load time) would otherwise respawn in a
     * tight loop. Three crashes in a row retire the slot; a completed job resets
     * the count, so a rare crash does not switch pitch preservation off for good.
     */
    private _crash(slot: WorkerSlot, worker: Worker, error: Error): void {
        this._disarm(slot);
        const failed = slot.current;
        slot.busy = false;
        slot.current = null;
        if (failed) {
            this._settle(failed.job, error);
        }

        try {
            worker.terminate();
        } catch {
            // no-op
        }

        slot.failures += 1;
        const replacement = slot.failures <= MAX_WORKER_RESTARTS ? this.strategy.createWorker() : null;
        slot.worker = replacement;
        if (replacement) {
            this._attach(slot, replacement);
        }
        this._schedule();
    }

    private _attach(slot: WorkerSlot, worker: Worker): void {
        worker.onmessage = (event: MessageEvent<StretchWorkerMessage>) => {
            const message = event.data;
            if (!message || !slot.current || message.requestId !== slot.current.requestId) {
                return;
            }

            this._disarm(slot);
            const { job } = slot.current;
            slot.busy = false;
            slot.current = null;
            slot.failures = 0;

            if (message.type === 'stretch-error') {
                this._settle(job, new Error(message.message || 'Stretch failed'));
            } else {
                try {
                    const length = Math.max(0, Math.floor(message.length));
                    const buffer = job.context.createBuffer(message.channels.length, Math.max(1, length), message.sampleRate);
                    message.channels.forEach((channelBuffer, channelIndex) => {
                        // Honour `length`: never assume the transferred
                        // ArrayBuffer is exactly as long as the stretched audio.
                        const frames = Math.min(length, Math.floor(channelBuffer.byteLength / 4));
                        buffer.copyToChannel(new Float32Array(channelBuffer, 0, frames), channelIndex);
                    });
                    this._settle(job, buffer);
                } catch (error) {
                    this._settle(job, error instanceof Error ? error : new Error(String(error)));
                }
            }

            this._schedule();
        };

        worker.onerror = (event) => {
            event.preventDefault?.();
            this._crash(slot, worker, event.error instanceof Error ? event.error : new Error(event.message || 'Stretch worker failed'));
        };
    }

    private _createSlot(): WorkerSlot {
        const slot: WorkerSlot = {
            worker: this.strategy.createWorker(),
            busy: false,
            current: null,
            failures: 0,
            timer: null,
        };
        if (slot.worker) {
            this._attach(slot, slot.worker);
        }
        return slot;
    }
}
