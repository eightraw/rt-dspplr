// Node tests for the offline stretch pipeline (an offline strategy such as
// Rubber Band; run: npm test). Bundled by build/test-node.mjs with esbuild; no
// browser needed.
//
//  1. Rubber Band's output is N / speed frames long, although its raw output
//     buffers are longer: wrapping a whole `channel.buffer` would add frames.
//  2. Speed variants are accounted in the shared PCM byte budget.
//  3. Prewarm puts the selected speed first, a playback request promotes a
//     queued prewarm job, and cancelPrewarm() drops queued jobs.
//  4. A silent worker is replaced by the watchdog; crashes are forgiven once a
//     job completes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { RubberBandInterface } from 'rubberband-wasm';
import { runStretchRequest, type StretchWorkerRequest } from '../src/core/stretch/protocol';
import { processWithRubberBand } from '../src/stretch-rubberband/rubberbandCore';
import { StretchService, StretchUnavailableError } from '../src/core/stretch/StretchService';
import type { StretchStrategy } from '../src/core/stretch/strategies';
import { getAudioCacheStats, setAudioCacheBudget, clearAudioCache } from '../src/core/cache/pcmCache';

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 48000;
const results: string[] = [];

function makeSignal(frames: number): Float32Array {
    const out = new Float32Array(frames);
    let seed = 1;
    for (let i = 0; i < frames; i += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const noise = (seed / 0x7fffffff - 0.5) * 0.05;
        out[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * (0.5 + 0.5 * Math.sin((2 * Math.PI * 3 * i) / SAMPLE_RATE)) + noise;
    }
    return out;
}

function request(channels: Float32Array[], speed: number): StretchWorkerRequest {
    return {
        type: 'stretch',
        requestId: 1,
        sampleRate: SAMPLE_RATE,
        speed,
        transientSensitivity: 0.5,
        channels: channels.map((channel) => channel.slice().buffer),
    };
}

// Frames a receiver would get by wrapping the whole underlying ArrayBuffer.
function wholeBufferFrames(view: Float32Array): number {
    return new Float32Array(view.buffer).length;
}

async function testLengths(): Promise<void> {
    const frames = SAMPLE_RATE * 3;
    const source = [makeSignal(frames)];

    const wasmPath = require.resolve('rubberband-wasm/dist/rubberband.wasm');
    const api = await RubberBandInterface.initialize(await WebAssembly.compile(fs.readFileSync(wasmPath)));
    for (const speed of [1.25, 1.5, 2]) {
        const target = frames / speed;
        const rbOut = processWithRubberBand(api, source.map((c) => c.slice()), SAMPLE_RATE, speed);
        const rbWhole = wholeBufferFrames(rbOut[0]);
        const rb = await runStretchRequest(request(source, speed), (channels, sr, s) => processWithRubberBand(api, channels, sr, s));
        const produced = rb.response.length;
        assert.equal(rb.response.channels[0].byteLength / 4, produced, 'rubberband transferred buffer == length');
        assert.ok(Math.abs(produced - target) <= SAMPLE_RATE * 0.005, `rubberband length within 5 ms of N/speed at ${speed}x (got ${produced}, target ${target})`);
        assert.ok(rbWhole - produced >= 8000, 'the raw rubberband buffer carries the 8192-frame over-allocation');
        results.push(`rubberband ${speed}x: target ${target.toFixed(0)} frames | whole buffer ${rbWhole} (+${rbWhole - produced} = ${((rbWhole - produced) / SAMPLE_RATE * 1000).toFixed(0)} ms of zeros) | fixed ${produced}`);
    }
}

// ---- Fakes for StretchService ------------------------------------------------

class FakeAudioBuffer {
    readonly numberOfChannels: number;
    readonly length: number;
    readonly sampleRate: number;
    private readonly data: Float32Array[];

    constructor(channels: number, length: number, sampleRate: number) {
        this.numberOfChannels = channels;
        this.length = length;
        this.sampleRate = sampleRate;
        this.data = Array.from({ length: channels }, () => new Float32Array(length));
    }

    get duration(): number {
        return this.length / this.sampleRate;
    }

    getChannelData(index: number): Float32Array {
        return this.data[index];
    }

    copyToChannel(source: Float32Array, index: number): void {
        this.data[index].set(source.subarray(0, this.length));
    }
}

const fakeContext = {
    createBuffer: (channels: number, length: number, sampleRate: number) => new FakeAudioBuffer(channels, length, sampleRate),
} as unknown as BaseAudioContext;

interface FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: unknown;
    posted: StretchWorkerRequest[];
    postMessage(message: StretchWorkerRequest): void;
    terminate(): void;
    /** Complete the oldest posted request with a correctly sized output. */
    finish(): void;
}

