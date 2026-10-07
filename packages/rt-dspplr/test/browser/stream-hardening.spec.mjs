// Prepared clips against hosts, servers and manifests that misbehave: a resume
// raced by a pause or a seek while the clip is set up, and a loop set then;
// servers that ignore Range requests or serve another file; manifests that
// name other origins or schemes, or that a refresh replaces with another
// recording; a source that decodes to another rate than its manifest says;
// loads superseded while their overview files are on the way. Fixtures from
// long-fixtures.mjs: mono30 (30 s mono, 3 s segments), stereo70 (70 s stereo,
// 10 s segments), mp3clip (2 s, 44.1 kHz).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const BASE = '/node_modules/.cache/rtd-long';
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules/.cache/rtd-long');
const readManifest = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'manifest.json'), 'utf8'));

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    await page.evaluate((base) => {
        window.longBase = base;
        window.until = async (fn, timeout = 8000) => {
            const t0 = performance.now();
            while (performance.now() - t0 < timeout) { const v = fn(); if (v) return v; await h.sleep(10); }
            return null;
        };
        window.mk = (options = {}) => {
            const ui = document.body.appendChild(document.createElement('div'));
            ui.style.width = '800px';
            const seek = ui.appendChild(document.createElement('div'));
            seek.style.height = '100px';
            const player = h.createAudioPlayer({ element: ui, prewarmSpeeds: false, stretcher: 'native', processing: { highPassHz: 0, compression: 0 }, ...options });
            h.createTimeline(seek, player);
            return { player };
        };
        /** Loudest analyser reading over `ms` (0 = silence). */
        window.loudest = async (player, ms = 400) => {
            let peak = 0;
            for (let t = 0; t < ms; t += 25) { peak = Math.max(peak, h.rms(player)); await h.sleep(25); }
            return peak;
        };
        /** Every fetch() the page makes: its URL, the signal and the headers it was given. */
        window.fetchLog = [];
        const fetchNative = window.fetch.bind(window);
        window.fetch = (input, init = {}) => {
            window.fetchLog.push({ url: String(input instanceof Request ? input.url : input), signal: init.signal ?? null, headers: new Headers(init.headers), credentials: init.credentials ?? null });
            return fetchNative(input, init);
        };
    }, BASE);
});

// ---- a resume raced by a pause or a seek ------------------------------------------------

test('resume() then pause() in the same tick on a loaded clip stays paused', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.load({ manifest: `${longBase}/mono30/manifest.json` });
        await until(() => player.getState().capabilities.canPreservePitch, 3000);
        void player.play();
        void player.pause();
        await h.sleep(150);
        const level = await loudest(player, 800);
        const s = player.getState();
        player.dispose();
        return { isPlaying: s.isPlaying, buffering: s.buffering, level };
    });
    expect(r.isPlaying).toBe(false);
    expect(r.buffering).toBe(false);
    expect(r.level).toBeLessThan(0.001);
});

test('resume() while the clip is set up, then pause() before it starts: stays paused', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player } = mk();
        const seen = { resumedDuringSetup: false, pausedBeforeStart: false };
        // The manifest is in (status 'ready') but the engine is still being made: resume now.
        const off = player.subscribe(() => {
            const s = player.getState();
            if (seen.resumedDuringSetup || s.status !== 'ready' || !s.manifest) return;
            seen.resumedDuringSetup = true;
            void player.play();
        });
        // 'load': set up, the resume not started yet (it waits for the setup): pause now.
        player.on('load', () => {
            seen.pausedBeforeStart = seen.resumedDuringSetup;
            void player.pause();
        });
        await player.load({ manifest: `${longBase}/mono30/manifest.json` });
        off();
        await h.sleep(200);
        const level = await loudest(player, 1000);
        const s = player.getState();
        player.dispose();
        return { ...seen, isPlaying: s.isPlaying, level };
    });
    expect(r.resumedDuringSetup).toBe(true);
    expect(r.pausedBeforeStart).toBe(true);
    expect(r.isPlaying).toBe(false);
    expect(r.level).toBeLessThan(0.001);
});

