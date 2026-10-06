import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { jobTransfers, runJob, resultTransfers, type AnyJob, type AnyResult } from './jobs';

// ---------------------------------------------------------------------------
// A small worker_threads pool for prepare's analysis jobs. The worker script
// is `prepare-worker.mjs` next to the bundle (dist/ or the test cache). When it
// cannot start (another bundler, a sandbox), jobs run inline on the main
// thread: same function, same output, only slower.
// ---------------------------------------------------------------------------

function cores(): number {
    return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

export function defaultConcurrency(): number {
    return Math.max(1, cores() - 1);
}

/**
 * Inputs below this (about two minutes of 16-bit stereo at 48 kHz) are analysed on the
 * main thread when no pool is given: a pool made for one call starts its workers cold
 * (tens of ms each, and their code unoptimised), which a short recording never pays back.
 */
export const SHORT_INPUT_BYTES = 24 * 1024 * 1024;

/** Threads for one call without a shared pool: `concurrency` if given, else none for a short input, else cores − 1. */
export function callConcurrency(concurrency: number | undefined, inputBytes: number | null): number {
    if (concurrency !== undefined) return concurrency;
    if (inputBytes !== null && inputBytes < SHORT_INPUT_BYTES) return 1;
    return defaultConcurrency();
}

/**
 * Analysis threads kept for many prepare calls - a service's, made once at start-up
 * and passed to every prepareAudio() / attachStem() as `pool`. Warm workers make short
 * recordings as fast as long ones: no start-up per call, and code the JIT has already
 * optimised. Idle workers do not keep the process alive. Calls may share it (jobs queue
 * in order). After a worker fails (`failed` is set) every call through it fails: make a
 * new pool. `close()` ends the workers.
 */
export interface PreparePool {
    readonly size: number;
    /** False when the worker script could not be found: jobs then run on the calling thread. */
    readonly threaded: boolean;
    readonly failed: Error | null;
    close(): Promise<void>;
}

/**
 * A pool to keep (see PreparePool). Default size: every core but one, and at least two
 * on a machine with two or more (one worker is slower than none).
 */
export function createPreparePool(options: { concurrency?: number; workerUrl?: URL } = {}): PreparePool {
    const size = options.concurrency ?? (cores() >= 2 ? Math.max(2, defaultConcurrency()) : 1);
    return new JobPool(size, options.workerUrl, true);
}

interface Pending {
    resolve: (r: AnyResult) => void;
    reject: (e: unknown) => void;
}

export class JobPool {
    readonly size: number;
    readonly threaded: boolean;
    private readonly _workers: Worker[] = [];
    private readonly _idle: Worker[] = [];
    private readonly _queue: Array<{ job: AnyJob; pending: Pending }> = [];
    private readonly _busy = new Map<Worker, Pending>();
    private _failed: Error | null = null;
    /** Kept between calls: idle workers are unref'd, close() is the owner's. */
    readonly shared: boolean;

    constructor(concurrency: number, workerUrl?: URL, shared = false) {
        this.shared = shared;
        const size = Math.max(1, Math.floor(concurrency));
        let url: URL | null = null;
        try {
            url = workerUrl ?? new URL('./prepare-worker.mjs', import.meta.url);
            if (url.protocol !== 'file:' || !fs.existsSync(fileURLToPath(url))) url = null;
        } catch {
            url = null;
        }
        this.threaded = size > 1 && url !== null;
        this.size = this.threaded ? size : 1;
        if (!this.threaded || !url) return;
        for (let i = 0; i < size; i += 1) {
            // Small heaps: a job is a few MB in and out; the default young generation
            // let each idle worker sit on tens of MB of garbage.
            const worker = new Worker(url, { resourceLimits: { maxYoungGenerationSizeMb: 4, maxOldGenerationSizeMb: 48 } });
            worker.on('message', (result: AnyResult) => this._done(worker, result));
            worker.on('error', (error) => this._fail(worker, error));
            if (shared) worker.unref();
            this._workers.push(worker);
            this._idle.push(worker);
        }
    }

    get failed(): Error | null {
        return this._failed;
    }

    /** Jobs queued or running. */
    get pending(): number {
        return this._queue.length + this._busy.size;
    }

    run(job: AnyJob): Promise<AnyResult> {
        if (this._failed) return Promise.reject(this._failed);
        if (!this.threaded) {
            try {
                return Promise.resolve(runJob(job));
            } catch (error) {
                return Promise.reject(error);
            }
        }
        return new Promise<AnyResult>((resolve, reject) => {
            this._queue.push({ job, pending: { resolve, reject } });
            this._drain();
        });
    }

    async close(): Promise<void> {
        await Promise.all(this._workers.map((w) => w.terminate()));
    }

    private _drain(): void {
        while (this._idle.length > 0 && this._queue.length > 0) {
            const worker = this._idle.pop()!;
            const { job, pending } = this._queue.shift()!;
            this._busy.set(worker, pending);
            if (this.shared) worker.ref();
            worker.postMessage(job, jobTransfers(job));
        }
    }

    private _done(worker: Worker, result: AnyResult): void {
        const pending = this._busy.get(worker);
        this._busy.delete(worker);
        if (this.shared) worker.unref();
        this._idle.push(worker);
        pending?.resolve(result);
        this._drain();
    }

    private _fail(worker: Worker, error: unknown): void {
        this._failed = error instanceof Error ? error : new Error(String(error));
        const pending = this._busy.get(worker);
        this._busy.delete(worker);
        pending?.reject(this._failed);
        for (const { pending: p } of this._queue.splice(0)) p.reject(this._failed);
    }
}

export { resultTransfers };
