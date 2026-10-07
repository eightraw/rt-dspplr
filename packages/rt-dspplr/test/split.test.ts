// Node tests for the realtime stretch's tonal/atonal split (wasm/split.c through
// core/engine/splitSource.ts), run: npm test.
//
//  1. The two parts sum back to the stem (the masks add to one, the windows to one).
//  2. A held tone goes to the tonal part, clicks to the atonal one.
//  3. The work is spread by the budget, and audio that is not in memory is never split.
//  4. Reading in order and reading after a jump give the same parts (the median slides or is rebuilt).

import assert from 'node:assert/strict';
import splitCode from '../src/vendor/rtdSplit';
import { SPLIT_HOP, SPLIT_MARGIN, SplitSource, type SplitExports, type SplitMode } from '../src/core/engine/splitSource';

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
    const split = new SplitSource(await exports(), 0, 2, read, () => true);
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
    const jumpy = new SplitSource(await exports(), 0, 2, read, () => true);
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
    const split = new SplitSource(await exports(), 0, 2, read, () => present);
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
    // The last frame of a span counts too, however short of a quarter chunk it ends past a chunk start.
    const edge = 88 * SPLIT_HOP;
    const fresh = new SplitSource(await exports(), 0, 2, read, () => true);
    assert.equal(fresh.prepare(1000, (i) => edge - 900 + i, { left: 100 }), 'ready');
    assert.notEqual(fresh.tonal(edge + 100, 0), 0, 'the chunk holding the span\'s last frame is made');
    // A span that jumps back (a loop wrap) between two chunk starts: the chunk its frames enter
    // just before the jump and the one they leave just after it are made too.
    const before = 50 * SPLIT_HOP + 100;
    const after = 20 * SPLIT_HOP + 1000;
    const wrap = (i: number) => (i < 1000 ? before + i : after + (i - 1000));
    const wrapped = new SplitSource(await exports(), 0, 2, read, () => true);
    assert.equal(wrapped.prepare(2000, wrap, { left: 1000 }), 'ready');
    const unmade = Array.from({ length: 2001 }, (_, i) => wrap(i)).filter((f) => wrapped.tonal(f, 0) === 0);
    assert.deepEqual(unmade, [], 'every frame of a span through a loop wrap is split');
    results.push(`split budget: a cold region is made over ${rounds} blocks of 3; audio not in memory reports 'missing' and is split once it is there; a span's last frame and both sides of a loop wrap are made`);
}

{
    // 5. In a loop the parts are those of the audio as it plays: split through the loop, they are
    // exactly the parts of that audio written out and split as a clip. On a hop grid, so both
    // are cut into the same chunks.
    const n = 4 * SR;
    const { sum } = stem(4);
    const read = (frame: number, c: number) => (frame >= 0 && frame < n ? sum[c][frame] : 0);
    const loop = { start: 30 * SPLIT_HOP, end: 90 * SPLIT_HOP };
    const len = loop.end - loop.start;
    const all = { left: Infinity };
    // Played audio written out, split as a clip, against the clip split through the loop in `mode`,
    // over frames [from, to) of the clip (at `offset` in the played audio).
    const compare = async (played: Float32Array[], offset: number, from: number, to: number, mode: SplitMode) => {
        const reference = new SplitSource(await exports(), 0, 2, (f, c) => (f >= 0 && f < played[0].length ? played[c][f] : 0), () => true);
        assert.equal(reference.prepare(to - from - 1, (i) => offset + i, all), 'ready');
        const looped = new SplitSource(await exports(), 0, 2, read, () => true);
        looped.setLoop(loop);
        assert.equal(looped.prepare(to - from - 1, (i) => from + i, all, () => mode), 'ready');
        let worst = 0;
        for (let f = from; f < to; f += 1) {
            for (let c = 0; c < 2; c += 1) {
                worst = Math.max(worst, Math.abs(looped.tonal(f, c, mode) - reference.tonal(offset + f - from, c)), Math.abs(looped.atonal(f, c, mode) - reference.atonal(offset + f - from, c)));
            }
        }
        return worst;
    };
    // After a wrap: the loop over and over; its parts all round, against its middle copy.
    const around = sum.map((x) => Float32Array.from({ length: 3 * len }, (_, j) => x[loop.start + (j % len)]));
    assert.equal(await compare(around, len, loop.start, loop.end, 2), 0, 'after a wrap: the loop\'s parts are those of the loop over and over');
    // Before the first wrap: what lies before the loop, then the loop over and over.
    const firstPass = sum.map((x) => Float32Array.from({ length: loop.end + 2 * len }, (_, j) => (j < loop.end ? x[j] : x[loop.start + ((j - loop.end) % len)])));
    assert.equal(await compare(firstPass, 0, 0, loop.end, 1), 0, 'on the way in: the parts of the audio up to the loop and round it');
    // The loop's own cache holds only the chunks near its edges: inside it, the clip's parts.
    // (Two splits on one instance, in contexts of their own, as the engine keeps its two stems.)
    const shared = await exports();
    const plain = new SplitSource(shared, 0, 2, read, () => true);
    const looped = new SplitSource(shared, 3, 2, read, () => true);
    looped.setLoop(loop);
    const middle = loop.start + len / 2;
    plain.prepare(SPLIT_HOP, (i) => middle + i, all);
    looped.prepare(SPLIT_HOP, (i) => middle + i, all, () => 2);
    let same = true;
    for (let f = middle; f < middle + SPLIT_HOP; f += 1) same &&= looped.tonal(f, 0, 2) === plain.tonal(f, 0) && looped.atonal(f, 1, 2) === plain.atonal(f, 1);
    assert.ok(same, 'inside the loop, away from its edges, the clip\'s own parts');
    // Near the end the loop's parts differ from the clip's (its start follows, not what lies there).
    plain.prepare(SPLIT_HOP, (i) => loop.end - SPLIT_HOP + i, all);
    looped.prepare(SPLIT_HOP, (i) => loop.end - SPLIT_HOP + i, all, () => 2);
    let differ = 0;
    for (let f = loop.end - SPLIT_HOP; f < loop.end; f += 1) differ = Math.max(differ, Math.abs(looped.tonal(f, 0, 2) - plain.tonal(f, 0)));
    assert.ok(differ > 1e-3, `near the loop's end the parts are the loop's (off the clip's by ${differ.toExponential(1)})`);
    results.push(`split through a loop: exactly the parts of the audio as it plays (the loop all round after a wrap; up to the loop and round it on the way in); away from its edges the clip's own parts, near its end not (by up to ${differ.toFixed(3)})`);
}

console.log(results.map((line) => `  ok  ${line}`).join('\n'));
console.log('\nsplit tests passed');
