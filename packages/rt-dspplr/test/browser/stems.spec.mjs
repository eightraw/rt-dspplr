// Stem B on prepared clips. Manifests are published with B made in the same
// prepareAudio call (v3, stems.b), and the player reads them as published.
// Covered: the mix law keeps a correlated pair's level; B plays at its own
// level (no hidden trim); B is fetched only when the mix asks for it; B present
// means the knob is on, B absent means it is off, with no 'processing' UI;
// nothing polls by default; refreshManifest() picks up a B that a host
// publishes later; the waveform and spectrogram show the blend.
// Fixtures from long-fixtures.mjs: pairEq (B = A, 37 ms late), pairQuiet
// (B = A, 37 ms late, -6 dB), both made in one prepare call; pairHot (A only).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { loadPrepare } from './long-fixtures.mjs';

const BASE = '/node_modules/.cache/rtd-long';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(root, 'node_modules', '.cache', 'rtd-long');

/**
 * A fixture's manifest, served in its place, with the source of A (`a`) or of its stem (`b`)
 * sent at that many KB/s (test/browser/vite.config.mjs, /__slow/): parts of a segment arrive
 * over a second or more, as on a slow network.
 */
async function slowed(page, name, { a, b } = {}) {
    const m = JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'manifest.json'), 'utf8'));
    if (a) m.segments.source.url = `/__slow/${a}${BASE}/${name}/${m.segments.source.url}`;
    if (b) m.stems.b.segments.source.url = `/__slow/${b}${BASE}/${name}/${m.stems.b.segments.source.url}`;
    await page.route(`**${BASE}/${name}/manifest.json`, (route) => route.fulfill({ json: m }));
}

/** In the page: every fetch's URL, Range header and start time, in window.fetches. */
async function recordFetches(page) {
    await page.evaluate(() => {
        window.fetches = [];
        const plain = window.fetch.bind(window);
        window.fetch = (input, init) => {
            const url = typeof input === 'string' ? input : input.url;
            const range = new Headers(init?.headers ?? (typeof input === 'string' ? undefined : input.headers)).get('range');
            window.fetches.push({ url, range, at: performance.now() });
            return plain(input, init);
        };
    });
}

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
        window.mk = (options = {}, timeline = {}) => {
            const ui = document.body.appendChild(document.createElement('div'));
            ui.style.width = '800px';
            const seek = ui.appendChild(document.createElement('div'));
            seek.style.height = '100px';
            const player = h.createAudioPlayer({ element: ui, prewarmSpeeds: false, stretcher: 'native', processing: { highPassHz: 0, compression: 0 }, ...options });
            h.createTimeline(seek, player, timeline);
            return { player, seek, ui };
        };
        /** Output level in dB, averaged over ~1 s of the analyser. */
        window.levelDb = async (player) => {
            let sum = 0;
            for (let i = 0; i < 40; i += 1) { sum += h.rms(player) ** 2; await h.sleep(25); }
            return 10 * Math.log10(sum / 40);
        };
        window.snap = (root, selector) => {
            const out = [];
            for (const c of root.querySelectorAll(selector)) {
                if (!c.width) continue;
                const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                for (let i = 0; i < px.length; i += 1) out.push(px[i]);
            }
            return out;
        };
        /** The spectrogram's background (theme) as [r, g, b]; a pixel's ink is its distance from it (cleared pixels: none). */
        window.spectrogramInk = (canvas) => {
            const style = getComputedStyle(canvas);
            const stops = h.colormapStops(style.getPropertyValue('--rtd-spectrogram-colormap').trim() || null);
            const hex = (stops ? stops[0] : style.getPropertyValue('--rtd-spectrogram-bg').trim() || '#131315').replace('#', '');
            const n = parseInt(hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex, 16);
            const bg = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
            return (px, i) => (px[i + 3] === 0 ? 0 : Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]));
        };
        /** Mean ink of the matching canvases (distance from the spectrogram's background). */
        window.brightness = (root, selector) => {
            const canvas = root.querySelector(selector);
            const ink = canvas ? spectrogramInk(canvas) : () => 0;
            const s = snap(root, selector);
            let b = 0;
            for (let i = 0; i < s.length; i += 4) b += ink(s, i);
            return b / Math.max(1, s.length / 4);
        };
        window.diff = (a, b) => { if (a.length !== b.length || !a.length) return 1; let d = 0; for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > 8) d += 1; return d / a.length; };
    }, BASE);
});

