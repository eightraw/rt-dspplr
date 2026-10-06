// Transport edge cases of prepared clips in the stream engine: what is heard
// after stop(), after switching clips (stem B included) and after a failed
// load; a loop that ends on a segment boundary; 1x after another speed; a
// segment that keeps failing. Fixtures from long-fixtures.mjs: stereo70 (70 s
// stereo, 10 s segments), pairEq (B = A, 37 ms late) and pairQuiet (the same
// with B at -6 dB), 4 s segments.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const BASE = '/node_modules/.cache/rtd-long';
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules/.cache/rtd-long');

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
        /** Output level in dB, averaged over ~1 s of the analyser. */
        window.levelDb = async (player) => {
            let sum = 0;
            for (let i = 0; i < 40; i += 1) { sum += h.rms(player) ** 2; await h.sleep(25); }
            return 10 * Math.log10(sum / 40);
        };
        /** Resource URLs fetched so far that match `re`. */
        window.fetched = (re) => performance.getEntriesByType('resource').map((e) => e.name).filter((u) => re.test(u));
    }, BASE);
});

test('stop() and a pause in reset mode silence a prepared clip, also within its first segment', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const out = {};
        for (const mode of ['stop', 'reset']) {
            const { player } = mk(mode === 'reset' ? { pauseMode: 'reset' } : {});
            await player.play({ manifest: `${longBase}/stereo70/manifest.json` });
            await until(() => h.rms(player) > 0.02);
            await h.sleep(500);
            const playing = h.rms(player);
            if (mode === 'stop') player.stop();
            else await player.pause();
            await h.sleep(150);
            const after = await loudest(player, 1500);
            out[mode] = { playing, after, isPlaying: player.getState().isPlaying, time: player.getCurrentTime() };
            player.dispose();
        }
        return out;
    });
    for (const mode of ['stop', 'reset']) {
        expect(r[mode].playing, mode).toBeGreaterThan(0.02);
        expect(r[mode].after, mode).toBeLessThan(0.001);
        expect(r[mode].isPlaying, mode).toBe(false);
        expect(r[mode].time, mode).toBeLessThan(0.01);
    }
});

test('a new clip replaces the old one at once and brings its own stem B', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.play({ manifest: `${longBase}/pairEq/manifest.json` });
        await until(() => h.rms(player) > 0.01);
        player.setMix(1);
        await until(() => player.getState().statusB === 'ready');
        await h.sleep(800);
        const eqB = await levelDb(player);
        const before = fetched(/\/pairEq\//).length;
        await player.play({ manifest: `${longBase}/pairQuiet/manifest.json` });
        await until(() => h.rms(player) > 0.005 && player.getState().isPlaying && !player.getState().buffering);
        player.setMix(1);
        await h.sleep(1200);
        const quietB = await levelDb(player);
        player.setMix(0);
        await h.sleep(600);
        const quietA = await levelDb(player);
        const r = {
            eqB, quietB, quietA,
            oldFetchedAfter: fetched(/\/pairEq\//).length - before,
            newB: fetched(/\/pairQuiet\/b\/r\d+\/source\./).length,
        };
        player.dispose();
        return r;
    });
    // pairQuiet's B is 6 dB under its A; pairEq's B would be at A's level.
    expect(r.quietA - r.quietB).toBeGreaterThan(4.5);
    expect(r.quietA - r.quietB).toBeLessThan(7.5);
    expect(r.newB).toBeGreaterThan(0);
    expect(r.oldFetchedAfter).toBe(0);
});

test('a clip that fails to load leaves silence, not the previous clip', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.play({ manifest: `${longBase}/stereo70/manifest.json` });
        await until(() => h.rms(player) > 0.02);
        await player.play({ manifest: `${longBase}/missing/manifest.json` }).catch(() => {});
        await h.sleep(150);
        const after = await loudest(player, 1200);
        const s = player.getState();
        player.dispose();
        return { after, status: s.status, isPlaying: s.isPlaying };
    });
    expect(r.status).toBe('error');
    expect(r.isPlaying).toBe(false);
    expect(r.after).toBeLessThan(0.001);
});

