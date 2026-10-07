// Prepared (manifest) clips on the one player core, and the same transport
// suite on both sources. Fixtures from long-fixtures.mjs: stereo70 (70 s
// stereo, 10 s segments) and mono30 (30 s mono, 3 s segments), each also as
// the source WAV for the whole-clip source; mp3clip, opusclip and flacclip (2 s, 0.5 s
// segments) with the decoder's samples beside them.
import { test, expect } from '@playwright/test';

const BASE = '/node_modules/.cache/rtd-long';

/** Hold segment requests (Range requests of the source) until release() (the overview must not need them). */
async function gateSegments(page) {
    let open;
    const opened = new Promise((resolve) => { open = resolve; });
    await page.route('**/source.*', async (route) => {
        await opened;
        await route.continue();
    });
    return { release: () => open() };
}

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    await page.evaluate((base) => {
        window.longBase = base;
        window.mk = (options = {}, timeline = {}) => {
            const ui = document.body.appendChild(document.createElement('div'));
            ui.style.width = '800px';
            const seek = ui.appendChild(document.createElement('div'));
            seek.style.height = '100px';
            const player = h.createAudioPlayer({ element: ui, prewarmSpeeds: false, stretcher: 'native', ...options });
            const view = h.createTimeline(seek, player, timeline);
            return { player, view, seek };
        };
        /** Pixels with any ink (alpha) on the matching canvases. */
        window.ink = (root, selector = 'canvas') => {
            let n = 0;
            for (const c of root.querySelectorAll(selector)) {
                if (!c.width || !c.height) continue;
                const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n += 1;
            }
            return n;
        };
        window.snap = (root, selector) => {
            const out = [];
            for (const c of root.querySelectorAll(selector)) {
                if (!c.width || !c.height) continue;
                const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                for (let i = 0; i < px.length; i += 1) out.push(px[i]);
            }
            return out;
        };
        /** Fraction of RGBA values that differ by more than 8 between two snapshots. */
        window.diff = (a, b) => {
            if (a.length !== b.length || a.length === 0) return 1;
            let d = 0;
            for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > 8) d += 1;
            return d / a.length;
        };
        window.until = async (fn, timeout = 8000) => {
            const t0 = performance.now();
            while (performance.now() - t0 < timeout) { const v = fn(); if (v) return v; await h.sleep(10); }
            return null;
        };
        window.zoomIn = (seek, steps) => {
            const track = seek.querySelector('.rtd-scrub-track');
            track.focus();
            for (let i = 0; i < steps; i += 1) track.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
        };
    }, BASE);
});

test('manifest + peaks draw the whole waveform before any segment arrives', async ({ page }) => {
    const gate = await gateSegments(page);
    const result = await page.evaluate(async () => {
        const { player, seek } = mk();
        const t0 = performance.now();
        await player.load({ manifest: `${longBase}/stereo70/manifest.json` });
        // Deterministic: wait for the overview peaks, then for pixels.
        const first = await until(() => player.getPeakPyramid());
        const drawnAt = await until(() => ink(seek, '.rtd-wave') > 0 && performance.now());
        const full = await until(() => player.getPeakPyramid()?.levels[0]?.binSize === 256 && player.getPeakPyramid());
        const s = player.getState();
        const r = {
            uiMs: drawnAt - t0, status: s.status, duration: s.duration, kind: s.sourceKind,
            caps: s.capabilities, firstLevels: first.levels.map((l) => l.binSize), levels: full.levels.map((l) => l.binSize),
            stats: player.getStreamStats(),
        };
        player.dispose();
        return r;
    });
    gate.release();
    expect(result.status).toBe('ready');
    expect(result.kind).toBe('segmented');
    expect(result.caps.canMixStemB).toBe(false);
    expect(result.duration).toBeCloseTo(70, 3);
    // The first Range request brings every level but the finest (which may already be in when polled).
    expect(result.firstLevels).toContain(2048);
    expect(result.stats.peaksCoarseBytes).toBeLessThan(result.stats.peaksFineBytes);
    expect(result.levels).toEqual([256, 2048]);
    expect(result.uiMs).toBeLessThan(3000);
    expect(result.stats.fetches).toBe(0);
});

