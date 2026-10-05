// Stem B on prepared clips. Manifests are published with B made in the same
// prepareAudio call (v3, stems.b), and the player reads them as published.
// Covered: the mix law keeps a correlated pair's level; B plays at its own
// level (no hidden trim); B is fetched only when the mix asks for it; B present
// means the knob is on, B absent means it is off, with no 'processing' UI;
// nothing polls by default; refreshManifest() picks up a B that a host
// publishes later; the waveform and spectrogram show the blend.
// Fixtures from long-fixtures.mjs: pairEq (B = A, 37 ms late), pairQuiet
// (B = A, 37 ms late, -6 dB), both made in one prepare call; pairHot (A only).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { loadPrepare } from './long-fixtures.mjs';

const BASE = '/node_modules/.cache/rtd-long';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(root, 'node_modules', '.cache', 'rtd-long');

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
        window.brightness = (root, selector) => { const s = snap(root, selector); let b = 0; for (let i = 0; i < s.length; i += 4) b += s[i] + s[i + 1] + s[i + 2]; return b / Math.max(1, s.length / 4); };
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

test('B segments are fetched only when the mix asks for them', async ({ page }) => {
    const requests = [];
    page.on('request', (req) => { if (/\/pairEq\/b\//.test(req.url())) requests.push(req.url()); });
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.play({ manifest: `${longBase}/pairEq/manifest.json` });
        await h.sleep(1500);
        const atZero = player.getStreamStats().fetchesB;
        player.setMix(0.3);
        await until(() => player.getStreamStats().fetchesB > 0, 4000);
        const after = player.getStreamStats().fetchesB;
        player.dispose();
        return { atZero, after };
    });
    expect(r.atZero).toBe(0);
    expect(r.after).toBeGreaterThan(0);
    expect(requests.some((u) => /\/b\/seg\//.test(u))).toBe(true);
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
    page.on('request', (req) => { const m = /\/pairNamed\/(b|v1)\/seg\//.exec(req.url()); if (m) urls.push(m[1]); });
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
});
