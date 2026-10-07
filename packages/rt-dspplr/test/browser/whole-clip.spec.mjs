// Whole clips (decoded in full) and the output stage: the high-pass heard as
// the preview draws it; the transport while a clip is still loading (seek,
// play, pause, toggle, a loop); an output the system takes away or will not
// start; size limits for files too large; a caller's abort signal; a stereo
// stem B beside a mono A; stem B after stem A fails; stretch renders nobody
// waits for any more; the native compressor fallback levelled to the worklet;
// a failed effect kept out.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    await page.evaluate(() => {
        window.until = async (fn, timeout = 8000) => {
            const t0 = performance.now();
            while (performance.now() - t0 < timeout) { const v = fn(); if (v) return v; await h.sleep(10); }
            return null;
        };
        // Fake files: serve(path, { delay, seconds, status, declare }) answers fetches of
        // URLs ending in `path` with a WAV of `seconds` (with Content-Length unless declare
        // is false) after `delay` ms, honouring the request's abort signal.
        const routes = new Map();
        const originalFetch = window.fetch;
        window.serve = (path, options = {}) => routes.set(path, options);
        window.fetch = async (url, init = {}) => {
            const route = [...routes].find(([path]) => String(url).endsWith(path));
            if (!route) return originalFetch(url, init);
            const { delay = 0, seconds = 2, status = 200, declare = true } = route[1];
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, delay);
                init.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError'));
                });
            });
            if (status !== 200) return new Response('missing', { status });
            const bytes = h.wav(seconds);
            return new Response(bytes, { headers: declare ? { 'content-length': String(bytes.byteLength) } : {} });
        };
        /** A delayed stretch strategy that records what reaches its worker. */
        window.recording = (delay) => {
            const posts = [];
            const base = h.delayedStrategy(delay);
            const strategy = { ...base, createWorker() {
                const worker = base.createWorker();
                const post = worker.postMessage.bind(worker);
                // Recorded before the post: it transfers the channels away.
                worker.postMessage = (m, transfer) => { posts.push({ speed: m.speed, frames: m.channels[0].byteLength / 4, t: performance.now() }); post(m, transfer); };
                return worker;
            } };
            return { posts, strategy };
        };
    });
});

test('the high-pass is heard as the preview draws it: -3 dB at the cutoff, no bump above', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const sr = 48000, fc = 100;
        // A sine at f through the player's high-pass (its two native biquads): the steady
        // level after it against the oscillator's own, in dB.
        const heard = async (f) => {
            const ctx = new OfflineAudioContext(2, sr, sr);
            const osc = ctx.createOscillator();
            osc.frequency.value = f;
            const hp = h.advanced.createHighPass(ctx, fc);
            const merger = ctx.createChannelMerger(2);
            osc.connect(merger, 0, 0);
            osc.connect(hp.input);
            hp.output.connect(merger, 0, 1);
            merger.connect(ctx.destination);
            osc.start();
            const out = await ctx.startRendering();
            const peak = (ch) => { let p = 0; const d = out.getChannelData(ch); for (let i = sr / 2; i < sr; i++) p = Math.max(p, Math.abs(d[i])); return p; };
            return 20 * Math.log10(peak(1) / peak(0));
        };
        // What the waveform and spectrogram previews use: the same sections from computeHighPassCoefficients.
        const drawn = (f) => h.format.HIGH_PASS_SECTION_Q.reduce((db, q) => {
            const k = h.format.computeHighPassCoefficients(sr, fc, q);
            const w = 2 * Math.PI * f / sr;
            const nr = k.b0 + k.b1 * Math.cos(w) + k.b2 * Math.cos(2 * w), ni = -(k.b1 * Math.sin(w) + k.b2 * Math.sin(2 * w));
            const dr = 1 + k.a1 * Math.cos(w) + k.a2 * Math.cos(2 * w), di = -(k.a1 * Math.sin(w) + k.a2 * Math.sin(2 * w));
            return db + 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
        }, 0);
        const out = [];
        for (const ratio of [0.5, 0.8, 1, 1.29, 1.6, 2, 4]) out.push({ ratio, heard: await heard(fc * ratio), drawn: drawn(fc * ratio) });
        return out;
    });
    const at = (ratio) => r.find((x) => x.ratio === ratio);
    expect(at(1).heard).toBeGreaterThan(-3.3);
    expect(at(1).heard).toBeLessThan(-2.7);
    for (const x of r) {
        expect(Math.abs(x.heard - x.drawn), `${x.ratio} fc`).toBeLessThan(0.3);
        if (x.ratio >= 1) expect(x.heard, `${x.ratio} fc`).toBeLessThan(0.1);
    }
});