test('HP / compression change the drawn waveform before segments load (approximate) and after (exact window)', async ({ page }) => {
    const gate = await gateSegments(page);
    const before = await page.evaluate(async () => {
        const { player, seek } = mk();
        window.p = player; window.pSeek = seek;
        await player.load({ manifest: `${longBase}/stereo70/manifest.json` });
        await until(() => player.getState().prepared?.bands && player.getPeakPyramid()?.levels[0]?.binSize === 256);
        await h.sleep(150);
        const a = snap(seek, '.rtd-wave');
        player.setHighPass(400);
        player.setCompression(1);
        player.setOutputGain(-12);
        await h.sleep(200);
        const b = snap(seek, '.rtd-wave');
        return { change: diff(a, b), fetched: player.getStreamStats().fetches };
    });
    expect(before.fetched).toBe(0);
    expect(before.change).toBeGreaterThan(0.01);
    gate.release();
    const after = await page.evaluate(async () => {
        const player = window.p, seek = window.pSeek;
        player.setProcessing({ highPassHz: 0, compression: 0, outputGainDb: 0 });
        zoomIn(seek, 8); // a ~8 s view: its segments are decoded for the exact preview
        const exact = await until(() => player.getWindowAudio(), 8000);
        await h.sleep(400);
        const a = snap(seek, '.rtd-wave');
        player.setHighPass(400);
        player.setCompression(1);
        player.setOutputGain(-12);
        await h.sleep(400);
        const b = snap(seek, '.rtd-wave');
        const r = { exact: !!exact, change: diff(a, b), window: player.getWindowAudio()?.buffer.duration };
        player.dispose();
        return r;
    });
    expect(after.exact).toBe(true);
    expect(after.window).toBeGreaterThan(5);
    expect(after.change).toBeGreaterThan(0.01);
});

test('spectrogram draws before any segment arrives and refines from decoded segments after zoom', async ({ page }) => {
    const gate = await gateSegments(page);
    const overview = await page.evaluate(async () => {
        const { player, seek } = mk({}, { display: 'spectrogram' });
        window.p = player; window.pSeek = seek;
        const t0 = performance.now();
        await player.load({ manifest: `${longBase}/stereo70/manifest.json` });
        await until(() => player.getState().prepared?.spectrogram);
        const at = await until(() => {
            const c = seek.querySelector('.rtd-spectrogram');
            if (!c?.width) return false;
            // Anything brighter than the dark background.
            const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 200) return performance.now();
            return false;
        });
        zoomIn(seek, 16); // well past the overview's 85 ms columns
        await h.sleep(500);
        return { firstDrawMs: at - t0, fetched: player.getStreamStats().fetches, zoomedOverview: snap(seek, '.rtd-spectrogram') };
    });
    expect(overview.firstDrawMs).toBeLessThan(3000);
    expect(overview.fetched).toBe(0);
    gate.release();
    const refined = await page.evaluate(async (zoomedOverview) => {
        const player = window.p, seek = window.pSeek;
        await until(() => player.getWindowAudio());
        await h.sleep(800);
        const r = { change: diff(zoomedOverview, snap(seek, '.rtd-spectrogram')) };
        player.dispose();
        return r;
    }, overview.zoomedOverview);
    expect(refined.change).toBeGreaterThan(0.02);
});

test('segment boundaries and a loop across one are sample-exact (OfflineAudioContext)', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const base = `${longBase}/mono30`;
        const manifest = await (await fetch(`${base}/manifest.json`)).json();
        const ref = h.format.parseWavFile(await (await fetch(`${longBase}/mono30.wav`)).arrayBuffer()).channels[0];
        const sr = manifest.sampleRate;
        const segs = (await h.preparedSegments(base, manifest)).map((planes) => {
            const b = new AudioBuffer({ length: planes[0].length, sampleRate: sr, numberOfChannels: 1 });
            b.copyToChannel(planes[0], 0);
            return b;
        });
        const render = async (frames, setup) => {
            const ctx = new OfflineAudioContext(1, frames, sr);
            const s = new h.internals.SegmentScheduler(ctx, ctx.destination, manifest.segments.list, sr);
            setup(s);
            s.pump(frames / sr, (i) => segs[i]);
            return (await ctx.startRendering()).getChannelData(0);
        };
        const from = 2 * sr + 12345;
        const n = 8 * sr;
        const out = await render(n, (s) => s.start(from, 0));
        let maxErr = 0;
        for (let i = 0; i < n; i += 1) maxErr = Math.max(maxErr, Math.abs(out[i] - ref[from + i]));
        const a = Math.round(5.5 * sr), b = Math.round(6.75 * sr);
        const m = (b - a) * 3 + 1000;
        const loopOut = await render(m, (s) => { s.setLoop({ start: a, end: b }); s.start(a, 0); });
        let loopErr = 0;
        for (let i = 0; i < m; i += 1) loopErr = Math.max(loopErr, Math.abs(loopOut[i] - ref[a + (i % (b - a))]));
        return { maxErr, loopErr };
    });
    expect(result.maxErr).toBeLessThan(1e-6);
    expect(result.loopErr).toBeLessThan(1e-6);
});