function makeFakeWorker(): FakeWorker {
    const worker: FakeWorker = {
        onmessage: null,
        onerror: null,
        posted: [],
        postMessage(message) {
            this.posted.push(message);
        },
        terminate() {},
        finish() {
            const next = this.posted.shift();
            if (!next) throw new Error('nothing to finish');
            const length = Math.round((next.channels[0].byteLength / 4) / next.speed);
            this.onmessage?.({
                data: {
                    type: 'stretch-complete',
                    requestId: next.requestId,
                    sampleRate: next.sampleRate,
                    length,
                    // Deliberately over-long, like an over-allocated stretcher
                    // output: the service must honour `length`.
                    channels: next.channels.map(() => new Float32Array(length + 8192).buffer),
                },
            });
        },
    };
    return worker;
}

let strategySeq = 0;
function fakeStrategy(): { strategy: StretchStrategy; worker: FakeWorker } {
    const worker = makeFakeWorker();
    const strategy: StretchStrategy = {
        id: `fake-${++strategySeq}`,
        poolSize: 1,
        createWorker: () => worker as unknown as Worker,
    };
    return { strategy, worker };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function testBudgetAndScheduling(): Promise<void> {
    clearAudioCache();
    setAudioCacheBudget(150 * 1024 * 1024);

    const { strategy, worker } = fakeStrategy();
    const service = StretchService.forStrategy(strategy);
    const source = new FakeAudioBuffer(1, SAMPLE_RATE * 10, SAMPLE_RATE) as unknown as AudioBuffer;
    const sourceBytes = source.length * 4;

    // Prewarm with the selected speed (2x) first.
    service.prewarm(fakeContext, source, [1.25, 1.5, 2], 2);
    assert.equal(worker.posted.length, 1, 'one job dispatched (pool size 1)');
    assert.equal(worker.posted[0].speed, 2, 'selected speed is rendered first');
    assert.equal(service.queuedJobs, 2);

    // A playback request for 1.5x jumps ahead of the queued 1.25x prewarm.
    const playback = service.ensureVariant(fakeContext, source, 1.5, 'playback');
    worker.finish(); // completes 2x
    await tick();
    assert.equal(worker.posted[0].speed, 1.5, 'playback request promoted ahead of prewarm');
    worker.finish(); // completes 1.5x
    const variant = await playback;
    assert.equal(variant.length, Math.round(source.length / 1.5), 'service trims to `length`, not the transferred buffer size');
    await tick();

    const stats = getAudioCacheStats();
    assert.equal(stats.variantEntries, 2, '2x and 1.5x variants are in the shared cache');
    const expectedBytes = (Math.round(source.length / 2) + Math.round(source.length / 1.5)) * 4;
    assert.equal(stats.usedBytes, expectedBytes, 'variant bytes are counted in the budget');
    results.push(`budget: 10 s mono source = ${sourceBytes} B; after 2x + 1.5x variants the shared cache holds ${stats.usedBytes} B in ${stats.variantEntries} variant entries`);

    // Cancel: the queued 1.25x prewarm is dropped, the running one (if any) is not touched.
    assert.equal(service.queuedJobs, 0, '1.25x is now running');
    const source2 = new FakeAudioBuffer(1, SAMPLE_RATE * 4, SAMPLE_RATE) as unknown as AudioBuffer;
    service.prewarm(fakeContext, source2, [1.25, 1.5, 2], 1);
    assert.equal(service.queuedJobs, 3, 'three prewarm jobs of the second clip queued behind the running job');
    service.cancelPrewarm(source2);
    assert.equal(service.queuedJobs, 0, 'cancelPrewarm drops queued jobs of that clip');
    worker.finish(); // finish 1.25x of the first clip
    await tick();
    assert.equal(worker.posted.length, 0, 'nothing of the cancelled clip reached the worker');
    results.push('prewarm: selected speed first; playback request promoted over queued prewarm; cancelPrewarm dropped 3 queued jobs');

    // Budget eviction covers variants too.
    setAudioCacheBudget(sourceBytes);
    const after = getAudioCacheStats();
    assert.ok(after.usedBytes <= sourceBytes, 'shrinking the budget evicts variants');
    results.push(`budget shrink to ${sourceBytes} B -> ${after.usedBytes} B used, ${after.variantEntries} variant entries left`);

    // A strategy without a worker: callers get StretchUnavailableError and fall back to playbackRate.
    const none = StretchService.forStrategy({ id: 'no-worker', createWorker: () => null });
    await assert.rejects(none.ensureVariant(fakeContext, source, 1.5), StretchUnavailableError);
    results.push('a strategy without a worker: ensureVariant rejects with StretchUnavailableError (Track falls back to playbackRate)');

    // Speculative renders must fit beside what the cache already holds: with one
    // variant in the cache, only the headroom left over is spent on another clip's.
    const held = getAudioCacheStats().usedBytes;
    const smallest = Math.round(source.length / 2) * 4;
    const limited = fakeStrategy();
    const limitedService = StretchService.forStrategy(limited.strategy);
    setAudioCacheBudget(held + smallest - 1);
    limitedService.prewarm(fakeContext, source, [1.25, 1.5, 2], 2);
    assert.equal(limited.worker.posted.length, 0, 'no room for any variant beside what the cache holds');
    setAudioCacheBudget(held + smallest);
    limitedService.prewarm(fakeContext, source, [1.25, 1.5, 2], 2);
    assert.equal(limited.worker.posted.length, 1, 'the one variant that fits beside the cached one is queued');
    assert.equal(limited.worker.posted[0].speed, 2);
    limited.worker.finish();
    await tick();
    // An explicit playback request is still permitted at any budget and can remain uncached.
    setAudioCacheBudget(0);
    const uncached = limitedService.ensureVariant(fakeContext, source, 1.5);
    limited.worker.finish();
    assert.equal((await uncached).length, Math.round(source.length / 1.5));
    assert.equal(getAudioCacheStats().usedBytes, 0, 'explicit oversized render is not cached');
    results.push('prewarm fits the budget beside what the cache holds; zero-budget explicit playback still works');
    clearAudioCache();
}

// Dead and crashing workers.
async function testWorkerFailures(): Promise<void> {
    clearAudioCache();
    setAudioCacheBudget(150 * 1024 * 1024);
    const source = new FakeAudioBuffer(1, SAMPLE_RATE * 2, SAMPLE_RATE) as unknown as AudioBuffer;
    const finishLatest = (worker: FakeWorker) => {
        worker.posted.splice(0, worker.posted.length - 1);
        worker.finish();
    };

    // A worker that never answers: the watchdog fails the job, the slot is free
    // again and the next job reaches a fresh worker.
    const timeout = StretchService.jobTimeoutMs;
    StretchService.jobTimeoutMs = () => 20;
    const silent = fakeStrategy();
    const silentService = StretchService.forStrategy(silent.strategy);
    await assert.rejects(silentService.ensureVariant(fakeContext, source, 1.5), /timed out/);
    StretchService.jobTimeoutMs = timeout;
    assert.ok(silentService.available, 'a timed-out worker is replaced');
    const next = silentService.ensureVariant(fakeContext, source, 2);
    assert.equal(silent.worker.posted.at(-1)?.speed, 2, 'the slot takes the next job');
    finishLatest(silent.worker);
    assert.equal((await next).length, source.length / 2);
    results.push('watchdog: a silent worker is replaced and its job fails; the next job runs');

    // Crashes retire a slot after three in a row, but a completed job forgives them.
    const crash = (worker: FakeWorker) => (worker.onerror as (event: unknown) => void)({ message: 'boom', preventDefault() {} });
    const flaky = fakeStrategy();
    const flakyService = StretchService.forStrategy(flaky.strategy);
    for (const speed of [1.25, 1.5, 1.75]) {
        const job = flakyService.ensureVariant(fakeContext, source, speed);
        crash(flaky.worker);
        await assert.rejects(job, /boom/);
    }
    assert.ok(flakyService.available, 'three crashes still leave a worker');
    const recovered = flakyService.ensureVariant(fakeContext, source, 2);
    finishLatest(flaky.worker);
    assert.equal((await recovered).length, source.length / 2);
    const afterSuccess = flakyService.ensureVariant(fakeContext, source, 3);
    crash(flaky.worker);
    await assert.rejects(afterSuccess, /boom/);
    assert.ok(flakyService.available, 'a completed job reset the crash count: the fourth crash does not retire the slot');

    const doomed = fakeStrategy();
    const doomedService = StretchService.forStrategy(doomed.strategy);
    for (const speed of [1.25, 1.5, 1.75, 2]) {
        const job = doomedService.ensureVariant(fakeContext, source, speed);
        crash(doomed.worker);
        await assert.rejects(job);
    }
    assert.equal(doomedService.available, false, 'four crashes in a row retire the slot');
    await assert.rejects(doomedService.ensureVariant(fakeContext, source, 1.5), StretchUnavailableError);
    results.push('crashes: three in a row keep respawning, a success resets the count, four retire the slot');
    clearAudioCache();
}

await testLengths();
await testBudgetAndScheduling();
await testWorkerFailures();
console.log(results.map((line) => `  ok  ${line}`).join('\n'));
console.log('\nstretch tests passed');