test('a correlated equal-level B: the crossfade law keeps the level at every knob position', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.play({ manifest: `${longBase}/pairEq/manifest.json` });
        await h.sleep(500);
        const s = player.getState();
        const a = await levelDb(player);
        player.setMix(0.5);
        await h.sleep(700);
        const half = await levelDb(player);
        player.setMix(1);
        await h.sleep(400);
        const full = await levelDb(player);
        const stem = s.manifest.stems.b;
        const out = { law: s.mixLaw, status: s.statusB, can: s.capabilities.canMixStemB, a, half, full, fetchesB: player.getStreamStats().fetchesB, offsetMs: stem.alignment.offsetMs, confidence: stem.alignment.confidence, rho: stem.correlation.global };
        player.dispose();
        // The same pair with an equal-power law forced: +3 dB at the middle (why it is not the default here).
        const { player: p2 } = mk({ mixLaw: 'equal-power' });
        await p2.play({ manifest: `${longBase}/pairEq/manifest.json` });
        await h.sleep(500);
        const a2 = await levelDb(p2);
        p2.setMix(0.5);
        await h.sleep(700);
        out.equalPowerBump = (await levelDb(p2)) - a2;
        p2.dispose();
        return out;
    });
    console.log('stem B eq:', JSON.stringify(r));
    expect(r.law).toBe('crossfade');
    expect(r.status).toBe('ready');
    expect(r.can).toBe(true);
    expect(Math.abs(r.offsetMs - 37)).toBeLessThan(0.1);
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(Math.abs(r.half - r.a)).toBeLessThan(0.5);
    expect(Math.abs(r.full - r.a)).toBeLessThan(0.5);
    expect(r.fetchesB).toBeGreaterThan(0);
    expect(r.equalPowerBump).toBeGreaterThan(2.5);
    expect(r.equalPowerBump).toBeLessThan(3.5);
});

test('a B at -6 dB plays at its own level (loudness delta is information only)', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.play({ manifest: `${longBase}/pairQuiet/manifest.json` });
        await h.sleep(500);
        const a = await levelDb(player);
        player.setMix(1);
        await h.sleep(800);
        const b = await levelDb(player);
        player.setMix(0.5);
        await h.sleep(400);
        const half = await levelDb(player);
        const stem = player.getState().manifest.stems.b;
        player.dispose();
        return { delta: b - a, half: half - a, loudnessDeltaDb: stem.loudnessDeltaDb, gainDb: stem.gainDb };
    });
    console.log('stem B -6 dB:', JSON.stringify(r));
    expect(r.gainDb).toBe(0);
    expect(Math.abs(r.loudnessDeltaDb + 6)).toBeLessThan(0.5);
    expect(Math.abs(r.delta + 6.02)).toBeLessThan(0.5);
    // Linear crossfade of a correlated pair: 0.5·A + 0.5·(A/2) = 0.75·A → -2.5 dB.
    expect(Math.abs(r.half + 2.5)).toBeLessThan(0.5);
});

test('a mix set before the first prepared clip is the mix it plays and draws at', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player, seek } = mk({}, { display: 'spectrogram' });
        // Set while no prepared clip was ever loaded (a page sets its knob, then loads).
        player.setMix(1);
        await player.play({ manifest: `${longBase}/pairQuiet/manifest.json` });
        await until(() => player.getState().prepared?.spectrogram);
        await h.sleep(800);
        const atB = await levelDb(player);
        const pictureB = snap(seek, '.rtd-spectrogram');
        player.setMix(0);
        await h.sleep(800);
        const atA = await levelDb(player);
        player.setMix(1);
        await h.sleep(400);
        const pictureAgain = snap(seek, '.rtd-spectrogram');
        player.dispose();
        return { delta: atB - atA, pictureDiff: diff(pictureB, pictureAgain) };
    });
    console.log('mix before load:', JSON.stringify(r));
    expect(Math.abs(r.delta + 6.02)).toBeLessThan(0.5);
    expect(r.pictureDiff).toBeLessThan(0.01);
});