test('resume() while the clip is set up, then seek(): playback starts at the seek target', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player } = mk();
        let resumed = false;
        const off = player.subscribe(() => {
            const s = player.getState();
            if (resumed || s.status !== 'ready' || !s.manifest) return;
            resumed = true;
            void player.play();
        });
        player.on('load', () => { void player.seek(1.5); });
        await player.load({ manifest: `${longBase}/mono30/manifest.json` });
        off();
        const playing = await until(() => player.getState().isPlaying && h.rms(player) > 0.02, 5000);
        const s = player.getState();
        const r = { resumed, playing: !!playing, startPoint: s.playbackStartPoint, time: player.getCurrentTime() };
        player.dispose();
        return r;
    });
    expect(r.resumed).toBe(true);
    expect(r.playing).toBe(true);
    expect(r.startPoint).toBeCloseTo(1.5, 3);
    expect(r.time).toBeGreaterThanOrEqual(1.49);
    expect(r.time).toBeLessThan(3);
});

test('a loop set while a prepared clip is set up is in place once it plays', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player } = mk();
        let set = false;
        // Before the manifest is in: the loop goes into the state only, for now.
        const off = player.subscribe(() => {
            if (set || player.getState().status !== 'loading') return;
            set = true;
            player.setLoop({ start: 0.5, end: 1.25 });
        });
        const started = await player.play({ manifest: `${longBase}/mono30/manifest.json` });
        off();
        await until(() => player.getState().isPlaying && h.rms(player) > 0.02, 5000);
        // Into the loop from 0 and round it: still inside it 1.6 s on.
        await h.sleep(1600);
        const s = player.getState();
        const r = { set, started, loop: s.loop, time: player.getCurrentTime(), playing: s.isPlaying, rms: h.rms(player) };
        player.dispose();
        return r;
    });
    expect(r.set).toBe(true);
    expect(r.started).toBe(true);
    expect(r.playing).toBe(true);
    expect(r.loop.start).toBeCloseTo(0.5, 2);
    expect(r.loop.end).toBeCloseTo(1.25, 2);
    expect(r.time).toBeGreaterThanOrEqual(0.49);
    expect(r.time).toBeLessThan(1.26);
    expect(r.rms).toBeGreaterThan(0.02);
});

// ---- servers -----------------------------------------------------------------------------

test('a server that ignores Range requests: a small source is downloaded once and plays', async ({ page }) => {
    const file = path.join(FIXTURES, 'mono30', 'source.wav');
    let hits = 0;
    await page.route('**/mono30/source.wav', (route) => {
        hits += 1;
        return route.fulfill({ status: 200, path: file, headers: { 'content-type': 'audio/wav' } });
    });
    const r = await page.evaluate(async () => {
        const { player } = mk();
        let error = null;
        player.on('error', (e) => { error = String(e?.message ?? e); });
        await player.play({ manifest: `${longBase}/mono30/manifest.json` });
        const first = !!(await until(() => h.rms(player) > 0.02, 5000));
        await player.seek(20.2);
        const far = !!(await until(() => h.rms(player) > 0.02 && player.getCurrentTime() > 20.3, 4000));
        await player.seek(8.5);
        const back = !!(await until(() => h.rms(player) > 0.02 && player.getCurrentTime() > 8.6 && player.getCurrentTime() < 12, 4000));
        const r = { first, far, back, error, stats: player.getStreamStats() };
        player.dispose();
        return r;
    });
    expect(r.error).toBeNull();
    expect(r.first).toBe(true);
    expect(r.far).toBe(true);
    expect(r.back).toBe(true);
    // At most the first wave of parallel requests (3); one of them brings the file.
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThanOrEqual(3);
    expect(r.stats.fetchedBytes).toBe(fs.statSync(file).size);
});