test('a seek while a whole clip loads sets where it starts, and its autoplay stands', async ({ page }) => {
    const r = await page.evaluate(async () => {
        serve('/seek-url.wav', { delay: 300, seconds: 4 });
        const p = h.make();
        // A URL: the seek comes before the file is even fetched.
        const playing = p.play('/seek-url.wav');
        await p.seek(2);
        const during = p.getState().currentTime;
        const started = await playing;
        await h.sleep(150);
        const url = { during, started, playing: p.getState().isPlaying, time: p.getCurrentTime(), rms: h.rms(p) };
        // Bytes: the seek comes while they are read.
        const bytes = p.play({ id: 'slow-bytes', src: h.slowBlob(4, 300) });
        await h.sleep(50);
        await p.seek(3);
        const blob = { started: await bytes };
        await h.sleep(150);
        Object.assign(blob, { playing: p.getState().isPlaying, time: p.getCurrentTime(), rms: h.rms(p) });
        p.dispose();
        return { url, blob };
    });
    expect(r.url.during).toBe(2);
    expect(r.url.started).toBe(true);
    expect(r.url.playing).toBe(true);
    expect(r.url.time).toBeGreaterThanOrEqual(2);
    expect(r.url.time).toBeLessThan(2.6);
    expect(r.url.rms).toBeGreaterThan(0.02);
    expect(r.blob.started).toBe(true);
    expect(r.blob.playing).toBe(true);
    expect(r.blob.time).toBeGreaterThanOrEqual(3);
    expect(r.blob.time).toBeLessThan(3.6);
    expect(r.blob.rms).toBeGreaterThan(0.02);
});

test('play, pause and toggle while a whole clip loads: the last word wins', async ({ page }) => {
    const r = await page.evaluate(async () => {
        for (const name of ['a', 'b', 'c', 'd']) serve(`/intent-${name}.wav`, { delay: 250, seconds: 3 });
        const p = h.make();
        const settle = async (loading) => { const ok = await loading; await h.sleep(150); return { ok, playing: p.getState().isPlaying, status: p.getState().status, rms: h.rms(p) }; };
        const out = {};
        // Both toggles say "play" (nothing plays yet): it plays.
        let loading = p.play('/intent-a.wav');
        await p.toggle();
        await p.toggle();
        out.toggles = await settle(loading);
        // A pause: it stays paused.
        loading = p.play('/intent-b.wav');
        await p.pause();
        out.paused = await settle(loading);
        // A pause, then play(): it plays.
        loading = p.play('/intent-c.wav');
        await p.pause();
        await h.sleep(30);
        await p.play();
        out.resumed = await settle(loading);
        // load() without autoplay, then play() before it is in: it plays once in.
        loading = p.load('/intent-d.wav');
        await h.sleep(30);
        out.early = await p.play();
        out.loadThenPlay = await settle(loading);
        p.dispose();
        return out;
    });
    expect(r.toggles.playing).toBe(true);
    expect(r.toggles.rms).toBeGreaterThan(0.02);
    expect(r.paused).toMatchObject({ playing: false, status: 'ready' });
    expect(r.paused.rms).toBeLessThan(0.001);
    expect(r.resumed.playing).toBe(true);
    expect(r.resumed.rms).toBeGreaterThan(0.02);
    expect(r.early).toBe(false);
    expect(r.loadThenPlay.playing).toBe(true);
    expect(r.loadThenPlay.rms).toBeGreaterThan(0.02);
});

