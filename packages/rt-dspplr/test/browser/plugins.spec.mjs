// The DSP plugin API: a third-party plugin (examples/plugins/three-band-eq.js)
// is heard AND drawn (waveform + spectrogram, whole clips and prepared ones),
// effects without a preview are flagged, a failing plugin is bypassed while
// playback goes on, params are validated, the card renders the schema.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const BASE = '/node_modules/.cache/rtd-long';
// Served from outside the package root through Vite's /@fs/ (the workspace root is allowed).
const EQ = '/@fs/' + path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples/plugins/three-band-eq.js').split(path.sep).join('/');

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    await page.evaluate(async (args) => {
        window.longBase = args.base;
        window.eq = (await import(args.eq)).threeBandEq;
        window.until = async (fn, timeout = 8000) => {
            const t0 = performance.now();
            while (performance.now() - t0 < timeout) { const v = fn(); if (v) return v; await h.sleep(10); }
            return null;
        };
        window.mk = (options = {}, timeline = {}) => {
            const ui = document.body.appendChild(document.createElement('div'));
            ui.style.width = '800px';
            const box = ui.appendChild(document.createElement('div'));
            box.style.height = '120px';
            const player = h.createAudioPlayer({ element: ui, prewarmSpeeds: false, stretcher: 'native', ...options });
            h.createTimeline(box, player, timeline);
            return { player, box };
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
        window.diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > 8) d += 1; return d / Math.max(1, a.length); };
        /** The spectrogram's background (theme) as [r, g, b]; a pixel's ink is its distance from it (cleared pixels: none). */
        window.spectrogramInk = (canvas) => {
            const style = getComputedStyle(canvas);
            const stops = h.colormapStops(style.getPropertyValue('--rtd-spectrogram-colormap').trim() || null);
            const hex = (stops ? stops[0] : style.getPropertyValue('--rtd-spectrogram-bg').trim() || '#131315').replace('#', '');
            const n = parseInt(hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex, 16);
            const bg = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
            return (px, i) => (px[i + 3] === 0 ? 0 : Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]));
        };
        /** Mean ink of rows [r0, r1) (fractions of the height). */
        window.rowsBrightness = (canvas, r0, r1) => {
            const { width, height } = canvas;
            const px = canvas.getContext('2d').getImageData(0, 0, width, height).data;
            const ink = spectrogramInk(canvas);
            let s = 0, n = 0;
            for (let y = Math.floor(r0 * height); y < Math.floor(r1 * height); y += 1) for (let x = 0; x < width; x += 1) { s += ink(px, (y * width + x) * 4); n += 1; }
            return s / Math.max(1, n);
        };
        /** A tone at `hz` as a whole clip. */
        window.toneBuffer = (hz, seconds = 6) => {
            const b = new AudioBuffer({ length: 48000 * seconds, sampleRate: 48000, numberOfChannels: 1 });
            const d = b.getChannelData(0);
            for (let i = 0; i < d.length; i += 1) d[i] = 0.05 * Math.sin(2 * Math.PI * hz * i / 48000);
            return b;
        };
    }, { base: BASE, eq: EQ });
});

test('a third-party EQ is heard: +12 dB low shelf raises a 120 Hz tone, bypass and remove restore it', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.play(toneBuffer(120));
        await h.sleep(300);
        const dry = h.rms(player);
        const id = player.effects.add(eq, { params: { low: 12 } });
        await h.sleep(400);
        const wet = h.rms(player);
        player.effects.bypass(id, true);
        await h.sleep(300);
        const bypassed = h.rms(player);
        player.effects.bypass(id, false);
        player.effects.move(id, 0); // before the built-ins
        await h.sleep(300);
        const moved = h.rms(player);
        player.effects.remove(id);
        await h.sleep(300);
        const removed = h.rms(player);
        const order = player.getState().effects.map((e) => e.id);
        player.dispose();
        return { dry, wet, bypassed, moved, removed, order };
    });
    expect(r.wet / r.dry).toBeGreaterThan(2.5); // ≈ +10 dB at 120 Hz
    expect(Math.abs(r.bypassed / r.dry - 1)).toBeLessThan(0.1);
    expect(r.moved / r.dry).toBeGreaterThan(2.5);
    expect(Math.abs(r.removed / r.dry - 1)).toBeLessThan(0.1);
    expect(r.order).toEqual(['highpass', 'dynamics']);
});