test('a server that ignores Range requests on a source over 64 MB: a clear error at once, no retries', async ({ page }) => {
    let hits = 0;
    let requestsAfter = 0;
    await page.route('**/stereo70/source.wav', (route) => {
        hits += 1;
        // Only the declared length matters: the player reads it from the headers and cancels the
        // body unread (route.fulfill keeps an explicit content-length).
        return route.fulfill({ status: 200, body: Buffer.alloc(1024), headers: { 'content-type': 'audio/wav', 'content-length': String(64 * 1024 * 1024 + 1) } });
    });
    const r = await page.evaluate(async () => {
        const { player } = mk();
        const errors = [];
        player.on('error', (e) => { errors.push(String(e?.message ?? e)); });
        await player.play({ manifest: `${longBase}/stereo70/manifest.json` });
        await until(() => errors.length > 0, 8000);
        await h.sleep(2500); // a retry would come within this
        const s = player.getState();
        const r = { first: [...errors], isPlaying: s.isPlaying, buffering: s.buffering, stateError: s.error?.message ?? null };
        window.p = player;
        return r;
    });
    const hitsFirst = hits;
    // Play again: it fails with the same error, without another request.
    const again = await page.evaluate(async () => {
        const player = window.p;
        const errors = [];
        player.on('error', (e) => { errors.push(String(e?.message ?? e)); });
        await player.play();
        await h.sleep(300);
        const out = { errors, isPlaying: player.getState().isPlaying };
        player.dispose();
        return out;
    });
    requestsAfter = hits - hitsFirst;
    expect(r.first.length).toBe(1);
    expect(r.first[0]).toMatch(/^The server ignores HTTP Range requests: .*\/stereo70\/source\.wav/);
    expect(r.stateError).toBe(r.first[0]);
    expect(r.isPlaying).toBe(false);
    expect(r.buffering).toBe(false);
    expect(hitsFirst).toBeGreaterThan(0);
    expect(hitsFirst).toBeLessThanOrEqual(3);
    expect(again.isPlaying).toBe(false);
    expect(again.errors).toEqual([r.first[0]]);
    expect(requestsAfter).toBe(0);
});

test('a source that changed size (Content-Range total) fails with a clear error, not retried', async ({ page }) => {
    let hits = 0;
    await page.route('**/mono30/source.wav', async (route) => {
        hits += 1;
        const response = await route.fetch();
        const headers = response.headers();
        headers['content-range'] = headers['content-range'].replace(/\/(\d+)$/, (_, n) => `/${Number(n) + 10}`);
        return route.fulfill({ response, headers });
    });
    const r = await page.evaluate(async () => {
        const { player } = mk();
        const errors = [];
        player.on('error', (e) => { errors.push(String(e?.message ?? e)); });
        await player.play({ manifest: `${longBase}/mono30/manifest.json` });
        await until(() => errors.length > 0, 8000);
        await h.sleep(2000);
        const s = player.getState();
        player.dispose();
        return { errors, isPlaying: s.isPlaying };
    });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toMatch(/mono30\/source\.wav is \d+ bytes, its manifest says \d+: the file changed/);
    expect(r.isPlaying).toBe(false);
    expect(hits).toBeLessThanOrEqual(3);
});

test('a source that decodes to another rate than its manifest says is refused, not played at the wrong speed', async ({ page }) => {
    const m = readManifest('mp3clip');
    // The file is 44.1 kHz; this manifest claims 48 kHz throughout (valid as a manifest).
    m.sampleRate = 48000;
    m.sourceSampleRate = 48000;
    m.duration = m.frames / 48000;
    m.segments.source.sampleRate = 48000;
    await page.route('**/mp3clip/manifest.json', (route) => route.fulfill({ json: m }));
    const r = await page.evaluate(async () => {
        const { player } = mk();
        const errors = [];
        player.on('error', (e) => { errors.push(String(e?.message ?? e)); });
        await player.play({ manifest: `${longBase}/mp3clip/manifest.json` });
        await until(() => errors.length > 0, 8000);
        const s = player.getState();
        player.dispose();
        return { errors, isPlaying: s.isPlaying };
    });
    expect(r.errors[0]).toMatch(/the mp3 source decodes to 44100 Hz, 2 channel\(s\); its manifest says 48000 Hz, 2/);
    expect(r.isPlaying).toBe(false);
});