test('an output the system takes away pauses at its position and says so; play() goes on from there', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const p = h.make();
        await p.play(h.buffer(8));
        await h.sleep(400);
        // What an interruption does to the context (a call on iOS: 'interrupted'; here 'suspended').
        await p.audioContext.suspend();
        await until(() => !p.getState().isPlaying, 2000);
        const s = p.getState();
        const paused = { playing: s.isPlaying, suspended: s.suspended, time: p.getCurrentTime() };
        await h.sleep(200);
        const still = p.getCurrentTime();
        const resumed = await p.play();
        await h.sleep(300);
        const after = { resumed, playing: p.getState().isPlaying, suspended: p.getState().suspended, time: p.getCurrentTime(), rms: h.rms(p) };
        p.dispose();
        return { paused, still, after };
    });
    expect(r.paused.playing).toBe(false);
    expect(r.paused.suspended).toBe('interrupted');
    expect(r.paused.time).toBeGreaterThan(0.3);
    expect(r.paused.time).toBeLessThan(0.8);
    expect(r.still).toBe(r.paused.time);
    expect(r.after).toMatchObject({ resumed: true, playing: true, suspended: null });
    expect(r.after.time).toBeGreaterThan(r.paused.time + 0.15);
    expect(r.after.time).toBeLessThan(r.paused.time + 0.7);
    expect(r.after.rms).toBeGreaterThan(0.02);
});

test('a play() whose output will not start says so, and a later speed change does not start it', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const p = h.make();
        await p.load(h.buffer(4));
        await p.audioContext.suspend();
        const resume = AudioContext.prototype.resume;
        // As outside a user gesture, or during an interruption on iOS.
        AudioContext.prototype.resume = function () { return Promise.reject(new DOMException('Not allowed', 'NotAllowedError')); };
        const started = await p.play();
        await until(() => p.getState().suspended, 4000);
        const blocked = { started, suspended: p.getState().suspended, status: p.getState().status, playing: p.getState().isPlaying };
        AudioContext.prototype.resume = resume;
        // The failed play is over: a speed change (applied at once with the native
        // strategy) must not start the clip by itself.
        await p.setSpeed(1.5);
        await h.sleep(150);
        const afterSpeed = { playing: p.getState().isPlaying, speed: p.getState().processing.speed };
        const again = await p.play();
        await h.sleep(200);
        const after = { again, playing: p.getState().isPlaying, suspended: p.getState().suspended, rms: h.rms(p) };
        p.dispose();
        return { blocked, afterSpeed, after };
    });
    expect(r.blocked).toEqual({ started: false, suspended: 'blocked', status: 'ready', playing: false });
    expect(r.afterSpeed).toEqual({ playing: false, speed: 1.5 });
    expect(r.after).toMatchObject({ again: true, playing: true, suspended: null });
    expect(r.after.rms).toBeGreaterThan(0.02);
});

