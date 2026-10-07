// Entry of prepare's worker threads (built to prepare-worker.mjs): runs analysis jobs.
import { parentPort } from 'node:worker_threads';
import { anyResultTransfers, runJob, type AnyJob } from './jobs';

parentPort?.on('message', (job: AnyJob) => {
    const result = runJob(job);
    parentPort?.postMessage(result, anyResultTransfers(result));
});