test('play while the first segment of a WAV source is arriving starts from what is in, not once it is whole', async ({ page }) => {
    // 384 KB segments at 250 KB/s: whole after about 1.5 s. Loaded, its first segment comes
    // ahead of a play; the play comes while it is on its way.
    await slowed(page, 'pairQuiet', { a: 250 });
    await recordFetches(page);
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.load({ manifest: `${longBase}/pairQuiet/manifest.json` });
        await until(() => fetches.find((f) => f.url.includes('/__slow/')), 8000);
        await h.sleep(400);
        const t0 = performance.now();
        void player.play();
        await until(() => player.getStreamStats()?.startLatencyMs, 8000);
        const startedAt = performance.now() - t0;
        // The first segment whole: the first one the store finishes (the others give way to it).
        await until(() => player.getStreamStats()?.fetches >= 1, 8000);
        const wholeAt = performance.now() - t0;
        player.dispose();
        return { startedAt, wholeAt };
    });
    console.log('play while A arrives:', JSON.stringify(r));
    expect(r.startedAt).toBeLessThan(r.wholeAt - 400);
});

test('a seek while other segments are on their way fetches its own at once; the others give way and carry on from where they were', async ({ page }) => {
    // 384 KB segments at 200 KB/s. The timeline's close-up of the whole 20 s clip asks for every
    // segment, three at a time: the seek's must not wait for a free one, nor share the link.
    await slowed(page, 'pairQuiet', { a: 200 });
    await recordFetches(page);
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.play({ manifest: `${longBase}/pairQuiet/manifest.json` });
        await until(() => player.getStreamStats()?.startLatencyMs, 8000);
        await h.sleep(200);
        const m = player.getState().manifest;
        const from = fetches.length;
        const t0 = performance.now();
        await player.seek(14.5);
        await until(() => player.getStreamStats().seekLatencies.length > 0, 8000);
        const seekMs = player.getStreamStats().seekLatencies.at(-1);
        await h.sleep(3000);
        const own = m.segments.list[3];
        const begin = (f) => Number(/bytes=(\d+)-/.exec(f.range)[1]);
        const after = fetches.slice(from).filter((f) => f.url.includes('/__slow/'));
        // The seek's: from inside segment 3 (an entry near 14.5 s), to its end.
        const first = after.find((f) => begin(f) >= own.range[0] && begin(f) < own.range[1]);
        const entries = new Set(after.filter((f) => f !== first).map(begin));
        player.dispose();
        return {
            seekMs,
            askedAfterMs: first ? first.at - t0 : null,
            fromInside: first ? begin(first) > own.range[0] : false,
            // Fetches that carry on (from no segment's start, and not the seek's).
            resumed: after.filter((f) => f !== first && !m.segments.list.some((seg) => seg.range[0] === begin(f))).length,
            entries: entries.size,
        };
    });
    console.log('seek while others load:', JSON.stringify(r));
    // Asked for at once, not once one of the three in flight is whole (about 2 s here), and from
    // an entry near 14.5 s, not from the segment's start at 12 s: about 0.75 s of audio to wait
    // for instead of 3. The others let go of their requests and later ask for the rest.
    expect(r.askedAfterMs).toBeLessThan(150);
    expect(r.fromInside).toBe(true);
    expect(r.seekMs).toBeLessThan(1000);
    expect(r.resumed).toBeGreaterThan(0);
});

test('a stem being prefetched plays from what has arrived when the knob moves, before its segment is whole', async ({ page }) => {
    // The stem's 384 KB segment at the playhead at 200 KB/s: whole after about 1.9 s.
    await slowed(page, 'pairQuiet', { b: 200 });
    await recordFetches(page);
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.play({ manifest: `${longBase}/pairQuiet/manifest.json` });
        await until(() => fetches.find((f) => f.url.includes('/__slow/')), 8000);
        await h.sleep(600);
        const level = async () => {
            let sum = 0;
            for (let i = 0; i < 10; i += 1) { sum += h.rms(player) ** 2; await h.sleep(25); }
            return 10 * Math.log10(sum / 10);
        };
        const atA = await level();
        player.setMix(1);
        await h.sleep(150);
        const atB = await level();
        const measured = performance.now();
        const slow = () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/__slow/')).sort((x, y) => x.startTime - y.startTime)[0];
        await until(slow, 8000);
        player.dispose();
        return { delta: atB - atA, beforeWhole: slow().responseEnd - measured };
    });
    console.log('prefetched stem:', JSON.stringify(r));
    // Measured while the segment was still arriving, at the stem's level (-6 dB).
    expect(r.beforeWhole).toBeGreaterThan(0);
    expect(Math.abs(r.delta + 6.02)).toBeLessThan(1.5);
});