test('maxClipBytes and maxClipSeconds fail a whole clip early, pointing to prepared playback', async ({ page }) => {
    const r = await page.evaluate(async () => {
        serve('/big-declared.wav', { seconds: 3 });
        serve('/big-streamed.wav', { seconds: 3, declare: false });
        serve('/fits.wav', { seconds: 1 });
        // 16-bit mono at 48 kHz is 96 KB a second: 3 s is over 200 000 bytes, 2.05 s is under.
        const p = h.make({ maxClipBytes: 200_000, maxClipSeconds: 2 });
        const errors = [];
        p.on('error', (e) => errors.push(e));
        const attempt = async (clip) => {
            const ok = await p.load(clip);
            const s = p.getState();
            return { ok, status: s.status, name: s.error?.name ?? null, message: s.error?.message ?? '' };
        };
        const out = {
            declared: await attempt('/big-declared.wav'),
            streamed: await attempt('/big-streamed.wav'),
            blob: await attempt(new Blob([h.wav(3)])),
            long: await attempt(new Blob([h.wav(2.05)])),
            buffer: await attempt(h.buffer(3)),
        };
        out.fits = { ok: await p.play('/fits.wav') };
        await h.sleep(150);
        Object.assign(out.fits, { duration: p.getState().duration, playing: p.getState().isPlaying, rms: h.rms(p) });
        out.errors = errors.length;
        p.dispose();
        return out;
    });
    for (const key of ['declared', 'streamed', 'blob', 'long', 'buffer']) {
        expect(r[key], key).toMatchObject({ ok: false, status: 'error', name: 'ClipTooLargeError' });
        expect(r[key].message, key).toMatch(/manifest/);
    }
    expect(r.declared.message).toMatch(/MiB/);
    expect(r.long.message).toMatch(/2\.05 s long, over the limit of 2 s/);
    expect(r.errors).toBe(5);
    expect(r.fits).toMatchObject({ ok: true, duration: 1, playing: true });
    expect(r.fits.rms).toBeGreaterThan(0.02);
});

test('an abort through fetchOptions.signal fails the load instead of leaving it loading', async ({ page }) => {
    const r = await page.evaluate(async () => {
        serve('/abort-me.wav', { delay: 400, seconds: 1 });
        const controller = new AbortController();
        const p = h.make({ fetchOptions: { signal: controller.signal } });
        const loading = p.load('/abort-me.wav');
        await h.sleep(100);
        controller.abort();
        const ok = await loading;
        const s = p.getState();
        p.dispose();
        return { ok, status: s.status, error: !!s.error };
    });
    expect(r).toEqual({ ok: false, status: 'error', error: true });
});

test('a loop set while a whole clip loads is in place once it plays', async ({ page }) => {
    const r = await page.evaluate(async () => {
        serve('/loop-while-loading.wav', { delay: 250, seconds: 4 });
        const p = h.make();
        const playing = p.play('/loop-while-loading.wav');
        await h.sleep(50);
        p.setLoop({ start: 0.5, end: 1 });
        const started = await playing;
        // Into the loop from 0 and round it: still inside it 1.6 s on.
        await h.sleep(1600);
        const r = { started, loop: p.getState().loop, time: p.getCurrentTime(), playing: p.getState().isPlaying, rms: h.rms(p) };
        p.dispose();
        return r;
    });
    expect(r.started).toBe(true);
    expect(r.playing).toBe(true);
    expect(r.loop.start).toBeCloseTo(0.5, 2);
    expect(r.loop.end).toBeCloseTo(1, 2);
    expect(r.time).toBeGreaterThanOrEqual(0.49);
    expect(r.time).toBeLessThan(1.01);
    expect(r.rms).toBeGreaterThan(0.02);
});

