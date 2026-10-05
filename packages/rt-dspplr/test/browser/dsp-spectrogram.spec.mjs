// The spectrogram shows what is heard: high-pass per row, dynamics + output gain
// per column, applied at paint time, for a whole clip and a prepared one.
import { test, expect } from '@playwright/test';

const BASE = '/node_modules/.cache/rtd-long';

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    await page.evaluate((base) => {
        window.longBase = base;
        /** Mean brightness of rows [r0, r1) (fractions of the height) per column, and overall. */
        window.bands = (canvas, r0, r1) => {
            const { width, height } = canvas;
            const px = canvas.getContext('2d').getImageData(0, 0, width, height).data;
            const cols = new Float64Array(width);
            const y0 = Math.floor(r0 * height), y1 = Math.floor(r1 * height);
            for (let y = y0; y < y1; y += 1) for (let x = 0; x < width; x += 1) {
                const i = (y * width + x) * 4;
                cols[x] += (px[i] + px[i + 1] + px[i + 2]) / (y1 - y0);
            }
            return { mean: cols.reduce((a, b) => a + b, 0) / width, cols: Array.from(cols) };
        };
        window.until = async (fn, timeout = 8000) => {
            const t0 = performance.now();
            while (performance.now() - t0 < timeout) { const v = fn(); if (v) return v; await h.sleep(10); }
            return null;
        };
    }, BASE);
});

for (const kind of ['buffer', 'segmented']) {
    test(`spectrogram follows high-pass, compression and output gain (${kind})`, async ({ page }) => {
        const result = await page.evaluate(async (kind) => {
            const ui = document.body.appendChild(document.createElement('div'));
            ui.style.width = '800px';
            const box = ui.appendChild(document.createElement('div'));
            box.style.height = '160px';
            const player = h.createAudioPlayer({ element: ui, prewarmSpeeds: false, stretcher: 'native' });
            h.createTimeline(box, player, { display: 'spectrogram', ruler: false });
            await player.load(kind === 'buffer' ? { src: `${longBase}/mono30.wav` } : { manifest: `${longBase}/mono30/manifest.json` });
            const canvas = box.querySelector('canvas.rtd-spectrogram');
            await until(() => bands(canvas, 0, 1).mean > 30);
            await h.sleep(800); // the preview's gain track
            // The fixture's energy is at 180–250 Hz: rows near the bottom of a 30 Hz – 16 kHz axis.
            const low0 = bands(canvas, 0.72, 0.85).mean, high0 = bands(canvas, 0.2, 0.5).mean;
            const t0 = performance.now();
            player.setHighPass(500);
            const repainted = await until(() => bands(canvas, 0.72, 0.85).mean < low0 * 0.9 && performance.now(), 2000);
            const hpMs = repainted ? repainted - t0 : null;
            await h.sleep(100);
            const low1 = bands(canvas, 0.72, 0.85).mean, high1 = bands(canvas, 0.2, 0.5).mean;
            player.setHighPass(0);
            await h.sleep(150);
            const before = bands(canvas, 0.6, 0.9).cols;
            player.setCompression(1);
            await h.sleep(800);
            const after = bands(canvas, 0.6, 0.9).cols;
            let changed = 0;
            for (let x = 0; x < before.length; x += 1) if (Math.abs(after[x] - before[x]) > 4) changed += 1;
            player.setCompression(0);
            await h.sleep(800);
            const base = bands(canvas, 0.6, 0.9).mean;
            player.setOutputGain(-24);
            const g0 = performance.now();
            const quiet = await until(() => bands(canvas, 0.6, 0.9).mean < base * 0.8 && performance.now(), 2000);
            player.dispose();
            return { low0, low1, high0, high1, hpMs, changedColumns: changed / before.length, gainMs: quiet ? quiet - g0 : null };
        }, kind);
        expect(result.low1).toBeLessThan(result.low0 * 0.75); // the high-pass takes the low rows away
        expect(result.hpMs).not.toBeNull();
        expect(result.hpMs).toBeLessThan(200); // a repaint, no STFT
        expect(result.changedColumns).toBeGreaterThan(0.2); // compression reshapes the columns over time
        expect(result.gainMs).not.toBeNull();
        expect(result.gainMs).toBeLessThan(200);
        console.log(`${kind}: HP repaint ${result.hpMs.toFixed(0)} ms, output gain repaint ${result.gainMs.toFixed(0)} ms, compression changed ${(result.changedColumns * 100).toFixed(0)} % of columns`);
    });
}

test('paint cost of the DSP pass per knob move', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const adv = h.advanced;
        const columns = 1600, rows = 320;
        const data = { start: 0, end: 600, columns, rows, magA: new Float32Array(columns * rows).map(() => Math.random()), magB: null, referenceSum: 1, referenceMax: 1 };
        const gain = { binSize: 256, startFrame: 0, values: new Float32Array(600 * 48000 / 256).map(() => 0.5 + Math.random() * 0.5), outputGain: 1 };
        const image = new ImageData(columns, rows);
        const look = { colorMode: 'single', palette: h.DEFAULT_SPECTROGRAM_PALETTE, floorDb: 66 };
        let reuse = null;
        const times = [];
        for (let i = 0; i < 40; i += 1) {
            const state = { processing: { highPassHz: i % 2 ? 300 : 120, compression: 0.5, outputGainDb: -3 * (i % 3), speed: 1, mix: 0 }, audioContext: null };
            const t0 = performance.now();
            reuse = adv.applyDspToSpectrogram(data, { state, preview: { pyramid: null, gain, windowGain: null }, timelineRate: 48000, minHz: 30, maxHz: 16000 }, reuse);
            const t1 = performance.now();
            adv.paintSpectrogram(image, reuse, [1, 0], look, 1);
            times.push([t1 - t0, performance.now() - t1]);
        }
        const med = (k) => times.map((t) => t[k]).sort((a, b) => a - b)[20];
        return { dsp: med(0), paint: med(1) };
    });
    console.log(`1600×320 px: DSP pass ${result.dsp.toFixed(2)} ms + colouring ${result.paint.toFixed(2)} ms (median of 40 knob moves)`);
    expect(result.dsp).toBeLessThan(20);
});