for (const kind of ['buffer', 'segmented']) {
    test(`the EQ shows on the waveform and the spectrogram (${kind})`, async ({ page }) => {
        const r = await page.evaluate(async (kind) => {
            const wave = mk();
            const spec = (() => {
                const box = wave.box.parentElement.appendChild(document.createElement('div'));
                box.style.height = '160px';
                h.createTimeline(box, wave.player, { display: 'spectrogram', ruler: false });
                return box;
            })();
            const { player, box } = wave;
            await player.load(kind === 'buffer' ? { src: `${longBase}/mono30.wav` } : { manifest: `${longBase}/mono30/manifest.json` });
            const canvas = spec.querySelector('canvas.rtd-spectrogram');
            await until(() => rowsBrightness(canvas, 0, 1) > 30);
            await h.sleep(900);
            const wave0 = snap(box, '.rtd-wave');
            // The fixture's energy is around 180–250 Hz, near the bottom of the 30 Hz – 16 kHz axis.
            const low0 = rowsBrightness(canvas, 0.72, 0.85);
            const id = player.effects.add(eq, { params: { low: -18 } });
            await h.sleep(900);
            const wave1 = snap(box, '.rtd-wave');
            const low1 = rowsBrightness(canvas, 0.72, 0.85);
            const coverage = player.getState().previewCoverage;
            player.effects.remove(id);
            player.dispose();
            return { waveChange: diff(wave0, wave1), low0, low1, coverage };
        }, kind);
        expect(r.waveChange).toBeGreaterThan(0.01);
        expect(r.low1).toBeLessThan(r.low0 * 0.85); // down to the background colour
        expect(r.coverage).toEqual({ waveform: true, spectrogram: true, overview: true, missing: [] });
    });
}

test('an effect without a preview is flagged, in the state and in the card', async ({ page }) => {
    await page.evaluate(() => {
        window.blind = {
            id: 'test.blind', name: 'Blind fuzz', version: '1', params: [{ id: 'drive', label: 'Drive', min: 0, max: 1, default: 0.5 }],
            realtime: { kind: 'nodes', create(ctx) { const g = ctx.createGain(); return { input: g, output: g, setParam() {}, dispose() { g.disconnect(); } }; } },
        };
        h.mountCard({ src: h.buffer(4) }, { stretcher: 'native' });
    });
    await page.waitForFunction(() => window.cardPlayer?.getState().duration > 0);
    await page.evaluate(() => window.cardPlayer.effects.add(window.blind));
    const coverage = await page.evaluate(() => window.cardPlayer.getState().previewCoverage);
    expect(coverage.missing).toEqual(['Blind fuzz']);
    expect(coverage.waveform).toBe(false);
    await page.getByRole('button', { name: 'Post FX' }).click();
    await expect(page.locator('[data-preview-missing]')).toHaveText(/Not in the preview: Blind fuzz/);
    // The schema renders: its name, its one param.
    await expect(page.locator('[data-plugin="test.blind"]')).toContainText('Drive');
});

test('the card renders a plugin\'s params from its schema and drives them', async ({ page }) => {
    await page.evaluate(() => h.mountCard({ src: h.buffer(4) }, { stretcher: 'native' }));
    await page.waitForFunction(() => window.cardPlayer?.getState().duration > 0);
    const id = await page.evaluate(() => window.cardPlayer.effects.add(window.eq));
    await page.getByRole('button', { name: 'Post FX' }).click();
    const rows = page.locator('[data-plugin="example.three-band-eq"] input[type=range]');
    await expect(rows).toHaveCount(3);
    await rows.nth(2).focus();
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowRight');
    expect(await page.evaluate((id) => window.cardPlayer.getState().effects.find((e) => e.id === id).params.high, id)).toBe(3);
});

test('params are validated against the schema', async ({ page }) => {
    const r = await page.evaluate(() => {
        const { player } = mk();
        const id = player.effects.add(eq);
        player.effects.setParam(id, 'low', 99);
        const clamped = player.getState().effects.find((e) => e.id === id).params.low;
        let unknown = '', nan = '';
        try { player.effects.setParam(id, 'nope', 1); } catch (e) { unknown = e.message; }
        try { player.effects.setParam(id, 'low', NaN); } catch (e) { nan = e.message; }
        let notPlugin = '';
        try { player.effects.add({ id: 'x' }); } catch (e) { notPlugin = e.message; }
        player.dispose();
        return { clamped, unknown, nan, notPlugin };
    });
    expect(r.clamped).toBe(18);
    expect(r.unknown).toMatch(/no parameter "nope"/);
    expect(r.nan).toMatch(/not a number/);
    expect(r.notPlugin).toMatch(/not a DspPlugin/);
});

