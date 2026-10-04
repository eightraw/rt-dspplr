import { test, expect } from '@playwright/test';

// createTimeline without React: the same seek bar as the card's, on a plain element.
test('createTimeline: waveform, seek, loop, keys, zoom and overview, without React', async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    await page.evaluate(async () => {
        const host = document.createElement('div');
        host.id = 'timeline-host';
        host.style.cssText = 'width:600px;height:140px';
        document.body.append(host);
        window.tlPlayer = h.make();
        window.tlView = h.createTimeline(host, tlPlayer, { theme: 'light' });
        await tlPlayer.load(h.buffer(4));
    });
    const track = page.locator('#timeline-host .rtd-scrub-track');
    await expect(page.locator('#timeline-host > .rtd.rtd-timeline > .rtd-wavebox')).toHaveCount(1);

    // The waveform arrives from its worker and is drawn.
    await expect.poll(() => page.evaluate(() => {
        const canvas = document.querySelector('#timeline-host canvas.rtd-wave');
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        let inked = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) inked += 1;
        return inked;
    })).toBeGreaterThan(1000);

    const box = await track.boundingBox();
    const at = (f) => ({ x: box.x + box.width * f, y: box.y + box.height / 2 });

    // Click seeks.
    await page.mouse.click(at(0.5).x, at(0.5).y);
    await expect.poll(() => page.evaluate(() => tlPlayer.getCurrentTime())).toBeCloseTo(2, 1);

    // Drag selects a loop, and both handles show.
    await page.mouse.move(at(0.2).x, at(0.2).y);
    await page.mouse.down();
    await page.mouse.move(at(0.4).x, at(0.4).y, { steps: 4 });
    await page.mouse.move(at(0.6).x, at(0.6).y, { steps: 4 });
    await page.mouse.up();
    const loop = await page.evaluate(() => tlPlayer.getState().loop);
    expect(loop.start).toBeCloseTo(0.8, 1);
    expect(loop.end).toBeCloseTo(2.4, 1);
    await expect(page.locator('#timeline-host .rtd-loop-handle')).toHaveCount(2);
    await expect(page.locator('#timeline-host .rtd-loop-band')).toHaveCount(1);

    // Keys: Esc drops the loop, arrows seek, + zooms, the overview pans, 0 resets.
    await track.focus();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => tlPlayer.getState().loop)).toBeNull();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.evaluate(() => tlPlayer.getCurrentTime())).toBeCloseTo(1, 1);
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await expect(page.locator('#timeline-host .rtd-scrub[data-zoomed]')).toHaveCount(1);
    const windowBox = await page.locator('#timeline-host .rtd-overview-window').boundingBox();
    expect(windowBox.width).toBeLessThan(box.width * 0.6);
    const before = windowBox.x;
    await page.mouse.move(windowBox.x + windowBox.width / 2, windowBox.y + windowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(windowBox.x + windowBox.width / 2 + 120, windowBox.y + windowBox.height / 2, { steps: 5 });
    await page.mouse.up();
    expect((await page.locator('#timeline-host .rtd-overview-window').boundingBox()).x).toBeGreaterThan(before + 60);
    await expect(page.locator('#timeline-host .rtd-zoom-reset')).toHaveCount(1);
    await track.focus();
    await page.keyboard.press('0');
    await expect(page.locator('#timeline-host .rtd-scrub[data-zoomed]')).toHaveCount(0);

    // Options change in place; dispose removes everything.
    await page.evaluate(() => tlView.setOptions({ display: 'spectrogram', ruler: false }));
    await expect(page.locator('#timeline-host canvas.rtd-spectrogram')).toHaveCount(1);
    await expect(page.locator('#timeline-host canvas.rtd-wave:not(.rtd-spectrogram)')).toHaveCount(0);
    await expect(page.locator('#timeline-host .rtd-ruler')).toHaveCount(0);
    await page.evaluate(() => { tlView.dispose(); tlPlayer.dispose(); });
    expect(await page.locator('#timeline-host').evaluate((el) => el.childElementCount)).toBe(0);
});