test('a stereo stem B beside a mono stem A plays in stereo: given with the clip, or handed in while it plays', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const sr = 48000;
        // Stem B: silent on the left, a tone on the right.
        const rightOnly = (seconds) => {
            const b = new AudioBuffer({ length: seconds * sr, sampleRate: sr, numberOfChannels: 2 });
            const d = b.getChannelData(1);
            for (let i = 0; i < d.length; i += 1) d[i] = 0.2 * Math.sin(2 * Math.PI * 660 * i / sr);
            return b;
        };
        const p = h.make();
        let taps = null;
        // Each channel of the output, after the analyser (split as is: a mono output is heard on the left only here).
        const ears = () => {
            if (!taps) {
                const ctx = p.analyser.context;
                const split = ctx.createChannelSplitter(2);
                p.analyser.connect(split);
                taps = [ctx.createAnalyser(), ctx.createAnalyser()];
                split.connect(taps[0], 0);
                split.connect(taps[1], 1);
                // Pulled by the destination (silently), or they would not be processed.
                const mute = ctx.createGain();
                mute.gain.value = 0;
                taps.forEach((tap) => tap.connect(mute));
                mute.connect(ctx.destination);
            }
            const level = (an) => { const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); return Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length); };
            return { left: level(taps[0]), right: level(taps[1]), channels: p._source._eng?.channels ?? null, time: p.getCurrentTime() };
        };
        p.setMix(1);
        await p.play({ id: 'with-the-clip', src: h.buffer(4), srcB: rightOnly(4) });
        ears(); // the taps, once the output is there
        await h.sleep(300);
        const withClip = ears();
        await p.play({ id: 'handed-in', src: h.buffer(4), srcB: h.buffer(4) });
        await h.sleep(300);
        const before = ears();
        const installed = await p.setSourceB(rightOnly(4));
        await h.sleep(300);
        const after = { ...ears(), installed, playing: p.getState().isPlaying };
        p.dispose();
        return { withClip, before, after };
    });
    expect(r.withClip.channels).toBe(2);
    expect(r.withClip.right).toBeGreaterThan(0.05);
    expect(r.withClip.left).toBeLessThan(0.01);
    // A mono pair plays on a mono engine; a stereo B moves the clip to a stereo one, from where it was.
    expect(r.before.channels).toBe(1);
    expect(r.before.left).toBeGreaterThan(0.02);
    expect(r.after.installed).toBe(true);
    expect(r.after.channels).toBe(2);
    expect(r.after.playing).toBe(true);
    expect(r.after.right).toBeGreaterThan(0.05);
    expect(r.after.left).toBeLessThan(0.01);
    expect(r.after.time).toBeGreaterThan(r.before.time + 0.2);
});

test('stem B is not left loading when stem A fails', async ({ page }) => {
    const r = await page.evaluate(async () => {
        serve('/missing-a.wav', { delay: 100, status: 404 });
        const p = h.make({ prefetchB: true });
        const ok = await p.load({ id: 'ab', src: '/missing-a.wav', srcB: h.buffer(1) });
        await h.sleep(100);
        const s = p.getState();
        p.dispose();
        return { ok, status: s.status, statusB: s.statusB };
    });
    expect(r).toEqual({ ok: false, status: 'error', statusB: 'idle' });
});

test('a render another player waits for is kept; one nobody waits for is dropped or stopped', async ({ page }) => {
    const r = await page.evaluate(async () => {
        // Two players on one URL share the decoded clip, so their prewarms are the same jobs.
        // The first one leaving for another clip must not cancel what the second waits for.
        serve('/shared.wav', { seconds: 3 });
        const shared = recording(250);
        const p1 = h.make({ stretcher: shared.strategy, prewarmSpeeds: [1.5, 2] });
        const p2 = h.make({ stretcher: shared.strategy, prewarmSpeeds: [1.5, 2] });
        await p1.load('/shared.wav');
        await p2.load('/shared.wav');
        const frames = p2.getState().buffer.length;
        const same = p1.getState().buffer === p2.getState().buffer;
        await p1.load({ id: 'other', src: h.buffer(1) });
        await until(() => shared.posts.filter((q) => q.frames === frames).length >= 2, 3000);
        const sharedSpeeds = shared.posts.filter((q) => q.frames === frames).map((q) => q.speed).sort();
        p1.dispose();
        p2.dispose();

        // One player leaving clip x: its running prewarm is stopped and its queued playback
        // render dropped, so clip y's render starts at once instead of after both.
        const own = recording(400);
        const p = h.make({ stretcher: own.strategy, prewarmSpeeds: [2] });
        await p.load({ id: 'x', src: h.buffer(3) });
        const speed = p.setSpeed(1.5);
        await h.sleep(20);
        const t0 = performance.now();
        await p.load({ id: 'y', src: h.buffer(2) });
        await until(() => own.posts.some((q) => q.frames === 96000), 3000);
        await speed;
        await h.sleep(600);
        const x = own.posts.filter((q) => q.frames === 144000).map((q) => q.speed);
        const yStart = own.posts.find((q) => q.frames === 96000).t - t0;
        // The stopped worker was replaced, not counted as a crash: y's render completes.
        await p.setSpeed(2);
        const ySpeed = p.getState().processing.speed;
        p.dispose();
        return { same, sharedSpeeds, x, yStart, ySpeed };
    });
    expect(r.same).toBe(true);
    expect(r.sharedSpeeds).toEqual([1.5, 2]);
    expect(r.x).toEqual([2]);
    expect(r.yStart).toBeLessThan(200);
    expect(r.ySpeed).toBe(2);
});

