// Node side of the stretch quality bench: the offline references (the built-in
// vocoder and Rubber Band R3), bundled by long-audio-bench.mjs with esbuild.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { RubberBandInterface } from 'rubberband-wasm';
import { stretchMultichannel } from '../src/core/stretch/OfflineStretchCore';
import { processWithRubberBand } from '../src/stretch-rubberband/rubberbandCore';

const require = createRequire(import.meta.url);
let api: RubberBandInterface | null = null;

export async function offlineStretch(kind: 'vocoder' | 'rubberband', input: Float32Array, sampleRate: number, speed: number): Promise<{ out: Float32Array; ms: number }> {
    const t0 = performance.now();
    if (kind === 'vocoder') {
        const out = stretchMultichannel([input.slice()], { sampleRate, rate: 1 / speed, transientSensitivity: 0.5, memory: 'lean' })[0];
        return { out: out.slice(0, Math.round(input.length / speed)), ms: performance.now() - t0 };
    }
    api ??= await RubberBandInterface.initialize(await WebAssembly.compile(fs.readFileSync(require.resolve('rubberband-wasm/dist/rubberband.wasm'))));
    const t1 = performance.now();
    const out = processWithRubberBand(api, [input.slice()], sampleRate, speed)[0];
    return { out: out.slice(0, Math.round(input.length / speed)), ms: performance.now() - t1 };
}
