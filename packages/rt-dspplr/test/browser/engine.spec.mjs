// The stream engine (AudioWorklet), rendered offline: sample-exact segments
// and loop wraps, click-free volume / mix / seek, underrun hold and recovery;
// and the realtime player's seek latency.
import { test, expect } from '@playwright/test';

const BASE = '/node_modules/.cache/rtd-long';

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    await page.evaluate((base) => {
        window.longBase = base;
        const sr = 48000;
        /** An offline context with the engine and `segments` (arrays of mono Float32Array) fed in. */
        window.offlineEngine = async (seconds, segments, options = {}) => {
            const ctx = new OfflineAudioContext(1, Math.round(seconds * sr), sr);
            await h.advanced.loadStreamEngine(ctx, !!options.stretch);
            const starts = [0];
            for (const s of segments) starts.push(starts[starts.length - 1] + s.length);
            const engine = new h.advanced.StreamEngine(ctx, { channels: 1, starts, stretch: !!options.stretch });
            engine.node.connect(ctx.destination);
            const feed = options.feed ?? segments.map((_, i) => i);
            for (const i of feed) engine.feed('a', i, [segments[i].slice()]);
            return { ctx, engine, starts };
        };
        /** Let the engine's port deliver what was posted before rendering starts. */
        window.settle = () => new Promise((r) => setTimeout(r, 100));
        window.sine = (frames, hz, amp = 0.5, phase = 0) => Float32Array.from({ length: frames }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / sr + phase));
        window.cut = (signal, size) => {
            const out = [];
            for (let o = 0; o < signal.length; o += size) out.push(signal.slice(o, o + size));
            return out;
        };
        window.maxDelta = (x, from = 1) => {
            let m = 0;
            for (let i = Math.max(1, from); i < x.length; i += 1) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
            return m;
        };
    }, BASE);
});

test('engine output is sample-exact across segment boundaries and loop wraps', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const sr = 48000;
        const ref = h.advanced.parseWavFile(await (await fetch(`${longBase}/mono30.wav`)).arrayBuffer()).channels[0];
        const manifest = await (await fetch(`${longBase}/mono30/manifest.json`)).json();
        const segs = await Promise.all(manifest.segments.list.map(async (s) => h.advanced.parseWavFile(await (await fetch(`${longBase}/mono30/${s.url}`)).arrayBuffer()).channels[0]));
        const skip = 192; // the 4 ms fade-in of a start
        // 1) From an odd frame across three 3 s boundaries.
        const from = 2 * sr + 12345;
        let { ctx, engine } = await offlineEngine(8, segs);
        engine.play(from);
        await settle();
        let out = (await ctx.startRendering()).getChannelData(0);
        let maxErr = 0;
        for (let i = skip; i < out.length; i += 1) maxErr = Math.max(maxErr, Math.abs(out[i] - ref[from + i]));
        // 2) A loop [5.5 s, 6.75 s) across the 6 s boundary, three times round.
        const a = Math.round(5.5 * sr), b = Math.round(6.75 * sr);
        ({ ctx, engine } = await offlineEngine(((b - a) * 3 + 2000) / sr, segs));
        engine.setLoop({ start: a, end: b });
        engine.play(a);
        await settle();
        out = (await ctx.startRendering()).getChannelData(0);
        let loopErr = 0;
        for (let i = skip; i < out.length; i += 1) loopErr = Math.max(loopErr, Math.abs(out[i] - ref[a + (i % (b - a))]));
        return { maxErr, loopErr };
    });
    expect(result.maxErr).toBeLessThan(1e-6);
    expect(result.loopErr).toBeLessThan(1e-6);
});