test('a seek near the end of a segment fetches the next one at once too: the start\'s margin reaches into it', async ({ page }) => {
    // 4 s segments at 200 KB/s; 15.8 s is 0.2 s before segment 4.
    await slowed(page, 'pairQuiet', { a: 200 });
    await recordFetches(page);
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.play({ manifest: `${longBase}/pairQuiet/manifest.json` });
        await until(() => player.getStreamStats()?.startLatencyMs, 8000);
        await h.sleep(200);
        const m = player.getState().manifest;
        const from = fetches.length;
        const t0 = performance.now();
        await player.seek(15.8);
        await until(() => player.getStreamStats().seekLatencies.length > 0, 8000);
        const seekMs = player.getStreamStats().seekLatencies.at(-1);
        const segmentOf = (f) => {
            const start = Number(/bytes=(\d+)-/.exec(f.range)[1]);
            return m.segments.list.findIndex((seg) => start >= seg.range[0] && start < seg.range[1]);
        };
        const asked = fetches.slice(from).filter((f) => f.url.includes('/__slow/')).map((f) => ({ segment: segmentOf(f), at: f.at - t0 }));
        player.dispose();
        return { seekMs, three: asked.find((a) => a.segment === 3)?.at ?? null, four: asked.find((a) => a.segment === 4)?.at ?? null };
    });
    console.log('seek near a segment end:', JSON.stringify(r));
    expect(r.three).toBeLessThan(150);
    expect(r.four).toBeLessThan(150);
    expect(r.seekMs).toBeLessThan(1000);
});

test('a seek with the knob towards the stem fetches both segments at the new playhead first, together', async ({ page }) => {
    // A's source at 200 KB/s: its 384 KB segment takes about 1.9 s, which the stem's must not wait for.
    await slowed(page, 'pairQuiet', { a: 200 });
    await recordFetches(page);
    const r = await page.evaluate(async () => {
        // No timeline: its decoded close-up of the whole 20 s clip would fetch every segment.
        const player = h.createAudioPlayer({ element: document.body.appendChild(document.createElement('div')), prewarmSpeeds: false, stretcher: 'native', segmented: { prefetchSegments: 1 } });
        player.setMix(1);
        await player.play({ manifest: `${longBase}/pairQuiet/manifest.json` });
        await until(() => player.getStreamStats()?.startLatencyMs, 8000);
        const m = player.getState().manifest;
        const from = fetches.length;
        await player.seek(14.5);
        await h.sleep(1000);
        // Each fetch by the segment its range is in (a seek fetches from an entry inside it).
        const segmentOf = (list, range) => list.findIndex((seg) => range >= seg.range[0] && range < seg.range[1]);
        const sources = fetches.slice(from).filter((f) => f.range && f.url.includes('source.wav')).map((f) => {
            const b = f.url.includes('/b/');
            const start = Number(/bytes=(\d+)-/.exec(f.range)[1]);
            return { name: `${b ? 'b' : 'a'} ${segmentOf(b ? m.stems.b.segments.list : m.segments.list, start)}`, at: f.at };
        });
        player.dispose();
        return { sources, both: ['a 3', 'b 3'] };
    });
    console.log('after the seek:', r.sources.map((s) => `${s.name} @${Math.round(s.at)}`).join(' | '));
    expect(r.sources.slice(0, 2).map((s) => s.name).sort()).toEqual(r.both.sort());
    // The stem's asked for within a moment of A's, not once A's is whole.
    expect(Math.abs(r.sources[1].at - r.sources[0].at)).toBeLessThan(500);
});

