import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
});

test('main entry is narrow; advanced exports remain available', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const main = await import('../../dist/index.js');
        return { track: 'Track' in main, factory: typeof main.createAudioPlayer, advanced: typeof h.advanced.Track };
    });
    expect(result).toEqual({ track: false, factory: 'function', advanced: 'function' });
});

test('buffer playback, seek and independent player disposal', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const a = h.make(), b = h.make();
        await Promise.all([a.play(h.buffer()), b.play(h.buffer())]);
        await a.seek(3); const seek = a.getCurrentTime(); a.dispose(); await h.sleep(150);
        const result = { seek, a: a.getState().status, b: b.getState().isPlaying, time: b.getCurrentTime(), rms: h.rms(b) };
        b.dispose(); return result;
    });
    expect(result.seek).toBeGreaterThanOrEqual(3); expect(result.a).toBe('idle'); expect(result.b).toBe(true);
    expect(result.time).toBeGreaterThan(0); expect(result.rms).toBeGreaterThan(0.02);
});

for (const action of ['stop', 'pause', 'dispose']) {
    test(`${action} cancels a playback waiting on a worker`, async ({ page }) => {
        const result = await page.evaluate(async action => {
            const p = h.make({ stretcher: h.delayedStrategy(), processing: { speed: 1.5 } });
            await p.load(h.buffer());
            const start = p.play(); await h.sleep(40); await p[action](); await start; await h.sleep(120);
            const result = { playing: p.getState().isPlaying, status: p.getState().status, rms: p.analyser ? h.rms(p) : 0 };
            p.dispose(); return result;
        }, action);
        expect(result.playing).toBe(false); expect(result.rms).toBeLessThan(0.001);
        if (action === 'dispose') expect(result.status).toBe('idle');
    });
}

test('new clip supersedes a slow byte decode', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const p = h.make(); await p.load(h.buffer());
        const old = p.play({ id: 'old', src: h.slowBlob(2) });
        await h.sleep(20); await p.play({ id: 'new', src: h.buffer(4) }); await old;
        const s = p.getState(); p.dispose(); return { id: s.clipId, duration: s.duration, playing: s.isPlaying };
    });
    expect(result).toEqual({ id: 'new', duration: 4, playing: true });
});

test('stop during initial load prevents late autoplay', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const p = h.make(); const loading = p.play(h.slowBlob(2), { startAt: 1 });
        p.stop(); await loading; await h.sleep(100);
        const result = { playing: p.getState().isPlaying, status: p.getState().status, time: p.getCurrentTime(), stateTime: p.getState().currentTime }; p.dispose(); return result;
    });
    expect(result).toEqual({ playing: false, status: 'ready', time: 0, stateTime: 0 });
});

test('speed preparation keeps audio and position moving; switch uses live position', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const p = h.make({ stretcher: h.delayedStrategy() }); await p.play(h.buffer()); await h.sleep(140);
        const before = p.getCurrentTime(); const changing = p.setSpeed(2); await h.sleep(130);
        const during = { time: p.getCurrentTime(), applied: p.getState().processing.speed, pending: p.getState().pendingSpeed, rms: h.rms(p) };
        await changing; const after = { time: p.getCurrentTime(), applied: p.getState().processing.speed, pending: p.getState().pendingSpeed };
        p.dispose(); return { before, during, after };
    });
    expect(result.during.applied).toBe(1); expect(result.during.pending).toBe(2);
    expect(result.during.time).toBeGreaterThan(result.before + 0.06); expect(result.during.rms).toBeGreaterThan(0.02);
    expect(result.after.applied).toBe(2); expect(result.after.pending).toBeNull();
    expect(result.after.time).toBeGreaterThan(result.during.time);
});

test('latest speed wins; zero cache budget does not recompute at start', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const p = h.make({ stretcher: h.delayedStrategy(120), cacheBudgetBytes: 0 }); await p.play(h.buffer());
        const first = p.setSpeed(2), second = p.setSpeed(1.5); await Promise.all([first, second]);
        const result = { speed: p.getState().processing.speed, pending: p.getState().pendingSpeed, time: p.getCurrentTime(), cache: h.getAudioCacheStats().usedBytes };
        p.dispose(); return result;
    });
    expect(result.speed).toBe(1.5); expect(result.pending).toBeNull(); expect(result.cache).toBe(0);
    expect(result.time).toBeGreaterThan(0.15); expect(result.time).toBeLessThan(2);
});