test('volume, A/B mix and seeks never click (smoothed ramps, declicked jumps)', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const sr = 48000;
        const tone = sine(sr * 4, 1000);
        const natural = maxDelta(tone); // a 1 kHz sine at 0.5 changes ≤ 0.065 per sample
        const { ctx, engine } = await offlineEngine(3, cut(tone, sr));
        engine.play(0);
        await settle();
        ctx.suspend(0.5).then(async () => { engine.setVolume(0.1); await settle(); ctx.resume(); });
        ctx.suspend(1.0).then(async () => { engine.setVolume(1); await settle(); ctx.resume(); });
        ctx.suspend(1.5).then(async () => { engine.seek(Math.round(2.7 * sr) + 7); await settle(); ctx.resume(); });
        const out = (await ctx.startRendering()).getChannelData(0);
        // The same moves done abruptly would jump by up to 0.45 (0.5 → 0.05 at a peak).
        // Stem mix: A = sine, B = the same sine inverted; crossfading through silence.
        const b = Float32Array.from(tone, (v) => -v);
        const mix = await (async () => {
            const sr2 = 48000;
            const ctx2 = new OfflineAudioContext(1, sr2 * 2, sr2);
            await h.advanced.loadStreamEngine(ctx2, false);
            const segsA = cut(tone, sr2), segsB = cut(b, sr2);
            const starts = [0]; for (const s of segsA) starts.push(starts[starts.length - 1] + s.length);
            const e = new h.advanced.StreamEngine(ctx2, { channels: 1, starts, stretch: false });
            e.node.connect(ctx2.destination);
            segsA.forEach((s, i) => e.feed('a', i, [s.slice()]));
            segsB.forEach((s, i) => e.feed('b', i, [s.slice()]));
            e.setMix(1, 0);
            e.play(0);
            await settle();
            ctx2.suspend(0.6).then(async () => { e.setMix(0, 1); await settle(); ctx2.resume(); });
            return (await ctx2.startRendering()).getChannelData(0);
        })();
        return { natural, volume: maxDelta(out, 300), mix: maxDelta(mix, 300) };
    });
    expect(result.volume).toBeLessThan(result.natural * 1.15);
    expect(result.mix).toBeLessThan(result.natural * 1.15);
});

test('underrun: silence while the segment is missing, then the same sample resumes (nothing skipped)', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const sr = 48000;
        // A ramp makes every frame's content identifiable.
        const ramp = Float32Array.from({ length: sr * 3 }, (_, i) => (i / (sr * 3)) * 0.9 + 0.05);
        const segs = cut(ramp, sr);
        const { ctx, engine } = await offlineEngine(3, segs, { feed: [0] });
        engine.play(0);
        await settle();
        const reports = [];
        engine.onReport = (r) => reports.push(r);
        ctx.suspend(1.5).then(async () => { engine.feed('a', 1, [segs[1].slice()]); engine.feed('a', 2, [segs[2].slice()]); await settle(); ctx.resume(); });
        const out = (await ctx.startRendering()).getChannelData(0);
        // Where did the output go silent, and what played right after?
        let silentFrom = -1, silentTo = -1;
        for (let i = 300; i < out.length; i += 1) {
            if (out[i] === 0 && silentFrom < 0) silentFrom = i;
            if (silentFrom >= 0 && out[i] !== 0) { silentTo = i; break; }
        }
        await settle();
        const last = reports[reports.length - 1] ?? engine.report;
        // After the hole the ramp continues from the very frame where it stopped.
        const resumed = out[silentTo + 300];
        const expected = ramp[silentFrom + 300];
        return { silentFrom, silentTo, resumed, expected, underruns: last.underruns, underrunFrames: last.underrunFrames };
    });
    expect(result.silentFrom).toBeGreaterThan(47000);
    expect(result.silentFrom).toBeLessThanOrEqual(48000);
    expect(result.silentTo).toBeGreaterThan(70000); // held until the segments came (1.5 s)
    expect(Math.abs(result.resumed - result.expected)).toBeLessThan(1e-6);
    expect(result.underruns).toBe(1);
    expect(result.underrunFrames).toBeGreaterThan(20000);
});