test('a seek lets go of the stem prefetch for the old playhead', async ({ page }) => {
    // The stem's first segment at 100 KB/s: still on its way when the seek comes.
    await slowed(page, 'pairQuiet', { b: 100 });
    const failed = [];
    page.on('requestfailed', (req) => { if (req.url().includes('/__slow/')) failed.push(req.headers().range); });
    await recordFetches(page);
    const r = await page.evaluate(async () => {
        const { player } = mk();
        window.player = player;
        await player.play({ manifest: `${longBase}/pairQuiet/manifest.json` });
        await until(() => fetches.find((f) => f.url.includes('/__slow/')), 8000);
        await h.sleep(300);
        await player.seek(14.5);
        await h.sleep(1500);
        const list = player.getState().manifest.stems.b.segments.list;
        const range = (seg) => `bytes=${seg.range[0]}-${seg.range[1] - 1}`;
        return { slow: fetches.filter((f) => f.url.includes('/__slow/')).map((f) => f.range), old: range(list[0]), now: range(list[3]) };
    });
    await page.waitForTimeout(200);
    const abortedBeforeDispose = [...failed];
    await page.evaluate(() => window.player.dispose());
    console.log('stem fetches:', JSON.stringify(r), 'aborted:', abortedBeforeDispose);
    expect(r.slow[0]).toBe(r.old);
    expect(abortedBeforeDispose).toContain(r.old);
    expect(r.slow).toContain(r.now);
});