for (const codec of ['mp3', 'opus', 'flac']) {
    test(`a ${codec} source: segments are Range requests of the file, decoded in a worker to the decoder's samples`, async ({ page }) => {
        const ranges = [];
        page.on('request', (req) => { if (req.url().endsWith(`/${codec}clip/source.${codec}`)) ranges.push(req.headers().range ?? ''); });
        const r = await page.evaluate(async (codec) => {
            const { player } = mk();
            await player.load({ manifest: `${longBase}/${codec}clip/manifest.json` });
            const w = await until(() => player.getWindowAudio(), 10000);
            // The decoder's samples (prepare's built-in decoder, the whole file), planar float32.
            const ref = new Float32Array(await (await fetch(`${longBase}/${codec}clip.f32`)).arrayBuffer());
            const total = ref.length / w.buffer.numberOfChannels;
            let worst = 0;
            for (let c = 0; c < w.buffer.numberOfChannels; c += 1) {
                const x = w.buffer.getChannelData(c);
                for (let i = 0; i < x.length; i += 1) worst = Math.max(worst, Math.abs(x[i] - ref[c * total + w.startFrame + i]));
            }
            const out = { worst, frames: w.buffer.length, total, rate: w.sampleRate, fetches: player.getStreamStats().fetches };
            player.dispose();
            return out;
        }, codec);
        expect(r.frames).toBeGreaterThan(r.total / 2);
        expect(r.rate).toBe(codec === 'opus' ? 48000 : 44100);
        // MP3 and FLAC: the same samples; Opus: within float rounding (a run starts with a fresh decoder).
        expect(r.worst).toBeLessThan(codec === 'opus' ? 1e-6 : 1e-12);
        expect(ranges.length).toBeGreaterThan(1);
        expect(ranges.every((h) => /^bytes=\d+-\d+$/.test(h))).toBe(true);
    });
}

test('decoded audio stays within the cache cap while seeking around', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { player } = mk({ segmented: { cacheSeconds: 12, prefetchSegments: 3 } });
        await player.play({ manifest: `${longBase}/mono30/manifest.json` });
        for (const t of [20, 3, 27, 11, 0.5, 15, 24]) { await player.seek(t); await h.sleep(250); }
        await h.sleep(1500);
        const s = player.getStreamStats();
        player.dispose();
        return s;
    });
    expect(result.capSeconds).toBeCloseTo(12, 5);
    expect(result.peakCachedBytes).toBeLessThanOrEqual(result.maxBytes);
    expect(result.cachedSeconds).toBeLessThanOrEqual(12);
    expect(result.evictions).toBeGreaterThan(0);
});

// ---- the same transport / loop / seek / FX suite on both sources ----------------------

for (const kind of ['buffer', 'segmented']) {
    test(`${kind} source: play, seek, loop across a boundary, pause/resume, FX, stop`, async ({ page }) => {
        const result = await page.evaluate(async (kind) => {
            const { player } = mk({ stretcher: undefined });
            const clip = kind === 'buffer' ? { src: `${longBase}/mono30.wav` } : { manifest: `${longBase}/mono30/manifest.json` };
            const t0 = performance.now();
            await player.play(clip);
            const audioMs = (await until(() => h.rms(player) > 0.02 && performance.now())) - t0;
            await until(() => player.getState().capabilities.canPreservePitch);
            const s0 = player.getState();
            await player.seek(20.4);
            await h.sleep(300);
            const afterSeek = player.getCurrentTime();
            // Behind the playhead: playback jumps to the loop's start and stays inside it.
            player.setLoop({ start: 5.6, end: 6.4 });
            const inLoop = [];
            for (let i = 0; i < 40; i += 1) { await h.sleep(40); inLoop.push(player.getCurrentTime()); }
            const loop = player.getState().loop;
            player.setLoop(null);
            const loud = h.rms(player);
            player.setOutputGain(-24);
            await h.sleep(250);
            const quiet = h.rms(player);
            player.setOutputGain(0);
            await player.pause();
            const paused = player.getCurrentTime();
            await h.sleep(200);
            const stillPaused = player.getCurrentTime();
            await player.play();
            await h.sleep(200);
            const resumed = player.getCurrentTime();
            player.stop();
            const r = {
                kind: s0.sourceKind, preserve: s0.capabilities.canPreservePitch, audioMs, afterSeek,
                loopMin: Math.min(...inLoop.slice(10)), loopMax: Math.max(...inLoop.slice(10)), loop,
                loud, quiet, paused, stillPaused, resumed, stopped: player.getState().isPlaying, time: player.getCurrentTime(),
            };
            player.dispose();
            return r;
        }, kind);
        expect(result.kind).toBe(kind);
        // Both kinds stretch in realtime in the engine.
        expect(result.preserve).toBe(true);
        expect(result.audioMs).toBeLessThan(3000);
        expect(result.afterSeek).toBeGreaterThan(20.4);
        expect(result.afterSeek).toBeLessThan(21.2);
        expect(result.loopMin).toBeGreaterThanOrEqual(result.loop.start - 0.02);
        expect(result.loopMax).toBeLessThanOrEqual(result.loop.end + 0.02);
        expect(result.quiet).toBeLessThan(result.loud * 0.2);
        expect(Math.abs(result.stillPaused - result.paused)).toBeLessThan(0.01);
        expect(result.resumed).toBeGreaterThan(result.paused + 0.05);
        expect(result.stopped).toBe(false);
        expect(result.time).toBe(0);
    });
}

