import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
});

const mount = async (page, props) => {
    await page.evaluate((p) => h.mountTimeline(p), props);
    await page.waitForFunction(() => window.timelinePlayer?.getState().duration > 0);
    const track = page.locator('.rtd-scrub-track');
    const box = await track.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    return { track, box };
};
const zoomed = (page) => page.locator('.rtd-scrub[data-zoomed]').count();

test('zoom={false}: the wheel scrolls the page, nothing zooms or pans, a click still seeks', async ({ page }) => {
    const { track, box } = await mount(page, { zoom: false });

    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await zoomed(page)).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));

    // A pinch arrives as Ctrl + wheel; Shift + wheel would pan.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (const key of ['Control', 'Shift']) {
        await page.keyboard.down(key);
        await page.mouse.wheel(0, -300);
        await page.keyboard.up(key);
    }
    await track.focus();
    for (const key of ['+', '=', '-', '0']) await page.keyboard.press(key);
    expect(await zoomed(page)).toBe(0);
    expect(await page.locator('.rtd-zoom-reset').count()).toBe(0);
    expect(await page.locator('.rtd-overview').count()).toBe(0);

    await page.evaluate(() => window.scrollTo(0, 0));
    const now = await track.boundingBox();
    await page.mouse.click(now.x + now.width * 0.75, now.y + now.height / 2);
    await expect.poll(() => page.evaluate(() => window.timelinePlayer.getCurrentTime())).toBeGreaterThan(5.5);
});

test('zoom by default: the wheel zooms and the page stays put', async ({ page }) => {
    await mount(page, {});
    await page.mouse.wheel(0, -300);
    await expect.poll(() => zoomed(page)).toBe(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.locator('.rtd-overview').count()).toBe(1);
});