test('before the knob moves only the stem\'s segment at the playhead is fetched (prefetchStem), the rest once the mix asks; none with prefetchStem: false', async ({ page }) => {
    const requests = [];
    page.on('request', (req) => { if (/\/pairEq\/b\//.test(req.url())) requests.push(req.url()); });
    const r = await page.evaluate(async () => {
        const run = async (segmented) => {
            const { player } = mk(segmented ? { segmented } : {});
            await player.play({ manifest: `${longBase}/pairEq/manifest.json` });
            await h.sleep(1500);
            const atZero = player.getStreamStats().fetchesB;
            player.setMix(0.3);
            await until(() => player.getStreamStats().fetchesB > atZero, 4000);
            const after = player.getStreamStats().fetchesB;
            player.dispose();
            return { atZero, after };
        };
        return { ahead: await run(null), lazy: await run({ prefetchStem: false }) };
    });
    // The segment under the playhead (the next too, if it crossed a boundary in those 1.5 s).
    expect(r.ahead.atZero).toBeGreaterThanOrEqual(1);
    expect(r.ahead.atZero).toBeLessThanOrEqual(2);
    expect(r.ahead.after).toBeGreaterThan(r.ahead.atZero);
    expect(r.lazy.atZero).toBe(0);
    expect(r.lazy.after).toBeGreaterThan(0);
    expect(requests.some((u) => /\/b\/r\d+\/source\./.test(u))).toBe(true);
});

test('the card reads stems as published: B in the manifest → knob on; no B → knob off, no "processing"', async ({ page }) => {
    const card = async (name) => {
        await page.goto('/test/browser/index.html');
        await page.waitForFunction(() => window.h);
        await page.evaluate((url) => h.mountCard({ manifest: url }, { stretcher: 'native', prewarmSpeeds: false }), `${BASE}/${name}/manifest.json`);
        await page.waitForFunction(() => window.cardPlayer?.getState().duration > 0);
        await page.waitForTimeout(300);
        return page.evaluate(() => ({
            status: window.cardPlayer.getState().statusB,
            can: window.cardPlayer.getState().capabilities.canMixStemB,
            disabled: document.querySelector('.rtd-mixer input')?.disabled ?? null,
            note: !!document.querySelector('[data-stem-processing]'),
            spinner: !!document.querySelector('.rtd-mixer-status .rtd-icon'),
        }));
    };
    const withB = await card('pairEq');
    expect(withB).toEqual({ status: 'ready', can: true, disabled: false, note: false, spinner: false });
    const withoutB = await card('mono30');
    expect(withoutB).toEqual({ status: 'unavailable', can: false, disabled: true, note: false, spinner: false });
});

test('refreshManifest() (explicit; nothing polls by default) attaches a B the host published later, while A plays', async ({ page }) => {
    const { attachStem } = await loadPrepare();
    const dir = path.join(FIXTURES, 'pairHot');
    await page.evaluate((base) => h.mountCard({ manifest: `${base}/pairHot/manifest.json` }, { stretcher: 'native', prewarmSpeeds: false, processing: { highPassHz: 0, compression: 0 } }), BASE);
    await page.waitForFunction(() => window.cardPlayer?.getState().duration > 0);
    const manifestFetches = [];
    page.on('request', (req) => { if (/pairHot\/manifest\.json/.test(req.url())) manifestFetches.push(req.url()); });
    await page.evaluate(async () => { await window.cardPlayer.play(); await h.sleep(300); });
    await attachStem(dir, 'b', path.join(FIXTURES, 'pairB6.wav'));
    const before = await page.evaluate(async () => {
        await h.sleep(1500); // a poller would have seen it by now
        return { status: window.cardPlayer.getState().statusB, disabled: document.querySelector('.rtd-mixer input')?.disabled ?? null };
    });
    expect(before).toEqual({ status: 'unavailable', disabled: true });
    expect(manifestFetches.length).toBe(0);
    const after = await page.evaluate(async () => {
        const player = window.cardPlayer;
        const t0 = player.getCurrentTime();
        await player.refreshManifest();
        const ready = await until(() => player.getState().statusB === 'ready', 3000);
        const a = await levelDb(player);
        player.setMix(1);
        await h.sleep(800);
        const b = await levelDb(player);
        await h.sleep(50);
        const r = { ready: !!ready, disabled: document.querySelector('.rtd-mixer input')?.disabled ?? null, playing: player.getState().isPlaying, advanced: player.getCurrentTime() - t0, delta: b - a, underruns: player.getStreamStats().underruns ?? 0 };
        player.pause();
        return r;
    });
    console.log('refreshManifest attach:', JSON.stringify(after));
    expect(after.ready).toBe(true);
    expect(after.disabled).toBe(false);
    expect(after.playing).toBe(true);
    expect(after.advanced).toBeGreaterThan(1);
    expect(after.underruns).toBe(0);
    expect(Math.abs(after.delta + 6.02)).toBeLessThan(0.7);
});

test('waveform and spectrogram show the A/B blend', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player, seek } = mk();
        const { player: p2, seek: seek2 } = mk({}, { display: 'spectrogram' });
        await player.load({ manifest: `${longBase}/pairQuiet/manifest.json` });
        await p2.load({ manifest: `${longBase}/pairQuiet/manifest.json` });
        await until(() => player.getState().prepared?.peaks && p2.getState().prepared?.spectrogram);
        await h.sleep(400);
        const wave0 = snap(seek, '.rtd-wave');
        const spec0 = brightness(seek2, '.rtd-spectrogram');
        player.setMix(1);
        p2.setMix(1);
        await until(() => player.getState().prepared?.peaksB && p2.getState().prepared?.spectrogram?.levels[0]?.b);
        await h.sleep(500);
        const wave1 = snap(seek, '.rtd-wave');
        const spec1 = brightness(seek2, '.rtd-spectrogram');
        const r = { waveChange: diff(wave0, wave1), spec0, spec1, fetched: player.getStreamStats().fetches + player.getStreamStats().fetchesB };
        player.dispose();
        p2.dispose();
        return r;
    });
    console.log('blend views:', JSON.stringify(r));
    expect(r.waveChange).toBeGreaterThan(0.01);
    expect(r.spec1).toBeLessThan(r.spec0 * 0.97);
});

// ---- named stems -----------------------------------------------------------------------------
// pairNamed: one manifest, two stems with neutral keys and labels: b (A's level) and v1 (-6 dB).