test('realtime player: seek latency to a cached and an uncached segment; underruns stay at 0', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const ui = document.body.appendChild(document.createElement('div'));
        const player = h.createAudioPlayer({ element: ui, prewarmSpeeds: false, stretcher: 'native' });
        await player.play({ manifest: `${longBase}/stereo70/manifest.json` });
        await h.sleep(800);
        const t0 = performance.now();
        await player.seek(3); // segment 0: cached
        const near = await (async () => { while (player.getState().buffering) await h.sleep(2); return performance.now() - t0; })();
        await h.sleep(400);
        const t1 = performance.now();
        await player.seek(55); // segment 5: not fetched yet
        await (async () => { const s = performance.now(); while (performance.now() - s < 3000 && player.getStreamStats().seekLatencies.length < 2) await h.sleep(2); })();
        const far = performance.now() - t1;
        await h.sleep(500);
        const stats = player.getStreamStats();
        const time = player.getCurrentTime();
        player.dispose();
        return { near, far, stats, time };
    });
    expect(result.stats.playback).toBe('engine');
    expect(result.stats.seekLatencies.length).toBeGreaterThanOrEqual(2);
    expect(result.stats.seekLatencies[0]).toBeLessThan(150);
    expect(result.stats.seekLatencies[1]).toBeLessThan(1000);
    expect(result.time).toBeGreaterThan(55);
    expect(result.stats.underruns).toBe(0);
    console.log(`engine seek → audio: cached ${result.stats.seekLatencies[0].toFixed(0)} ms, uncached ${result.stats.seekLatencies[1].toFixed(0)} ms`);
});

test('realtime stretch: loop wraps and speed changes stay continuous (no gap, no click)', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const sr = 48000;
        // 375 Hz: exactly 128 frames per period, so a 1 s loop is itself seamless.
        const tone = sine(sr * 6, 375, 0.5);
        const natural = maxDelta(tone);
        const ctx = new OfflineAudioContext(1, sr * 5, sr);
        await h.advanced.loadStreamEngine(ctx, true);
        await h.advanced.stretchAvailable(ctx);
        const segs = cut(tone, sr * 2);
        const starts = [0]; for (const s of segs) starts.push(starts[starts.length - 1] + s.length);
        const engine = new h.advanced.StreamEngine(ctx, { channels: 1, starts, stretch: true });
        engine.node.connect(ctx.destination);
        segs.forEach((s, i) => engine.feed('a', i, [s.slice()]));
        engine.setLoop({ start: sr, end: 2 * sr });
        engine.setRate(1.5);
        ctx.suspend(256 / sr).then(async () => {
            const t = performance.now();
            while (!engine.stretch.ready && performance.now() - t < 20000) await h.sleep(5);
            engine.play(sr);
            await settle();
            ctx.resume();
        });
        // Speed moves while playing: 1.5 → 1 → 2 → 1.5.
        for (const [at, rate] of [[1.6, 1], [2.4, 2], [3.3, 1.5]]) {
            ctx.suspend(at).then(async () => { engine.setRate(rate); await settle(); ctx.resume(); });
        }
        const out = (await ctx.startRendering()).getChannelData(0);
        // 10 ms RMS windows after the start: a gap or a dip would show.
        const from = 256 + 2400;
        let lo = Infinity, hi = -Infinity;
        for (let i = from; i + 480 < out.length; i += 480) {
            let s = 0; for (let k = 0; k < 480; k += 1) s += out[i + k] * out[i + k];
            const db = 10 * Math.log10(s / 480 + 1e-20);
            lo = Math.min(lo, db); hi = Math.max(hi, db);
        }
        return { natural, delta: maxDelta(out, from), lo, hi, latency: engine.stretch.latencyFrames, ready: engine.stretch.ready };
    });
    expect(result.ready).toBe(true);
    // A 0.5 sine is -9 dB RMS; every 10 ms window through 6+ loop wraps and 3 speed changes stays near it.
    expect(result.hi - result.lo).toBeLessThan(1.5);
    expect(result.lo).toBeGreaterThan(-10.5);
    expect(result.delta).toBeLessThan(result.natural * 1.3);
    console.log(`stretch window ${result.latency} frames (${(result.latency / 48).toFixed(0)} ms, compensated by look-ahead); RMS range over wraps and speed moves ${(result.hi - result.lo).toFixed(2)} dB; max step ${result.delta.toFixed(3)} vs ${result.natural.toFixed(3)} natural`);
});