test('the native compressor fallback sits at the worklet\'s levels (no automatic makeup gain)', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const sr = 48000;
        // A constant input: both detectors read its level exactly, so the steady output
        // is each compressor's static curve.
        const level = async (amount, inDb) => {
            const ctx = new OfflineAudioContext(1, sr, sr);
            const dc = ctx.createConstantSource();
            dc.offset.value = 10 ** (inDb / 20);
            const comp = h.advanced.createCompressor(ctx, amount);
            dc.connect(comp.input);
            comp.output.connect(ctx.destination);
            dc.start();
            const out = (await ctx.startRendering()).getChannelData(0);
            return 20 * Math.log10(Math.abs(out[sr - 1]));
        };
        // The worklet's static law (compression.ts): threshold -24·a dB, ratio 1 + 15·a,
        // a soft knee of 2 + 6·a dB centred on the threshold.
        const worklet = (a, x) => {
            const t = -24 * a, ratio = 1 + 15 * a, knee = 2 + 6 * a;
            if (ratio <= 1 || x <= t - knee / 2) return x;
            if (x >= t + knee / 2) return x + (1 / ratio - 1) * (x - t);
            const d = x - t + knee / 2;
            return x + (1 / ratio - 1) * d * d / (2 * knee);
        };
        const out = [];
        for (const amount of [0, 0.5, 1]) {
            for (const inDb of [-30, -12, -6]) out.push({ amount, inDb, native: await level(amount, inDb), worklet: worklet(amount, inDb) });
        }
        return out;
    });
    for (const x of r) expect(Math.abs(x.native - x.worklet), `amount ${x.amount}, ${x.inDb} dB in`).toBeLessThan(1.5);
});

test('a failed effect stays out: it cannot be put back, nor made again when the output is rebuilt', async ({ page }) => {
    const r = await page.evaluate(async () => {
        let creates = 0;
        const broken = {
            id: 'test.broken', name: 'Broken', version: '1', params: [],
            realtime: { kind: 'nodes', create() { creates += 1; throw new Error('cannot start'); } },
        };
        const p = h.make();
        await p.load(h.buffer(1));
        const id = p.effects.add(broken);
        await until(() => p.getState().effects.find((e) => e.id === id)?.error, 2000);
        p.effects.bypass(id, true);
        p.effects.bypass(id, false);
        const after = p.getState().effects.find((e) => e.id === id);
        // dispose() keeps the effect list; the next load builds the output chain from it.
        p.dispose();
        p.reactivate();
        await p.load(h.buffer(1));
        await h.sleep(100);
        const rebuilt = p.getState().effects.find((e) => e.id === id);
        p.dispose();
        return { error: after.error, bypassed: after.bypassed, creates, rebuilt: !!rebuilt?.error };
    });
    expect(r.error).toMatch(/Broken/);
    expect(r.bypassed).toBe(true);
    expect(r.creates).toBe(1);
    expect(r.rebuilt).toBe(true);
});