test('stop during speed preparation does not restart playback', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const p = h.make({ stretcher: h.delayedStrategy() }); await p.play(h.buffer());
        const changing = p.setSpeed(2); await h.sleep(50); p.stop(); await changing; await h.sleep(120);
        const s = p.getState(); const rms = h.rms(p); p.dispose();
        return { playing: s.isPlaying, speed: s.processing.speed, pending: s.pendingSpeed, rms };
    });
    expect(result.playing).toBe(false); expect(result.speed).toBe(1); expect(result.pending).toBeNull(); expect(result.rms).toBeLessThan(0.001);
});

test('identical stem B has no midpoint gain boost', async ({ page }) => {
    const levels = await page.evaluate(async () => {
        const p = h.make(); const b = h.buffer();
        await p.load(b); await p.setSourceB(b); await p.play();
        const levels = [];
        for (const mix of [0, 0.5, 1]) { p.setMix(mix); await h.sleep(160); levels.push(h.rms(p)); }
        p.dispose(); return levels;
    });
    expect(levels[0]).toBeGreaterThan(0.04);
    expect(levels[1] / levels[0]).toBeGreaterThan(0.96); expect(levels[1] / levels[0]).toBeLessThan(1.04);
    expect(levels[2] / levels[0]).toBeGreaterThan(0.96); expect(levels[2] / levels[0]).toBeLessThan(1.04);
});

test('separation mix plays both stems at full in the middle', async ({ page }) => {
    const levels = await page.evaluate(async () => {
        const p = h.make({ mixLaw: 'separation' }); const b = h.buffer();
        await p.load(b); await p.setSourceB(b); await p.play();
        const levels = [];
        // The level is read once it has settled: a busy machine renders audio in larger blocks,
        // and a fixed wait can catch the mix half way.
        const settled = async () => {
            let last = h.rms(p);
            for (let i = 0; i < 30; i++) { await h.sleep(50); const now = h.rms(p); if (Math.abs(now - last) <= 0.02 * last) return now; last = now; }
            return last;
        };
        for (const mix of [0, 0.25, 0.5, 1]) { p.setMix(mix); await h.sleep(120); levels.push(await settled()); }
        p.dispose(); return levels;
    });
    expect(levels[0]).toBeGreaterThan(0.04);
    expect(levels[1] / levels[0]).toBeGreaterThan(1.45); expect(levels[1] / levels[0]).toBeLessThan(1.55);
    expect(levels[2] / levels[0]).toBeGreaterThan(1.94); expect(levels[2] / levels[0]).toBeLessThan(2.06);
    expect(levels[3] / levels[0]).toBeGreaterThan(0.96); expect(levels[3] / levels[0]).toBeLessThan(1.04);
});

test('dropping or moving the loop while playing keeps the position', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const p = h.make(); await p.play(h.buffer(20));
        p.setLoop({ start: 1, end: 2 }); await h.sleep(2300);
        const looped = p.getCurrentTime();
        p.setLoop(null); const dropped = p.getCurrentTime(); await h.sleep(300); const later = p.getCurrentTime();
        await p.pause(); const paused = p.getCurrentTime(); await p.play(); await h.sleep(200);
        const resumed = { time: p.getCurrentTime(), playing: p.getState().isPlaying, ended: p.getState().ended };
        // A loop behind the playhead: both stems jump to its start.
        p.setLoop({ start: 0.2, end: 0.7 }); await h.sleep(150); const moved = p.getCurrentTime();
        p.dispose(); return { looped, dropped, later, paused, resumed, moved };
    });
    expect(result.looped).toBeGreaterThanOrEqual(1); expect(result.looped).toBeLessThan(2.1);
    expect(result.dropped).toBeGreaterThanOrEqual(1); expect(result.dropped).toBeLessThan(2.3);
    expect(result.later).toBeGreaterThan(result.dropped + 0.2); expect(result.later).toBeLessThan(3);
    expect(result.paused).toBeLessThan(3.5);
    expect(result.resumed.playing).toBe(true); expect(result.resumed.ended).toBe(false);
    expect(result.resumed.time).toBeGreaterThan(result.paused); expect(result.resumed.time).toBeLessThan(4);
    expect(result.moved).toBeGreaterThanOrEqual(0.2); expect(result.moved).toBeLessThan(0.7);
});

