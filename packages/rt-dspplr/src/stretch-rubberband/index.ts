// ./stretch-rubberband entry — optional Rubber Band time-stretch strategy.
//
// Licensing: this entry makes your bundle include `rubberband-wasm`, which is
// GPL-2.0-or-later. Installing it (`npm i rubberband-wasm`) and importing this
// entry is the application's decision; the core and React entries never
// reference it.

import type { StretchStrategy } from '../core/stretch/strategies';

export interface RubberbandStretcherOptions {
    /**
     * URL of `rubberband.wasm`. By default the worker resolves it from the
     * installed `rubberband-wasm` package through the bundler
     * (`new URL('rubberband-wasm/dist/rubberband.wasm', import.meta.url)`).
     * Set it when you serve the file yourself (CDN, custom public path).
     */
    wasmUrl?: string | URL;
    /** Parallel workers. Default: min(2, hardwareConcurrency - 1), at least 1. */
    poolSize?: number;
}

let warnedPrebundled = false;

/**
 * Vite's dev server pre-bundles dependencies into node_modules/.vite/deps/,
 * which breaks every `new URL('./…', import.meta.url)` inside them (the
 * worker file is not copied there). Detect it and explain the one-line fix
 * instead of spawning workers that 404.
 */
function isVitePrebundled(): boolean {
    return /\/node_modules\/\.vite\/deps(_[^/]*)?\//.test(import.meta.url);
}

function createRubberbandWorker(): Worker {
    // Kept as a literal `new Worker(new URL('./…', import.meta.url))` so the
    // application's bundler detects it, bundles the worker together with
    // `rubberband-wasm`, and emits it as a separate chunk.
    return new Worker(new URL('./rubberband-worker.js', import.meta.url), { type: 'module', name: 'rtd-rubberband' });
}

/**
 * Rubber Band (R3 "finer" engine) in a module worker, rendering each speed of a
 * whole clip offline (about 265 KB of WASM, loaded on first use), in place of the
 * built-in realtime stretch. Where the WASM cannot be loaded, that speed plays by
 * playbackRate (the pitch follows the speed). Prepared clips keep the realtime stretch.
 *
 *   import { rubberbandStretcher } from '@saitdigital/rt-dspplr/stretch-rubberband';
 *   createAudioPlayer({ stretcher: rubberbandStretcher() });
 */
export function rubberbandStretcher(options: RubberbandStretcherOptions = {}): StretchStrategy {
    const wasmUrl = options.wasmUrl === undefined ? undefined : String(options.wasmUrl);
    return {
        // Players configured with the same wasm URL share one pool.
        id: `rubberband:${wasmUrl ?? 'default'}:${options.poolSize ?? 'auto'}`,
        poolSize: options.poolSize,
        createWorker(): Worker | null {
            if (isVitePrebundled()) {
                if (!warnedPrebundled) {
                    warnedPrebundled = true;
                    console.warn(
                        '[rtd] The Rubber Band entry was pre-bundled by the Vite dev server, so its worker file cannot be found. '
                        + "Add this entry (`@saitdigital/rt-dspplr/stretch-rubberband`) to `optimizeDeps.exclude` in vite.config. "
                        + 'Speed changes use native playbackRate until then. Production builds are not affected.',
                    );
                }
                return null;
            }
            let worker: Worker;
            try {
                worker = createRubberbandWorker();
            } catch (error) {
                console.warn('[rtd] Rubber Band worker could not be started; speed changes will use native playbackRate', error);
                return null;
            }
            if (wasmUrl) {
                worker.postMessage({ type: 'configure', wasmUrl });
            }
            return worker;
        },
    };
}

export type { StretchStrategy } from '../core/stretch/strategies';