// ---- what a manifest may name -------------------------------------------------------------

test('fetchOptions headers go to the manifest\'s origin only, unless the host lists another; other origins still serve files', async ({ page }) => {
    // localhost is another origin than the page's 127.0.0.1: the bands file comes from "a CDN".
    const m = readManifest('mono30');
    const cdnBands = 'http://localhost:4179/node_modules/.cache/rtd-long/mono30/bands.bin';
    m.bands.url = cdnBands;
    await page.route('**/mono30/manifest.json', (route) => route.fulfill({ json: m }));
    // Playwright answers the CORS preflight of a routed request itself; the response allows the
    // page's origin with credentials, so both the plain and the credentialed request succeed.
    await page.route('http://localhost:4179/**', (route) => route.fulfill({
        status: 200,
        path: path.join(FIXTURES, 'mono30', 'bands.bin'),
        headers: { 'access-control-allow-origin': 'http://127.0.0.1:4179', 'access-control-allow-credentials': 'true' },
    }));
    const r = await page.evaluate(async (cdnBands) => {
        const fetchOptions = { headers: { 'X-Test-Token': 'secret' }, credentials: 'include' };
        const out = {};
        for (const [label, extra] of [['default', {}], ['listed', { fetchOptionsOrigins: ['http://localhost:4179'] }]]) {
            fetchLog.length = 0;
            const { player } = mk({ fetchOptions, ...extra });
            await player.play({ manifest: `${longBase}/mono30/manifest.json` });
            await until(() => h.rms(player) > 0.02, 5000);
            const bandsIn = !!(await until(() => player.getState().prepared?.bands, 4000));
            const pick = (re) => fetchLog.filter((e) => re.test(e.url)).map((e) => ({ token: e.headers.get('x-test-token'), credentials: e.credentials }));
            out[label] = { bandsIn, manifest: pick(/mono30\/manifest\.json/), source: pick(/mono30\/source\.wav/), peaks: pick(/mono30\/peaks\.bin/), cdn: fetchLog.filter((e) => e.url === cdnBands).map((e) => ({ token: e.headers.get('x-test-token'), credentials: e.credentials })) };
            player.dispose();
        }
        return out;
    }, cdnBands);
    const d = r.default;
    for (const own of [d.manifest, d.source, d.peaks]) {
        expect(own.length).toBeGreaterThan(0);
        for (const e of own) expect(e).toEqual({ token: 'secret', credentials: 'include' });
    }
    expect(d.cdn.length).toBe(1);
    expect(d.cdn[0].token).toBeNull();
    expect(d.cdn[0].credentials).not.toBe('include');
    expect(d.bandsIn).toBe(true);
    // Listed: the CDN gets them too.
    expect(r.listed.cdn.length).toBe(1);
    expect(r.listed.cdn[0]).toEqual({ token: 'secret', credentials: 'include' });
    expect(r.listed.bandsIn).toBe(true);
});

