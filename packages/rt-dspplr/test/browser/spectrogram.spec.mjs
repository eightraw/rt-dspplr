import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
});

// Row of the picture (0 = top) that a frequency falls on, for the default 30 Hz – 16 kHz axis.
const rowOf = (hz, rows) => Math.round(rows - 1 - (rows - 1) * Math.log(hz / 30) / Math.log(16000 / 30));

test('a sine lands on its row of the logarithmic axis', async ({ page }) => {
    const rows = 120;
    const loudest = await page.evaluate(async (rows) => {
        const data = await new Promise((resolve) => {
            const analyzer = new h.advanced.SpectrogramAnalyzer(resolve);
            analyzer.setBuffers(h.buffer(1, 1000), null);
            analyzer.request({ start: 0, end: 1, columns: 8, rows, minHz: 30, maxHz: 16000, fftSize: 2048 });
        });
        let best = 0;
        for (let row = 0; row < data.rows; row += 1) {
            if (data.magA[row * data.columns + 4] > data.magA[best * data.columns + 4]) best = row;
        }
        return { best, magB: data.magB, reference: data.referenceMax > 0 };
    }, rows);
    expect(Math.abs(loudest.best - rowOf(1000, rows))).toBeLessThanOrEqual(1);
    expect(loudest.magB).toBeNull();
    expect(loudest.reference).toBe(true);
});

test('dual colours each stem and the mix fades one of them', async ({ page }) => {
    const rows = 200;
    const pixels = await page.evaluate(async ({ rows, rowA, rowB }) => {
        const canvas = document.createElement('canvas');
        canvas.style.cssText = `width:100px;height:${rows}px;display:block`;
        document.body.append(canvas);
        const p = h.make({ mixLaw: 'separation', processing: { mix: 0.5, highPassHz: 0, compression: 0 } });
        // A loud 100 Hz tone in stem A sets the reference, so the two tones under
        // test sit on the coloured part of the ramp rather than at its white end.
        const tones = (parts) => {
            const b = new AudioBuffer({ length: 96000, sampleRate: 48000, numberOfChannels: 1 });
            const d = b.getChannelData(0);
            for (let i = 0; i < d.length; i++) for (const [hz, amp] of parts) d[i] += amp * Math.sin(i * 2 * Math.PI * hz / 48000);
            return b;
        };
        await p.load({ src: tones([[100, 0.5], [440, 0.05]]), srcB: tones([[3000, 0.05]]) });
        while (p.getState().statusB !== 'ready') await h.sleep(20);
        const view = h.createSpectrogram(canvas, p, { colorMode: 'dual' });
        const read = (row) => Array.from(canvas.getContext('2d').getImageData(50, row, 1, 1).data.slice(0, 3));
        const settle = () => h.sleep(400);
        await settle();
        const mid = { a: read(rowA), b: read(rowB) };
        p.setMix(0); await settle();
        const left = { a: read(rowA), b: read(rowB) };
        view.dispose(); p.dispose();
        return { mid, left, size: [canvas.width, canvas.height] };
    }, { rows, rowA: rowOf(440, rows), rowB: rowOf(3000, rows) });
    expect(pixels.size).toEqual([100, rows]);
    // Stem A (440 Hz) is orange: more red than blue. Stem B (3 kHz) is blue.
    expect(pixels.mid.a[0]).toBeGreaterThan(pixels.mid.a[2]);
    expect(pixels.mid.b[2]).toBeGreaterThan(pixels.mid.b[0]);
    // With the mix at stem A alone, stem B's row goes dark.
    const sum = (rgb) => rgb[0] + rgb[1] + rgb[2];
    expect(sum(pixels.left.b)).toBeLessThan(sum(pixels.mid.b) / 3);
    expect(sum(pixels.left.a)).toBeGreaterThan(sum(pixels.mid.a) * 0.8);
});

test('one worker serves every spectrogram, and one off screen computes nothing', async ({ page }) => {
    const result = await page.evaluate(async () => {
        let workers = 0;
        const Real = window.Worker;
        window.Worker = class extends Real { constructor(...args) { super(...args); workers += 1; } };
        document.body.style.margin = '0';
        const p = h.make();
        await p.load(h.buffer(2, 1000));
        const canvases = [];
        const views = [];
        for (let i = 0; i < 5; i += 1) {
            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'width:120px;height:600px;display:block';
            document.body.append(canvas);
            canvases.push(canvas);
            views.push(h.createSpectrogram(canvas, p));
        }
        await h.sleep(800);
        // The background is #131315; a computed picture has a 1 kHz line on it.
        const painted = canvases.map((canvas) => {
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let max = 0;
            for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i]);
            return max > 0x40;
        });
        views.forEach((view) => view.dispose());
        p.dispose();
        window.Worker = Real;
        return { workers, painted };
    });
    // One spectrogram worker for all five views, plus one peaks worker: the DSP preview
    // (the gain the spectrogram applies per column) is computed once per player.
    expect(result.workers).toBe(2);
    // The viewport is 720 px tall and views start computing 200 px before they show.
    expect(result.painted).toEqual([true, true, false, false, false]);
});
