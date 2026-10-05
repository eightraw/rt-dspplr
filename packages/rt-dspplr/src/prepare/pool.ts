import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { runJob, resultTransfers, type AnyJob, type AnyResult } from './jobs';

// ---------------------------------------------------------------------------
// A small worker_threads pool for prepare's analysis jobs. The worker script
// is `prepare-worker.mjs` next to the bundle (dist/ or the test cache). When it
// cannot start (another bundler, a sandbox), jobs run inline on the main
// thread: same function, same output, only slower.
// ---------------------------------------------------------------------------

export function defaultConcurrency(): number {
    const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, cores - 1);
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

    constructor(concurrency: number, workerUrl?: URL) {
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
            this._workers.push(worker);
            this._idle.push(worker);
        }
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
            worker.postMessage(job, job.channels.map((c) => c.buffer as ArrayBuffer));
        }
    }

    private _done(worker: Worker, result: AnyResult): void {
        const pending = this._busy.get(worker);
        this._busy.delete(worker);
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