test('named stems: play({ manifest, stem }) picks the blend stem, setStem() switches it, capabilities list them', async ({ page }) => {
    const urls = [];
    page.on('request', (req) => { const m = /\/pairNamed\/(b|v1)\/r\d+\/source\./.exec(req.url()); if (m) urls.push(m[1]); });
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.play({ manifest: `${longBase}/pairNamed/manifest.json`, stem: 'v1' });
        await h.sleep(500);
        const s0 = player.getState();
        const a = await levelDb(player);
        player.setMix(1);
        await h.sleep(900);
        const v1 = await levelDb(player);
        const switched = player.setStem('b');
        await h.sleep(900);
        const b = await levelDb(player);
        const s1 = player.getState();
        const unknown = player.setStem('nope');
        const back = player.setStem(null); // the default: 'b'
        const out = {
            stem0: s0.stem, stems: s0.capabilities.stems, can: s0.capabilities.canMixStemB, statusB: s0.statusB,
            v1: v1 - a, b: b - a, switched, stem1: s1.stem, statusB1: s1.statusB, mix1: s1.processing.mix,
            unknown, back, stem2: player.getState().stem, playing: player.getState().isPlaying,
        };
        player.dispose();
        // Without `stem`, the default is 'b'.
        const { player: p2 } = mk();
        await p2.load({ manifest: `${longBase}/pairNamed/manifest.json` });
        out.defaultStem = p2.getState().stem;
        p2.dispose();
        return out;
    });
    console.log('named stems:', JSON.stringify(r));
    expect(r.stem0).toBe('v1');
    expect(r.stems).toEqual([{ key: 'b', label: 'Noise reduction' }, { key: 'v1', label: 'Voice conversion' }]);
    expect(r.can).toBe(true);
    expect(r.statusB).toBe('ready');
    expect(Math.abs(r.v1 + 6.02)).toBeLessThan(0.6);
    expect(r.switched).toBe(true);
    expect(r.stem1).toBe('b');
    expect(r.statusB1).toBe('ready');
    expect(r.mix1).toBe(1);
    expect(Math.abs(r.b)).toBeLessThan(0.6);
    expect(r.unknown).toBe(false);
    expect(r.back).toBe(true);
    expect(r.stem2).toBe('b');
    expect(r.playing).toBe(true);
    expect(r.defaultStem).toBe('b');
    expect(urls).toContain('v1');
    expect(urls).toContain('b');
});

test('the card shows a stem selector (labels) only when the manifest has more than one stem', async ({ page }) => {
    const card = async (name) => {
        await page.evaluate((url) => h.mountCard({ manifest: url }, { stretcher: 'native', prewarmSpeeds: false, processing: { highPassHz: 0, compression: 0 } }), `${BASE}/${name}/manifest.json`);
        await page.waitForFunction(() => window.cardPlayer?.getState().statusB === 'ready');
        return page.evaluate(() => {
            const select = document.querySelector('.rtd-mixer select.rtd-mixer-stem');
            return { select: !!select, options: select ? [...select.options].map((o) => [o.value, o.textContent]) : null, value: select?.value ?? null };
        });
    };
    const one = await card('pairEq');
    expect(one).toEqual({ select: false, options: null, value: null });
    const two = await card('pairNamed');
    expect(two).toEqual({ select: true, options: [['b', 'Noise reduction'], ['v1', 'Voice conversion']], value: 'b' });
    await page.selectOption('.rtd-mixer select.rtd-mixer-stem', 'v1');
    const after = await page.evaluate(async () => {
        await until(() => window.cardPlayer.getState().stem === 'v1', 3000);
        return { stem: window.cardPlayer.getState().stem, value: document.querySelector('.rtd-mixer select.rtd-mixer-stem').value };
    });
    expect(after).toEqual({ stem: 'v1', value: 'v1' });
    // A page's own select styles do not reach it: an arrow drawn as a background image on hover
    // (as sait.digital has it) tiled across the selector as a zigzag. It keeps its own box and
    // chevron, and the slider beside it does not cut its label short.
    await page.addStyleTag({ content: "select, select:hover { background-image: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1.5 6 6.5 11 1.5' stroke='red'/%3E%3C/svg%3E\"); padding: 12px; height: 60px; border: 3px solid red; }" });
    await page.hover('.rtd-mixer select.rtd-mixer-stem');
    const look = await page.evaluate(() => {
        const select = document.querySelector('.rtd-mixer select.rtd-mixer-stem');
        const s = getComputedStyle(select);
        const chevron = getComputedStyle(select.parentElement, '::after');
        return { image: s.backgroundImage, height: s.height, border: s.borderTopWidth, chevron: chevron.content !== 'none' && chevron.borderRightStyle === 'solid', cut: select.scrollWidth > select.clientWidth };
    });
    expect(look).toEqual({ image: 'none', height: '32px', border: '1px', chevron: true, cut: false });
});
