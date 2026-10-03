// Rubber Band stretch worker (optional entry).
//
// This file is shipped as a separate ES module worker and is bundled by the
// consuming application's bundler, so `rubberband-wasm` (GPL-2.0-or-later) is
// resolved from the application's own node_modules and is never part of this
// package's build output.
//
// If Rubber Band cannot run (WASM blocked, file missing, out of memory), every
// job falls back to the built-in phase vocoder instead of failing.

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

function defaultWasmUrl(): string {
    // Written as a static `new URL(<specifier>, import.meta.url)` so bundlers
    // (webpack 5, Vite build) emit the .wasm from the installed package as an
    // asset and rewrite this to its final URL.
    return new URL('rubberband-wasm/dist/rubberband.wasm', import.meta.url).href;
}

async function loadRubberBandApi(): Promise<RubberBandInterface> {
    if (rubberBandApiPromise) {
        return rubberBandApiPromise;
    }

    rubberBandApiPromise = (async () => {
        const url = wasmUrlOverride ?? defaultWasmUrl();
        let wasmModule: WebAssembly.Module;
        try {
            wasmModule = await WebAssembly.compileStreaming(fetch(url));
        } catch {
            // compileStreaming needs Content-Type: application/wasm; some
            // servers send octet-stream, so retry with a plain compile.
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`rubberband.wasm: HTTP ${response.status}`);
            }
            const bytes = await response.arrayBuffer();
            wasmModule = await WebAssembly.compile(bytes);
        }
        return RubberBandInterface.initialize(wasmModule);
    })();

    // Do not cache a failure forever: a later job may succeed (e.g. after a
    // transient network error).
    rubberBandApiPromise.catch(() => {
        rubberBandApiPromise = null;
    });

    return rubberBandApiPromise;
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
        }
        return;
    }
    handleStretch?.(event);
};