test('a manifest that names a file by a scheme other than http(s) is refused with a clear error', async ({ page }) => {
    const m = readManifest('mono30');
    m.peaks.url = 'data:application/octet-stream;base64,UlREUA==';
    await page.route('**/mono30/manifest.json', (route) => route.fulfill({ json: m }));
    const r = await page.evaluate(async () => {
        const { player } = mk();
        const ok = await player.load({ manifest: `${longBase}/mono30/manifest.json` });
        const s = player.getState();
        const r = { ok, status: s.status, error: s.error?.message ?? null, fetchedData: fetchLog.some((e) => e.url.startsWith('data:')) };
        player.dispose();
        return r;
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/peaks\.url must be an http\(s\) URL, not data:/);
    expect(r.fetchedData).toBe(false);
});

test('refreshManifest() ignores another recording behind the URL, and stems made from another A', async ({ page }) => {
    const own = readManifest('mono30');
    // A ready stem on mono30's grid (its own files stand in for the stem's).
    const stem = (aSourceId) => ({
        status: 'ready', updatedAt: new Date().toISOString(), aSourceId,
        segments: structuredClone(own.segments), peaks: structuredClone(own.peaks),
    });
    let serve = null;
    await page.route('**/mono30/manifest.json', (route) => (serve ? route.fulfill({ json: serve }) : route.continue()));
    const load = () => page.evaluate(async () => {
        const { player } = mk();
        window.p = player;
        await player.load({ manifest: `${longBase}/mono30/manifest.json` });
        return player.getState().manifest.id;
    });
    const refresh = () => page.evaluate(async () => {
        await window.p.refreshManifest();
        await h.sleep(100);
        const s = window.p.getState();
        return { id: s.manifest.id, revision: s.manifest.revision ?? 1, statusB: s.statusB, stems: s.capabilities.stems.map((x) => x.key) };
    });
    const id = await load();
    // Another recording (pairEq's manifest, a higher revision) at this URL: ignored.
    serve = { ...readManifest('pairEq'), revision: 9 };
    const other = await refresh();
    expect(other).toEqual({ id, revision: 1, statusB: 'unavailable', stems: [] });
    // The same recording, with a stem made from another A: the revision is taken, the stem is not.
    serve = { ...own, revision: 2, stems: { b: stem('sha256:another') } };
    const stale = await refresh();
    expect(stale).toEqual({ id, revision: 2, statusB: 'unavailable', stems: [] });
    // The same with a stem made from this A: attached.
    serve = { ...own, revision: 3, stems: { b: stem(own.id) } };
    const fresh = await refresh();
    expect(fresh).toEqual({ id, revision: 3, statusB: 'ready', stems: ['b'] });
    await page.evaluate(() => window.p.dispose());
});

// ---- superseded loads --------------------------------------------------------------------

test('a new load and dispose() abort the overview fetches still on the way', async ({ page }) => {
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    // Overview files of both clips hang until the end of the test.
    await page.route(/\/(mono30|stereo70)\/(peaks|bands|spectrogram)\.bin$/, async (route) => {
        await gate;
        await route.continue().catch(() => {});
    });
    const r = await page.evaluate(async () => {
        const overview = (clip) => fetchLog.filter((e) => new RegExp(`/${clip}/(peaks|bands|spectrogram)\\.bin$`).test(e.url));
        const { player } = mk();
        await player.load({ manifest: `${longBase}/mono30/manifest.json` });
        const first = overview('mono30');
        const pendingBefore = first.map((e) => !!e.signal && !e.signal.aborted);
        await player.load({ manifest: `${longBase}/stereo70/manifest.json` });
        const afterNewLoad = first.map((e) => e.signal.aborted);
        const second = overview('stereo70');
        const secondPending = second.map((e) => !!e.signal && !e.signal.aborted);
        player.dispose();
        return { pendingBefore, afterNewLoad, secondPending, afterDispose: second.map((e) => e.signal.aborted) };
    });
    open();
    expect(r.pendingBefore.length).toBeGreaterThanOrEqual(3);
    expect(r.pendingBefore.every(Boolean)).toBe(true);
    expect(r.afterNewLoad.every(Boolean)).toBe(true);
    expect(r.secondPending.length).toBeGreaterThanOrEqual(3);
    expect(r.secondPending.every(Boolean)).toBe(true);
    expect(r.afterDispose.every(Boolean)).toBe(true);
});