test('a seek at a speed does not render the variant again, even when it does not fit the cache', async ({ page }) => {
    const result = await page.evaluate(async () => {
        window.stretchJobs = 0;
        const base = h.delayedStrategy(60);
        const strategy = { ...base, createWorker() {
            const worker = base.createWorker(); const post = worker.postMessage.bind(worker);
            worker.postMessage = (...args) => { window.stretchJobs += 1; post(...args); }; return worker;
        } };
        const p = h.make({ stretcher: strategy, cacheBudgetBytes: 0 }); await p.play(h.buffer(4)); await p.setSpeed(1.5);
        const afterSpeed = window.stretchJobs;
        await p.seek(1); await h.sleep(50); await p.seek(2); await h.sleep(50); await p.pause(); await p.play(); await h.sleep(50);
        const s = p.getState(); const result = { afterSpeed, total: window.stretchJobs, speed: s.processing.speed, playing: s.isPlaying, time: p.getCurrentTime() };
        p.dispose(); return result;
    });
    expect(result.afterSpeed).toBe(1); expect(result.total).toBe(1);
    expect(result.speed).toBe(1.5); expect(result.playing).toBe(true); expect(result.time).toBeGreaterThan(2);
});

test('late stem B response cannot attach to another clip', async ({ page }) => {
    const result = await page.evaluate(async () => {
        let resolve; const lateB = new Promise(r => resolve = r);
        const p = h.make({ loadB: clip => clip.id === 'old' ? lateB : Promise.resolve(null) });
        await p.play({ id: 'old', src: h.buffer(3) }); p.setMix(1); await h.sleep(20);
        await p.play({ id: 'new', src: h.buffer(5) }); p.setMix(0);
        resolve(h.buffer(3)); await h.sleep(120);
        const s = p.getState(); p.dispose(); return { id: s.clipId, duration: s.duration, bufferB: s.bufferB };
    });
    expect(result).toEqual({ id: 'new', duration: 5, bufferB: null });
});

test('React StrictMode remount loads and unmount releases nodes', async ({ page }) => {
    await page.evaluate(() => { window.root = h.mountStrict(); });
    await page.waitForFunction(() => window.strictPlayer?.getState().isPlaying);
    await page.evaluate(() => window.root.unmount());
    expect(await page.evaluate(() => ({ disposed: strictPlayer.disposed, status: strictPlayer.getState().status }))).toEqual({ disposed: true, status: 'idle' });
});

test('built-in vocoder works without the Rubber Band entry', async ({ page }) => {
    const requests = []; page.on('request', req => requests.push(req.url()));
    const result = await page.evaluate(async () => {
        const p = h.make({ stretcher: h.vocoderStretcher }); await p.play(h.buffer(2)); await p.setSpeed(1.5); await h.sleep(120);
        const result = { playing: p.getState().isPlaying, speed: p.getState().processing.speed, rms: h.rms(p) }; p.dispose(); return result;
    });
    expect(result.playing).toBe(true); expect(result.speed).toBe(1.5); expect(result.rms).toBeGreaterThan(0.01);
    expect(requests.some(url => /rubberband/i.test(url))).toBe(false);
});

test('vocoderStretcher({ memory }) renders speeds in the worker, lean and fast', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const out = {};
        for (const memory of ['lean', 'fast']) {
            const strategy = h.vocoderStretcher({ memory });
            const p = h.make({ stretcher: strategy }); await p.play(h.buffer(2)); await p.setSpeed(1.5); await h.sleep(120);
            out[memory] = { id: strategy.id, speed: p.getState().processing.speed, pending: p.getState().pendingSpeed, rms: h.rms(p) > 0.01 };
            p.dispose();
        }
        return { ...out, defaultId: h.vocoderStretcher.id, callable: typeof h.vocoderStretcher };
    });
    expect(result).toEqual({
        lean: { id: 'vocoder:lean', speed: 1.5, pending: null, rms: true },
        fast: { id: 'vocoder:fast', speed: 1.5, pending: null, rms: true },
        defaultId: 'vocoder',
        callable: 'function',
    });
});

