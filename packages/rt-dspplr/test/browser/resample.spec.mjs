// Clips at another rate than the context's: the stream engine renders at the
// clip's rate (mix, stretch, ramps) and resamples its output with a streaming
// windowed sinc. Checked in an OfflineAudioContext at 48 kHz with 44.1 and
// 16 kHz clips: a tone comes out at its frequency and clean, segment joins and
// loop wraps leave no seam, the realtime stretcher keeps the pitch, the
// position runs at real time. And a prepared 44.1 kHz clip in the player.
import { test, expect } from '@playwright/test';

const BASE = '/node_modules/.cache/rtd-long';

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    await page.evaluate((base) => {
        window.longBase = base;
        const out = 48000;
        /** A context at 48 kHz playing `segments` (mono, at `clipRate`) through the engine. */
        window.engineAt = async (clipRate, seconds, segments, options = {}) => {
            const ctx = new OfflineAudioContext(1, Math.round(seconds * out), out);
            await h.internals.loadStreamEngine(ctx, !!options.stretch);
            if (options.stretch) await h.internals.stretchAvailable(ctx);
            const starts = [0];
            for (const s of segments) starts.push(starts[starts.length - 1] + s.length);
            const engine = new h.internals.StreamEngine(ctx, { channels: 1, starts, stretch: !!options.stretch, sampleRate: clipRate });
            engine.node.connect(ctx.destination);
            segments.forEach((s, i) => engine.feed('a', i, [s.slice()]));
            return { ctx, engine };
        };
        window.settle = () => new Promise((r) => setTimeout(r, 100));
        window.tone = (frames, rate, hz, amp = 0.5) => Float32Array.from({ length: frames }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / rate));
        /** Cut into segments of uneven sizes, so joins fall anywhere in the resampler's phase. */
        window.cutUneven = (signal, sizes) => {
            const segs = [];
            let o = 0;
            for (let k = 0; o < signal.length; k += 1) {
                const size = sizes[k % sizes.length];
                segs.push(signal.slice(o, o + size));
                o += size;
            }
            return segs;
        };
        /**
         * The best-fitting sine at `hz` over whole periods of `x` (at 48 kHz) from `from`,
         * and what is left: level of the rest against the tone, in dB.
         */
        window.residualDb = (x, hz, from, length) => {
            let a = 0, b = 0;
            for (let i = 0; i < length; i += 1) {
                const w = 2 * Math.PI * hz * (from + i) / out;
                a += x[from + i] * Math.cos(w);
                b += x[from + i] * Math.sin(w);
            }
            a *= 2 / length; b *= 2 / length;
            let sig = 0, res = 0;
            for (let i = 0; i < length; i += 1) {
                const w = 2 * Math.PI * hz * (from + i) / out;
                const fit = a * Math.cos(w) + b * Math.sin(w);
                sig += fit * fit;
                res += (x[from + i] - fit) ** 2;
            }
            return 10 * Math.log10(res / sig);
        };
        /** Frequency from rising zero crossings (interpolated) between two sample indices. */
        window.frequency = (x, from, to) => {
            const crossings = [];
            for (let i = from + 1; i < to; i += 1) if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + x[i - 1] / (x[i - 1] - x[i]));
            return (crossings.length - 1) / ((crossings.at(-1) - crossings[0]) / out);
        };
        window.maxDelta = (x, from, to) => {
            let m = 0;
            for (let i = from + 1; i < to; i += 1) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
            return m;
        };
    }, BASE);
});

