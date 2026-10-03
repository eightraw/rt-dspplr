// Node tests for the stretch pipeline (run: npm test). Bundled by
// build/test-node.mjs with esbuild; no browser needed.
//
//  1. Stretched output has exactly round(N / speed) frames on both paths
//     (built-in vocoder and Rubber Band), although the raw output buffers are
//     longer: wrapping a whole `channel.buffer` would add frames.
//  2. Speed variants are accounted in the shared PCM byte budget.
//  3. Prewarm puts the selected speed first, a playback request promotes a
//     queued prewarm job, and cancelPrewarm() drops queued jobs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { RubberBandInterface } from 'rubberband-wasm';
import { runStretchRequest, type StretchWorkerRequest } from '../src/core/stretch/protocol';
import { stretchMultichannel, defaultStretchFftSize } from '../src/core/stretch/OfflineStretchCore';
import { processWithRubberBand } from '../src/stretch-rubberband/rubberbandCore';
import { StretchService, StretchUnavailableError } from '../src/core/stretch/StretchService';
import { nativeStretcher, type StretchStrategy } from '../src/core/stretch/strategies';
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

    for (const speed of [1.25, 1.5, 2]) {
        const expected = Math.round(frames / speed);

        // Built-in vocoder
        const vocoderOut = stretchMultichannel(source.map((c) => c.slice()), { sampleRate: SAMPLE_RATE, rate: 1 / speed, transientSensitivity: 0.5 });
        const vocoderWhole = wholeBufferFrames(vocoderOut[0]);
        const vocoderLeadingPad = vocoderOut[0].byteOffset / 4;
        const vocoder = await runStretchRequest(request(source, speed), (channels, sr, s, t) => stretchMultichannel(channels, { sampleRate: sr, rate: 1 / s, transientSensitivity: t }));
        assert.equal(vocoder.response.length, expected, `vocoder length at ${speed}x`);
        assert.equal(vocoder.response.channels[0].byteLength / 4, expected, `vocoder transferred buffer at ${speed}x`);
        assert.ok(vocoderWhole > expected, 'the raw vocoder buffer is longer than the audio');
        results.push(`vocoder    ${speed}x: expected ${expected} frames | whole buffer ${vocoderWhole} (+${vocoderWhole - expected}, of which ${vocoderLeadingPad} leading = ${(vocoderLeadingPad / SAMPLE_RATE * 1000).toFixed(1)} ms) | fixed ${vocoder.response.length}`);
    }

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

    results.push(`(vocoder FFT size at 48 kHz = ${defaultStretchFftSize(SAMPLE_RATE)} frames)`);
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

    // Native strategy: no worker, callers get StretchUnavailableError and fall back to playbackRate.
    const native = StretchService.forStrategy(nativeStretcher);
    await assert.rejects(native.ensureVariant(fakeContext, source, 1.5), StretchUnavailableError);
    results.push('native strategy: ensureVariant rejects with StretchUnavailableError (Track falls back to playbackRate)');

    // Speculative renders may not fill an already source-sized budget; an
    // explicit playback request is still permitted and can remain uncached.
    const limited = fakeStrategy();
    const limitedService = StretchService.forStrategy(limited.strategy);
    setAudioCacheBudget(sourceBytes);
    limitedService.prewarm(fakeContext, source, [1.25, 1.5, 2], 2);
    assert.equal(limited.worker.posted.length, 0, 'no room for prewarm alongside source');
    setAudioCacheBudget(0);
    const uncached = limitedService.ensureVariant(fakeContext, source, 2);
    limited.worker.finish();
    assert.equal((await uncached).length, source.length / 2);
    assert.equal(getAudioCacheStats().usedBytes, 0, 'explicit oversized render is not cached');
    results.push('prewarm respects source + variants estimate; zero-budget explicit playback still works');
    clearAudioCache();
}

await testLengths();
await testBudgetAndScheduling();
console.log(results.map((line) => `  ok  ${line}`).join('\n'));
console.log('\nstretch tests passed');
