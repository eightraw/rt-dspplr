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

test('by default the wheel zooms and the page stays put; scrolling down at 1x still scrolls the page', async ({ page }) => {
    const { box } = await mount(page, {});
    await page.mouse.wheel(0, -300);
    await expect.poll(() => zoomed(page)).toBe(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.locator('.rtd-overview').count()).toBe(1);

    await page.locator('.rtd-zoom-reset').click();
    await expect.poll(() => zoomed(page)).toBe(0);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await zoomed(page)).toBe(0);
});

test("wheelZoom 'modifier': the wheel scrolls the page, Ctrl + wheel zooms", async ({ page }) => {
    const { box } = await mount(page, { wheelZoom: 'modifier' });
    await page.mouse.wheel(0, -300);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await zoomed(page)).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -300);
    await page.keyboard.up('Control');
    await expect.poll(() => zoomed(page)).toBe(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('touch: a tap seeks, a vertical swipe leaves the position alone, a sideways drag makes a loop', async ({ page }) => {
    const { track, box } = await mount(page, {});
    const at = (fraction) => ({ x: box.x + box.width * fraction, y: box.y + box.height / 2 });
    const finger = (type, point) => track.evaluate((el, { type, point }) => {
        el.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true,
            button: type === 'pointerdown' ? 0 : -1, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
            clientX: point.x, clientY: point.y,
        }));
    }, { type, point });
    const time = () => page.evaluate(() => window.timelinePlayer.getCurrentTime());
    const before = await time();

    // The browser took the finger for a scroll and cancelled the pointer: no seek.
    await finger('pointerdown', at(0.5));
    await finger('pointermove', { x: at(0.5).x + 2, y: at(0.5).y + 40 });
    await finger('pointercancel', { x: at(0.5).x + 2, y: at(0.5).y + 40 });
    await page.waitForTimeout(50);
    expect(await time()).toBe(before);

    // A tap seeks on release.
    await finger('pointerdown', at(0.5));
    await finger('pointerup', at(0.5));
    await expect.poll(time).toBeCloseTo(4, 1);

    // A sideways drag selects a loop.
    await finger('pointerdown', at(0.25));
    await finger('pointermove', at(0.35));
    await finger('pointermove', at(0.5));
    await finger('pointerup', at(0.5));
    const loop = await page.evaluate(() => window.timelinePlayer.getState().loop);
    expect(loop.start).toBeCloseTo(2, 1);
    expect(loop.end).toBeCloseTo(4, 1);
});