test('a loop that ends on a segment boundary keeps playing, at 1x and at 1.5x', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const out = {};
        for (const speed of [1, 1.5]) {
            const { player } = mk();
            await player.play({ manifest: `${longBase}/stereo70/manifest.json` });
            await until(() => h.rms(player) > 0.02);
            if (speed !== 1) {
                await player.setSpeed(speed);
                await until(() => player.getStreamStats()?.stretch.active);
            }
            player.setLoop({ start: 5, end: 10 });
            await player.seek(9);
            const times = [];
            let quiet = 0;
            for (let i = 0; i < 60; i += 1) {
                await h.sleep(50);
                times.push(player.getCurrentTime());
                if (h.rms(player) < 0.005) quiet += 1;
            }
            const s = player.getState();
            out[speed] = { loop: s.loop, buffering: s.buffering, min: Math.min(...times.slice(20)), max: Math.max(...times), last: times.at(-1), quiet, distinct: new Set(times.map((t) => t.toFixed(2))).size };
            player.dispose();
        }
        return out;
    });
    for (const speed of ['1', '1.5']) {
        const x = r[speed];
        expect(x.buffering, speed).toBe(false);
        expect(x.max, speed).toBeLessThanOrEqual(x.loop.end + 0.02);
        // It wrapped (3 s of playing from 9 s inside a loop ending at 10 s) and is still moving.
        expect(x.min, speed).toBeLessThan(9);
        expect(x.distinct, speed).toBeGreaterThan(40);
        expect(x.quiet, speed).toBeLessThan(4);
    }
});

test('back at 1x after another speed, playback returns to the original samples', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.play({ manifest: `${longBase}/stereo70/manifest.json` });
        await until(() => h.rms(player) > 0.02);
        await player.setSpeed(1.5);
        const stretched = !!(await until(() => player.getStreamStats()?.stretch.active, 3000));
        await h.sleep(500);
        await player.setSpeed(1);
        const direct = !!(await until(() => player.getStreamStats()?.stretch.active === false, 3000));
        const t0 = player.getCurrentTime();
        await h.sleep(1000);
        const moved = player.getCurrentTime() - t0;
        const level = h.rms(player);
        player.dispose();
        return { stretched, direct, moved, level };
    });
    expect(r.stretched).toBe(true);
    expect(r.direct).toBe(true);
    expect(r.moved).toBeGreaterThan(0.9);
    expect(r.moved).toBeLessThan(1.1);
    expect(r.level).toBeGreaterThan(0.02);
});

test('a segment that keeps failing pauses with an error and is not requested on every pump', async ({ page }) => {
    let hits = 0;
    // Segment 3's Range request of the source fails; the others go through.
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'stereo70', 'manifest.json'), 'utf8'));
    const [start, end] = manifest.segments.list[3].range;
    await page.route('**/stereo70/source.wav', (route) => {
        if (route.request().headers().range !== `bytes=${start}-${end - 1}`) return route.continue();
        hits += 1;
        return route.fulfill({ status: 404, body: 'gone' });
    });
    const r = await page.evaluate(async () => {
        const { player } = mk();
        let error = null;
        player.on('error', (e) => { error = String(e?.message ?? e); });
        await player.play({ manifest: `${longBase}/stereo70/manifest.json` });
        await until(() => h.rms(player) > 0.02);
        const t0 = performance.now();
        await player.seek(31);
        await until(() => error, 8000);
        const s = player.getState();
        const r = { error, ms: Math.round(performance.now() - t0), isPlaying: s.isPlaying, buffering: s.buffering };
        // A seek elsewhere still plays.
        await player.play();
        await player.seek(45);
        r.elsewhere = !!(await until(() => h.rms(player) > 0.02 && player.getCurrentTime() > 45.1, 4000));
        player.dispose();
        return r;
    });
    expect(r.error).toMatch(/Segment 3/);
    expect(r.isPlaying).toBe(false);
    expect(r.buffering).toBe(false);
    expect(r.ms).toBeLessThan(6000);
    expect(r.elsewhere).toBe(true);
    expect(hits).toBeLessThan(10);
});