test('a plugin whose processor throws is bypassed, reported, and playback goes on', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const crashing = {
            id: 'test.crash', name: 'Crashy', version: '1', params: [{ id: 'x', label: 'X', min: 0, max: 1, default: 0 }],
            realtime: {
                kind: 'worklet', processorName: 'test-crash',
                moduleCode: `registerProcessor('test-crash', class extends AudioWorkletProcessor {
                    constructor() { super(); this.n = 0; }
                    process(inputs, outputs) {
                        if (++this.n > 40) throw new Error('boom');
                        const i = inputs[0], o = outputs[0];
                        for (let c = 0; c < o.length; c++) if (i[c]) o[c].set(i[c]);
                        return true;
                    }
                });`,
            },
        };
        const { player } = mk();
        const errors = [];
        player.on('effecterror', (e) => errors.push(e));
        await player.play(toneBuffer(440));
        player.effects.add(crashing);
        await until(() => errors.length > 0, 4000);
        await h.sleep(300);
        const effect = player.getState().effects.find((e) => e.plugin.id === 'test.crash');
        const r = { errors: errors.length, error: effect.error, rms: h.rms(player), playing: player.getState().isPlaying };
        player.dispose();
        return r;
    });
    expect(r.errors).toBe(1);
    expect(r.error).toMatch(/Crashy/);
    expect(r.playing).toBe(true);
    expect(r.rms).toBeGreaterThan(0.02);
});

test('input gain drives the compressor; output gain comes after it', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player } = mk();
        await player.play(toneBuffer(440));
        player.setCompression(1);
        await h.sleep(400);
        const base = h.rms(player);
        // +12 dB into the compressor comes out at much less than +12 dB.
        player.setInputGain(12);
        await h.sleep(500);
        const inBoost = h.rms(player);
        player.setInputGain(0);
        await h.sleep(500);
        // -6 dB after the compressor is exactly -6 dB.
        player.setOutputGain(-6);
        await h.sleep(300);
        const outCut = h.rms(player);
        const p = player.getState().processing;
        player.dispose();
        return { inRatio: inBoost / base, outRatio: outCut / base, inputGainDb: p.inputGainDb, outputGainDb: p.outputGainDb };
    });
    expect(r.inRatio).toBeGreaterThan(1.05);
    expect(r.inRatio).toBeLessThan(3); // +12 dB would be 3.98
    expect(r.outRatio).toBeGreaterThan(0.48);
    expect(r.outRatio).toBeLessThan(0.52);
    expect(r.inputGainDb).toBe(0);
    expect(r.outputGainDb).toBe(-6);
});

test('the ceiling is the last stage: +24 dB output with a boosting plugin never passes -0.01 dBFS', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const { player } = mk();
        const loud = new AudioBuffer({ length: 48000 * 4, sampleRate: 48000, numberOfChannels: 1 });
        const d = loud.getChannelData(0);
        for (let i = 0; i < d.length; i += 1) d[i] = 0.8 * Math.sin(2 * Math.PI * 120 * i / 48000);
        await player.play(loud);
        player.effects.add(eq, { params: { low: 12 } });
        player.setInputGain(12);
        player.setOutputGain(24);
        await h.sleep(800);
        const a = player.analyser;
        const buf = new Float32Array(a.fftSize);
        let peak = 0;
        for (let k = 0; k < 20; k += 1) {
            a.getFloatTimeDomainData(buf);
            for (const v of buf) peak = Math.max(peak, Math.abs(v));
            await h.sleep(30);
        }
        player.dispose();
        return { peak };
    });
    expect(r.peak).toBeGreaterThan(0.99);
    expect(r.peak).toBeLessThanOrEqual(Math.pow(10, -0.01 / 20) + 1e-6);
});

for (const kind of ['buffer', 'segmented']) {
    test(`input and output gain show on the waveform and the spectrogram (${kind})`, async ({ page }) => {
        const r = await page.evaluate(async (kind) => {
            const wave = mk({ processing: { highPassHz: 0, compression: 0 } });
            const spec = (() => {
                const box = wave.box.parentElement.appendChild(document.createElement('div'));
                box.style.height = '160px';
                h.createTimeline(box, wave.player, { display: 'spectrogram', ruler: false });
                return box;
            })();
            const { player, box } = wave;
            await player.load(kind === 'buffer' ? { src: `${longBase}/mono30.wav` } : { manifest: `${longBase}/mono30/manifest.json` });
            const canvas = spec.querySelector('canvas.rtd-spectrogram');
            await until(() => rowsBrightness(canvas, 0, 1) > 30);
            await h.sleep(900);
            const wave0 = snap(box, '.rtd-wave');
            const bright0 = rowsBrightness(canvas, 0, 1);
            player.setOutputGain(-18);
            await h.sleep(900);
            const waveOut = snap(box, '.rtd-wave');
            const brightOut = rowsBrightness(canvas, 0, 1);
            player.setOutputGain(0);
            player.setInputGain(-18);
            await h.sleep(900);
            const waveIn = snap(box, '.rtd-wave');
            const brightIn = rowsBrightness(canvas, 0, 1);
            player.dispose();
            return { outChange: diff(wave0, waveOut), inChange: diff(wave0, waveIn), bright0, brightOut, brightIn };
        }, kind);
        expect(r.outChange).toBeGreaterThan(0.01);
        expect(r.inChange).toBeGreaterThan(0.01);
        expect(r.brightOut).toBeLessThan(r.bright0 * 0.9);
        expect(r.brightIn).toBeLessThan(r.bright0 * 0.9);
    });
}