for (const clipRate of [44100, 16000]) {
    test(`a ${clipRate / 1000} kHz clip at a 48 kHz context: the tone is clean and the joins and loop wraps leave no seam`, async ({ page }) => {
        const r = await page.evaluate(async (clipRate) => {
            const hz = 1000;
            // Segments of uneven, odd sizes; a loop over a whole number of periods across a join.
            const signal = tone(clipRate * 4, clipRate, hz);
            const segs = cutUneven(signal, [Math.round(clipRate * 0.731) | 1, Math.round(clipRate * 0.523) | 1, Math.round(clipRate * 0.977) | 1]);
            const { ctx, engine } = await engineAt(clipRate, 3, segs);
            ctx.suspend(256 / 48000).then(async () => {
                engine.play(0);
                await settle();
                ctx.resume();
            });
            // A 0.5 s loop (500 whole periods, so the wrap itself is seamless) starting mid-segment.
            const loopStart = Math.round(clipRate * 1.2);
            ctx.suspend(1.5).then(async () => {
                engine.setLoop({ start: loopStart, end: loopStart + clipRate / 2 });
                await settle();
                ctx.resume();
            });
            const out = (await ctx.startRendering()).getChannelData(0);
            const natural = 0.5 * 2 * Math.PI * hz / 48000;
            const from = 2400; // past the start's fade-in and the resampler's delay
            return {
                hz: frequency(out, from, 48000 * 1.4),
                residual: residualDb(out, hz, from, 48000), // 1 s: 1000 whole periods, several joins
                residualLoop: residualDb(out, hz, Math.round(48000 * 1.7), 48000), // 1 s of loop wraps
                step: maxDelta(out, from, out.length) / natural,
            };
        }, clipRate);
        console.log(`${clipRate} Hz clip: ${r.hz.toFixed(3)} Hz, residual ${r.residual.toFixed(1)} dB (joins), ${r.residualLoop.toFixed(1)} dB (loop wraps), max step ${r.step.toFixed(3)} × natural`);
        expect(Math.abs(r.hz - 1000)).toBeLessThan(0.05);
        expect(r.residual).toBeLessThan(-70);
        expect(r.residualLoop).toBeLessThan(-70);
        expect(r.step).toBeLessThan(1.05);
    });
}

test('a 44.1 kHz clip at a 48 kHz context keeps realtime speed: 1.5x keeps the pitch, the position runs at 1.5x', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const clipRate = 44100;
        const signal = tone(clipRate * 8, clipRate, 1000);
        const { ctx, engine } = await engineAt(clipRate, 3, cutUneven(signal, [clipRate * 2]), { stretch: true });
        engine.setRate(1.5);
        let ready = false;
        let position = null;
        ctx.suspend(256 / 48000).then(async () => {
            const t = performance.now();
            while (!engine.stretch.ready && performance.now() - t < 20000) await h.sleep(5);
            ready = engine.stretch.ready;
            engine.play(0);
            await settle();
            ctx.resume();
        });
        ctx.suspend(2).then(async () => {
            await settle();
            position = engine.report.position;
            ctx.resume();
        });
        const out = (await ctx.startRendering()).getChannelData(0);
        return { ready, hz: frequency(out, 48000 * 0.5, 48000 * 1.9), position };
    });
    expect(r.ready).toBe(true);
    // The pitch stays (a playbackRate would give 1500 Hz).
    expect(Math.abs(r.hz - 1000)).toBeLessThan(3);
    // ~2 s of context time at 1.5x, from a start just after 0: about 3 s of the clip.
    expect(r.position / 44100).toBeGreaterThan(2.8);
    expect(r.position / 44100).toBeLessThan(3.05);
});

test('a prepared 44.1 kHz clip plays with realtime speed in the player, at the right pace', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const ui = document.body.appendChild(document.createElement('div'));
        const player = h.createAudioPlayer({ element: ui, prewarmSpeeds: false, processing: { highPassHz: 0, compression: 0 } });
        await player.play({ manifest: `${longBase}/stereo441/manifest.json` });
        const t = performance.now();
        while (!(h.rms(player) > 0.02) && performance.now() - t < 8000) await h.sleep(10);
        while (!player.getState().capabilities.canPreservePitch && performance.now() - t < 8000) await h.sleep(10);
        const s = player.getState();
        const t0 = player.getCurrentTime();
        const c0 = performance.now();
        await h.sleep(1500);
        const pace = (player.getCurrentTime() - t0) / ((performance.now() - c0) / 1000);
        const r = { rate: s.manifest?.sampleRate, ctxRate: player.analyser.context.sampleRate, preserve: s.capabilities.canPreservePitch, pace, level: h.rms(player) };
        player.dispose();
        return r;
    });
    expect(r.rate).toBe(44100);
    expect(r.preserve).toBe(true);
    expect(r.pace).toBeGreaterThan(0.95);
    expect(r.pace).toBeLessThan(1.05);
    expect(r.level).toBeGreaterThan(0.02);
});