test('one player switches between a whole clip and a prepared clip; realtime speed on segmented', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { player, seek } = mk({ stretcher: undefined });
        await player.play({ manifest: `${longBase}/stereo70/manifest.json` });
        await h.sleep(200);
        await until(() => player.getState().capabilities.canPreservePitch);
        const seg = { kind: player.getState().sourceKind, stretch: player.stretchAvailable, caps: player.getState().capabilities };
        await player.setSpeed(2);
        const t0 = player.getCurrentTime();
        await h.sleep(500);
        const advanced = player.getCurrentTime() - t0;
        await player.play({ src: `${longBase}/mono30.wav` });
        await until(() => player.getState().buffer && ink(seek, '.rtd-wave') > 0);
        const s = player.getState();
        const buf = { kind: s.sourceKind, caps: s.capabilities, duration: s.duration, prepared: s.prepared };
        await player.play({ manifest: `${longBase}/mono30/manifest.json` });
        await h.sleep(300);
        const back = { kind: player.getState().sourceKind, playing: player.getState().isPlaying, rms: h.rms(player) };
        player.dispose();
        return { seg, advanced, buf, back };
    });
    expect(result.seg.kind).toBe('segmented');
    expect(result.seg.stretch).toBe(true); // realtime stretch in the engine
    expect(result.seg.caps.canPreservePitch).toBe(true);
    expect(result.seg.caps.canMixStemB).toBe(false);
    expect(result.advanced).toBeGreaterThan(0.8);
    expect(result.advanced).toBeLessThan(1.3);
    expect(result.buf.kind).toBe('buffer');
    expect(result.buf.caps.canPreservePitch).toBe(true);
    expect(result.buf.duration).toBeCloseTo(30, 2);
    expect(result.buf.prepared).toBeNull();
    expect(result.back.kind).toBe('segmented');
    expect(result.back.playing).toBe(true);
    expect(result.back.rms).toBeGreaterThan(0.02);
});

for (const realtime of [true, false]) {
    test(`React <AudioPlayer> card plays a manifest; at 1.5x the pitch note shows only without realtime stretch (${realtime})`, async ({ page }) => {
        await page.evaluate((args) => h.mountCard({ manifest: `${args.base}/stereo70/manifest.json` }, { stretcher: args.realtime ? 'realtime' : 'native' }), { base: BASE, realtime });
        await page.waitForFunction(() => window.cardPlayer?.getState().duration > 0);
        await expect.poll(() => page.evaluate(() => ink(document.querySelector('.rtd'), '.rtd-wave'))).toBeGreaterThan(0);
        await page.locator('.rtd-play').first().click();
        await expect.poll(() => page.evaluate(() => window.cardPlayer.getState().isPlaying)).toBe(true);
        if (realtime) await expect.poll(() => page.evaluate(() => window.cardPlayer.getState().capabilities.canPreservePitch)).toBe(true);
        expect(await page.locator('.rtd-pitch-note').count()).toBe(0);
        await page.locator('.rtd-seg-item', { hasText: '1.5' }).click();
        await expect.poll(() => page.evaluate(() => window.cardPlayer.getState().processing.speed)).toBe(1.5);
        if (realtime) {
            await page.waitForTimeout(200);
            expect(await page.locator('.rtd-pitch-note').count()).toBe(0);
        } else {
            await expect(page.locator('.rtd-pitch-note')).toBeVisible();
            expect(await page.locator('[data-pitch-shift="on"]').count()).toBe(1);
        }
    });
}
