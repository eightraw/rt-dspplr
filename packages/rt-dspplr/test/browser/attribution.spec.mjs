import { test, expect } from '@playwright/test';

for (const layout of ['full', 'compact']) {
    test(`${layout}: attribution opens on controls, closes and supports keyboard`, async ({ page }) => {
        await page.goto('/test/browser/index.html');
        await page.waitForFunction(() => window.h);
        await page.evaluate(layout => h.mountMenu(layout), layout);
        const player = page.locator('.rtd');
        const control = layout === 'compact' ? page.getByRole('button', { name: 'Player settings' }) : page.getByRole('button', { name: 'Post FX' });
        await control.click({ button: 'right' });
        const menu = page.getByRole('menu', { name: 'About this player' });
        const credit = menu.getByRole('menuitem');
        await expect(credit).toContainText('RT-DSPPLR by SAIT Digital');
        await expect(credit).toContainText(/v\d+\.\d+\.\d+/);
        await expect(credit).toHaveAttribute('href', 'https://github.com/eightraw/rt-dspplr');
        await expect(credit).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
        await control.focus();
        await page.keyboard.press('Shift+F10');
        await expect(credit).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(control).toBeFocused();
        await page.getByRole('button', { name: 'About this player' }).click();
        await expect(credit).toBeVisible();
        await page.keyboard.press('Escape');
        // Disabled controls still expose the root's capture handler.
        await player.locator('button:disabled').first().dispatchEvent('contextmenu', { clientX: 25, clientY: 25 });
        await expect(credit).toBeVisible();
        await page.mouse.click(5, 500);
        await expect(menu).toHaveCount(0);
        // A clipped/transformed host must not clip the top-layer menu.
        await player.evaluate(el => { el.parentElement.style.cssText = 'overflow:hidden;transform:translate(0);'; });
        await player.dispatchEvent('contextmenu', { clientX: 1279, clientY: 719 });
        const bounds = await menu.boundingBox();
        const viewport = page.viewportSize();
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
        await expect(menu).toBeVisible();
        await page.setViewportSize({ width: 700, height: 500 });
        await expect(menu).toHaveCount(0);
    });
}

test('a custom interface gets the menu from the player itself, without React or a stylesheet', async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    const frozen = await page.evaluate(() => {
        document.querySelectorAll('style, link[rel="stylesheet"]').forEach(el => el.remove());
        const a = document.createElement('section'), b = document.createElement('section');
        a.id = 'a'; b.id = 'b';
        a.innerHTML = '<button>Custom play</button>';
        document.body.append(a, b);
        h.createAudioPlayer({ element: a });
        window.releaseB = h.createAudioPlayer().mount(b);
        // A second player on the same element shares its menu.
        window.releaseA2 = h.createAudioPlayer().mount(a);
        return Object.isFrozen(h.PLAYER_ATTRIBUTION);
    });
    expect(frozen).toBe(true);
    await expect(page.getByRole('button', { name: 'About this player' })).toHaveCount(2);
    const custom = page.getByRole('button', { name: 'Custom play' });
    await custom.click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toContainText('RT-DSPPLR by SAIT Digital');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { releaseA2(); releaseA2(); });
    await custom.click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('#b button').tap({ force: true }).catch(() => page.locator('#b button').click());
    await expect(page.getByRole('menuitem')).toBeVisible();
    await page.evaluate(() => releaseB());
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'About this player' })).toHaveCount(1);
    expect(await page.locator('#b').evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))).toBe(true);
});

test('right-click anywhere on the player opens the credit, whatever is under it; the page outside keeps its menu', async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    await page.evaluate(() => {
        const host = document.createElement('section');
        host.id = 'host';
        host.innerHTML = '<div id="own">own menu</div><a id="link" href="https://example.com/">link</a>'
            + '<input id="field" value="text"><p id="text">selectable words</p><button id="plain">Play</button>';
        document.body.append(host);
        window.seen = { own: 0, parent: 0 };
        document.getElementById('own').addEventListener('contextmenu', (event) => { event.preventDefault(); window.seen.own += 1; });
        document.body.addEventListener('contextmenu', () => { window.seen.parent += 1; });
        h.createAudioPlayer({ element: host });
    });
    const menu = page.getByRole('menu', { name: 'About this player' });
    const opens = async (locator, options = {}) => {
        await locator.click({ button: 'right', ...options });
        await expect(menu.getByRole('menuitem')).toContainText('RT-DSPPLR by SAIT Digital');
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
    };
    // A handler of the interface's own, a link, a text field, Shift, selected text: the credit all the same.
    for (const id of ['#own', '#link', '#field', '#plain']) await opens(page.locator(id));
    await opens(page.locator('#plain'), { modifiers: ['Shift'] });
    await page.locator('#text').selectText();
    await opens(page.locator('#text'));
    const seen = await page.evaluate(() => window.seen);
    expect(seen).toEqual({ own: 0, parent: 0 });
    // Outside the player the page's own handlers run as before.
    const outside = await page.evaluate(() => document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(outside).toBe(true);
    expect(await page.evaluate(() => window.seen.parent)).toBe(1);
});

test('playback needs a mounted interface element on the page', async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    const result = await page.evaluate(async () => {
        const rejects = promise => promise.then(() => false, error => /player\.mount\(element\)/.test(error.message));
        const p = h.createAudioPlayer({ stretcher: 'native', prewarmSpeeds: false });
        const bare = await rejects(p.play(h.buffer()));
        const autoplay = await rejects(p.load(h.buffer(), { autoplay: true }));
        const loaded = await p.load(h.buffer());
        const toggle = await rejects(p.toggle());
        const element = document.createElement('div');
        const release = p.mount(element);
        const detached = await rejects(p.play());
        document.body.append(element);
        const played = await p.play();
        await p.pause();
        release();
        const released = await rejects(p.play());
        p.dispose();
        return { bare, autoplay, loaded, toggle, detached, played, released };
    });
    expect(result).toEqual({ bare: true, autoplay: true, loaded: true, toggle: true, detached: true, played: true, released: true });
});

test('iframe binding uses its owner document and supports the non-popover fallback', async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    await page.evaluate(async () => {
        const frame = document.createElement('iframe');
        frame.srcdoc = '<section id="player"><button>Play</button></section>';
        const loaded = new Promise(resolve => frame.onload = resolve);
        document.body.append(frame);
        await loaded;
        frame.contentWindow.HTMLElement.prototype.showPopover = undefined;
        window.releaseFrame = h.createAudioPlayer().mount(frame.contentDocument.querySelector('#player'));
    });
    const frame = page.frameLocator('iframe');
    await frame.getByRole('button', { name: 'About this player' }).click();
    await expect(frame.getByRole('menuitem')).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.evaluate(() => releaseFrame());
    await expect(frame.getByRole('menu')).toHaveCount(0);
});

test('useAudioPlayer ref mounts a custom React interface and survives StrictMode', async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    await page.evaluate(() => { window.customRoot = h.mountCustom(); });
    const custom = page.getByRole('button', { name: 'Custom play' });
    await custom.click();
    await expect.poll(() => page.evaluate(() => customPlayer.getState().isPlaying)).toBe(true);
    await custom.click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toContainText('RT-DSPPLR by SAIT Digital');
    await page.keyboard.press('Escape');
    await page.evaluate(() => customRoot.unmount());
    await expect(page.getByRole('button', { name: 'About this player' })).toHaveCount(0);
});
