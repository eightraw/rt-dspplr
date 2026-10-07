// Rubber Band stretch worker (optional entry).
//
// This file is shipped as a separate ES module worker and is bundled by the
// consuming application's bundler, so `rubberband-wasm` (GPL-2.0-or-later) is
// resolved from the application's own node_modules and is never part of this
// package's build output.
//
// If Rubber Band cannot run (WASM blocked, file missing, out of memory), every
// job falls back to the built-in phase vocoder instead of failing. A failure
// that cannot pass (WASM refused or broken, no file) is kept for the worker's
// life; any other is tried again with a growing pause.

import { RubberBandInterface } from 'rubberband-wasm';
import { processWithRubberBand } from './rubberbandCore';
import { serveStretchWorker, type StretchWorkerScope } from '../core/stretch/protocol';
import { stretchMultichannel } from '../core/stretch/OfflineStretchCore';

interface ConfigureMessage {
    type: 'configure';
    wasmUrl?: string;
}

const workerScope = self as unknown as StretchWorkerScope;
let wasmUrlOverride: string | null = null;
let rubberBandApiPromise: Promise<RubberBandInterface> | null = null;
/** The last failure: for good when it is permanent, otherwise until `retryAt`. */
let failure: { error: unknown; permanent: boolean; attempts: number; retryAt: number } | null = null;
/** Bumped by 'configure': an attempt for the previous URL no longer counts. */
let generation = 0;

const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 60000;

class HttpError extends Error {
    constructor(readonly status: number) {
        super(`rubberband.wasm: HTTP ${status}`);
    }
}

function defaultWasmUrl(): string {
    // Written as a static `new URL(<specifier>, import.meta.url)` so bundlers
    // (webpack 5, Vite build) emit the .wasm from the installed package as an
    // asset and rewrite this to its final URL.
    return new URL('rubberband-wasm/dist/rubberband.wasm', import.meta.url).href;
}

/**
 * A failure that another try cannot fix: bytes that do not compile or link,
 * WASM refused by the Content-Security-Policy, a file that is not there. The
 * network, a server error or memory may be fine a little later.
 */
function isPermanent(error: unknown): boolean {
    if (error instanceof WebAssembly.CompileError || error instanceof WebAssembly.LinkError) return true;
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'SecurityError' || name === 'EvalError') return true;
    if (error instanceof HttpError) return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
    return false;
}

async function compileWasm(url: string): Promise<WebAssembly.Module> {
    // One request: compileStreaming needs Content-Type: application/wasm, and
    // some servers send octet-stream, which compiles from the bytes instead.
    const response = await fetch(url);
    if (!response.ok) throw new HttpError(response.status);
    const streaming = typeof WebAssembly.compileStreaming === 'function'
        && /^application\/wasm\b/i.test(response.headers.get('content-type') ?? '');
    return streaming ? WebAssembly.compileStreaming(response) : WebAssembly.compile(await response.arrayBuffer());
}

function loadRubberBandApi(): Promise<RubberBandInterface> {
    if (rubberBandApiPromise) {
        return rubberBandApiPromise;
    }
    // While a failure stands, every job (prewarms too) falls back at once
    // instead of fetching and compiling again.
    if (failure && (failure.permanent || Date.now() < failure.retryAt)) {
        return Promise.reject(failure.error);
    }
    const current = generation;
    const attempt = (async () => RubberBandInterface.initialize(await compileWasm(wasmUrlOverride ?? defaultWasmUrl())))();
    rubberBandApiPromise = attempt;
    attempt.then(() => {
        if (current === generation) failure = null;
    }, (error: unknown) => {
        if (current !== generation) return;
        rubberBandApiPromise = null;
        // A transient failure is tried again after 2 s, 4 s, 8 s … up to a minute.
        const attempts = (failure?.attempts ?? 0) + 1;
        failure = { error, permanent: isPermanent(error), attempts, retryAt: Date.now() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (attempts - 1)) };
    });
    return attempt;
}

let warnedFallback = false;

serveStretchWorker(workerScope, async (channels, sampleRate, speed, transientSensitivity) => {
    try {
        const api = await loadRubberBandApi();
        return processWithRubberBand(api, channels, sampleRate, speed);
    } catch (error) {
        if (!warnedFallback) {
            warnedFallback = true;
            console.warn('[rubberband worker] Rubber Band failed, falling back to the built-in phase vocoder', error);
        }
        return stretchMultichannel(channels, {
            sampleRate,
            rate: 1 / speed,
            transientSensitivity,
        });
    }
});

// serveStretchWorker owns onmessage; wrap it to also accept 'configure'.
const handleStretch = workerScope.onmessage;
workerScope.onmessage = (event: MessageEvent) => {
    const message = event.data as ConfigureMessage | null;
    if (message && message.type === 'configure') {
        if (typeof message.wasmUrl === 'string' && message.wasmUrl) {
            wasmUrlOverride = message.wasmUrl;
            rubberBandApiPromise = null;
            failure = null;
            generation += 1;
        }
        return;
    }
    handleStretch?.(event);
};