test('strategy options the worker cannot receive fail the job, not the player', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const strategy = { ...h.delayedStrategy(50), options: { notCloneable: () => 1 } };
        const p = h.make({ stretcher: strategy }); await p.play(h.buffer(2));
        await Promise.race([p.setSpeed(1.5), h.sleep(1500)]); await h.sleep(100);
        const s = p.getState(); const result = { playing: s.isPlaying, speed: s.processing.speed, pending: s.pendingSpeed }; p.dispose(); return result;
    });
    expect(result).toEqual({ playing: true, speed: 1.5, pending: null });
});

test('changing speed while play is preparing still starts the requested clip', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const p = h.make({ stretcher: h.delayedStrategy(100), processing: { speed: 1.5 } });
        await p.load(h.buffer()); const playing = p.play(); await h.sleep(25);
        await p.setSpeed(2); await playing; await h.sleep(100);
        const s = p.getState(); p.dispose(); return { playing: s.isPlaying, speed: s.processing.speed };
    });
    expect(result).toEqual({ playing: true, speed: 2 });
});

test('stem B prefetch arriving during preparation does not cancel autoplay', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const p = h.make({ stretcher: h.delayedStrategy(100), processing: { speed: 1.5, mix: 0.5 }, prefetchB: true });
        const started = await p.play({ src: h.buffer(), srcB: h.buffer() }); await h.sleep(150);
        const s = p.getState(); p.dispose(); return { started, playing: s.isPlaying, statusB: s.statusB };
    });
    expect(result).toEqual({ started: true, playing: true, statusB: 'ready' });
});

test('waveform preview uses the same linear mix as playback', async ({ page }) => {
    const ratio = await page.evaluate(async () => {
        const b = h.buffer(0.2);
        const measure = mix => new Promise(resolve => {
            const analyzer = new h.advanced.WaveformAnalyzer(({ processed }) => {
                if (!processed) return;
                const peak = Math.max(...processed.levels[0].maxPeaks); analyzer.dispose(); resolve(peak);
            });
            analyzer.setBuffers(b, b, { highPassHz: 0, compression: 0, outputGain: 1, mix: mix });
        });
        return await measure(0.5) / await measure(0);
    });
    expect(ratio).toBeCloseTo(1, 4);
});

test('the default high-pass passes the audio through bit for bit', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const length = 48000;
        const ctx = new OfflineAudioContext(1, length, 48000);
        const source = ctx.createBufferSource();
        source.buffer = ctx.createBuffer(1, length, 48000);
        const input = source.buffer.getChannelData(0);
        let seed = 3;
        for (let i = 0; i < length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; input[i] = seed / 0x7fffffff - 0.5; }
        const highPass = h.advanced.createHighPass(ctx, h.DEFAULT_PROCESSING.highPassHz);
        source.connect(highPass.input); highPass.output.connect(ctx.destination); source.start();
        const output = (await ctx.startRendering()).getChannelData(0);
        let changed = 0;
        for (let i = 0; i < length; i++) if (output[i] !== input[i]) changed++;
        return { hz: h.DEFAULT_PROCESSING.highPassHz, changed };
    });
    expect(result).toEqual({ hz: 0, changed: 0 });
});

test('switching from URL to bytes cancels an older fetch', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const originalFetch = window.fetch;
        window.fetch = async (url, options) => {
            if (String(url).includes('/slow.wav')) { await h.sleep(200); return new Response(h.wav(2)); }
            return originalFetch(url, options);
        };
        const p = h.make(); const old = p.load({ id: 'old-url', src: '/slow.wav' }); await h.sleep(40);
        await p.play({ id: 'new-buffer', src: h.buffer(4) }); await old;
        const s = p.getState(); p.dispose(); window.fetch = originalFetch;
        return { id: s.clipId, duration: s.duration, playing: s.isPlaying };
    });
    expect(result).toEqual({ id: 'new-buffer', duration: 4, playing: true });
});

test('seek during speed preparation cancels the stale speed switch', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const p = h.make({ stretcher: h.delayedStrategy(150) }); await p.play(h.buffer());
        const changing = p.setSpeed(2); await h.sleep(25); await p.seek(4); await changing;
        const s = p.getState(); const time = p.getCurrentTime(); p.dispose(); return { time, speed: s.processing.speed, pending: s.pendingSpeed };
    });
    expect(result.time).toBeGreaterThanOrEqual(4); expect(result.time).toBeLessThan(5);
    expect(result.speed).toBe(1); expect(result.pending).toBeNull();
});
