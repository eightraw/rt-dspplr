// Node tests for the realtime stretch's tonal/atonal split (wasm/split.c through
// core/engine/splitSource.ts), run: npm test.
//
//  1. The two parts sum back to the stem (the masks add to one, the windows to one).
//  2. A held tone goes to the tonal part, clicks to the atonal one.
//  3. The work is spread by the budget, and audio that is not in memory is never split.
//  4. Reading in order and reading after a jump give the same parts (the median slides or is rebuilt).

import assert from 'node:assert/strict';
import splitCode from '../src/vendor/rtdSplit';
import { SPLIT_HOP, SPLIT_MARGIN, SplitSource, type SplitExports } from '../src/core/engine/splitSource';

const results: string[] = [];
const SR = 44100;

new Function(splitCode)();
const bytes = (globalThis as unknown as { __rtdSplitWasm: Uint8Array }).__rtdSplitWasm;
const module = await WebAssembly.compile(bytes);
async function exports(): Promise<SplitExports> {
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: { random_get: () => 0 } });
    const x = instance.exports as unknown as SplitExports;
    x._initialize?.();
    return x;
}

/** Stereo: a held chord, and clicks (5 ms of decaying noise) every 250 ms. */
function stem(seconds: number): { tone: Float32Array[]; clicks: Float32Array[]; sum: Float32Array[] } {
    const n = Math.round(seconds * SR);
    const tone = [new Float32Array(n), new Float32Array(n)];
    const clicks = [new Float32Array(n), new Float32Array(n)];
    let seed = 7;
    for (let i = 0; i < n; i += 1) {
        const t = i / SR;
        tone[0][i] = 0.2 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 330 * t);
        tone[1][i] = 0.2 * Math.sin(2 * Math.PI * 277 * t + 1);
    }
    for (let at = Math.round(0.1 * SR); at < n; at += Math.round(0.25 * SR)) {
        for (let k = 0; k < Math.round(0.005 * SR) && at + k < n; k += 1) {
            seed = (seed * 16807) % 2147483647;
            const v = (seed / 2147483647 - 0.5) * 1.2 * Math.exp(-k / 40);
            clicks[0][at + k] = v;
            clicks[1][at + k] = -v;
        }
    }
    return { tone, clicks, sum: tone.map((x, c) => x.map((v, i) => v + clicks[c][i])) };
}

function parts(split: SplitSource, n: number, order: number[], budget = Infinity) {
    const tonal = [new Float32Array(n), new Float32Array(n)];
    const atonal = [new Float32Array(n), new Float32Array(n)];
    const block = 4096;
    for (const start of order) {
        const count = Math.min(block, n - start);
        const b = { left: budget };
        assert.equal(split.prepare(count - 1, (i) => start + i, b), 'ready');
        for (let i = 0; i < count; i += 1) {
            for (let c = 0; c < 2; c += 1) {
                tonal[c][start + i] = split.tonal(start + i, c);
                atonal[c][start + i] = split.atonal(start + i, c);
            }
        }
    }
    return { tonal, atonal };
}

const energy = (x: Float32Array[], from: number, to: number) => x.reduce((s, c) => { for (let i = from; i < to; i += 1) s += c[i] * c[i]; return s; }, 0);

{
    const seconds = 4;
    const n = seconds * SR;
    const { tone, clicks, sum } = stem(seconds);
    const read = (frame: number, c: number) => (frame >= 0 && frame < n ? sum[c][frame] : 0);
    const split = new SplitSource(await exports(), 2, read, () => true);
    const blocks = Array.from({ length: Math.ceil(n / 4096) }, (_, k) => k * 4096);
    const { tonal, atonal } = parts(split, n, blocks);

    // 1. The parts sum back to the stem.
    let worst = 0;
    for (let c = 0; c < 2; c += 1) for (let i = 0; i < n; i += 1) worst = Math.max(worst, Math.abs(tonal[c][i] + atonal[c][i] - sum[c][i]));
    assert.ok(worst < 1e-5, `tonal + atonal = stem (off by ${worst})`);

    // 2. Where the energy goes (away from the edges).
    const from = SPLIT_MARGIN;
    const to = n - SPLIT_MARGIN;
    // The tonal part against the tone, the atonal part against the clicks.
    const diff = (a: Float32Array[], b: Float32Array[]) => energy(a.map((c, k) => c.map((v, i) => v - b[k][i])), from, to);
    const tonalErr = 10 * Math.log10(diff(tonal, tone) / energy(tone, from, to));
    const atonalErr = 10 * Math.log10(diff(atonal, clicks) / energy(clicks, from, to));
    assert.ok(tonalErr < -15, `the tonal part is the tone (residual ${tonalErr.toFixed(1)} dB)`);
    assert.ok(atonalErr < -3, `the atonal part is mostly the clicks (residual ${atonalErr.toFixed(1)} dB)`);

    // 4. After a jump (blocks out of order) the parts are the same.
    const jumpy = new SplitSource(await exports(), 2, read, () => true);
    const order = [...blocks].reverse();
    const again = parts(jumpy, n, order);
    let jumpWorst = 0;
    for (let c = 0; c < 2; c += 1) for (let i = 0; i < n; i += 1) jumpWorst = Math.max(jumpWorst, Math.abs(again.tonal[c][i] - tonal[c][i]), Math.abs(again.atonal[c][i] - atonal[c][i]));
    assert.equal(jumpWorst, 0, 'read backwards: the same parts');
    results.push(`split: tonal + atonal = stem (${worst.toExponential(1)}); tone in the tonal part (residual ${tonalErr.toFixed(1)} dB), clicks in the atonal part (${atonalErr.toFixed(1)} dB); the same parts read forwards and backwards`);
}

{
    // 3. Budget and missing audio.
    const n = 4 * SR;
    const { sum } = stem(4);
    const read = (frame: number, c: number) => (frame >= 0 && frame < n ? sum[c][frame] : 0);
    let present = true;
    const split = new SplitSource(await exports(), 2, read, () => present);
    const at = 2 * SR;
    let rounds = 0;
    for (;;) {
        rounds += 1;
        const state = split.prepare(SPLIT_HOP * 4, (i) => at + i, { left: 3 });
        if (state === 'ready') break;
        assert.equal(state, 'budget');
        assert.ok(rounds < 50);
    }
    assert.ok(rounds > 1, 'a cold region takes more than one block of budget');
    present = false;
    assert.equal(split.prepare(SPLIT_HOP * 4, (i) => SR / 2 + i, { left: 100 }), 'missing', 'audio not in memory is never split');
    present = true;
    assert.equal(split.prepare(SPLIT_HOP * 4, (i) => SR / 2 + i, { left: 100 }), 'ready');
    results.push(`split budget: a cold region is made over ${rounds} blocks of 3; audio not in memory reports 'missing' and is split once it is there`);
}

console.log(results.map((line) => `  ok  ${line}`).join('\n'));
console.log('\nsplit tests passed');
