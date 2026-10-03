import { test, expect } from '@playwright/test';

const open = async (page) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
};
const aboutButton = (page) => page.getByRole('button', { name: 'About this player' });

test('the card keeps its ⓘ button in its own slot, through a change of layout', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { window.menuRoot = h.mountMenu('full'); });
    await expect(page.locator('.rtd-head [data-rtd-credit] .rtd-attribution-button')).toHaveCount(1);
    await page.evaluate(() => h.renderMenu(menuRoot, 'compact'));
    await expect(page.locator('.rtd-row [data-rtd-credit] .rtd-attribution-button')).toHaveCount(1);
    await expect(aboutButton(page)).toHaveCount(1);
    await page.evaluate(() => h.renderMenu(menuRoot, 'full'));
    await expect(page.locator('.rtd-head [data-rtd-credit] .rtd-attribution-button')).toHaveCount(1);
    await aboutButton(page).click();
    await expect(page.getByRole('menuitem')).toContainText('RT-DSPPLR by SAIT Digital');
});

test('a custom interface: the button sits over its corner, or in its slot, without moving its layout', async ({ page }) => {
    await open(page);
    const result = await page.evaluate(() => {
        const host = document.createElement('section');
        host.style.cssText = 'display:flex;width:400px;height:60px';
        host.innerHTML = '<button style="flex:1">Custom play</button>';
        document.body.append(host);
        const width = () => host.firstElementChild.getBoundingClientRect().width;
        const before = width();
        const release = h.createAudioPlayer().mount(host);
        const button = host.querySelector('.rtd-attribution-button');
        const overlay = { position: getComputedStyle(button).position, hostPosition: host.style.position, widthKept: width() === before };
        const box = button.getBoundingClientRect(), hostBox = host.getBoundingClientRect();
        overlay.inCorner = box.right <= hostBox.right && box.right > hostBox.right - 12 && box.top >= hostBox.top && box.top < hostBox.top + 12;
        release();
        overlay.hostPositionAfter = host.style.position;

        const slotted = document.createElement('section');
        slotted.innerHTML = '<header><span>Title</span><span data-rtd-credit></span></header><button>Play</button>';
        document.body.append(slotted);
        const releaseSlotted = h.createAudioPlayer().mount(slotted);
        const inSlot = slotted.querySelector('[data-rtd-credit] > .rtd-attribution-button') !== null;
        const slotPosition = getComputedStyle(slotted.querySelector('.rtd-attribution-button')).position;
        releaseSlotted();
        return { overlay, inSlot, slotPosition, untouched: slotted.style.position === '' };
    });
    expect(result).toEqual({
        overlay: { position: 'absolute', hostPosition: 'relative', widthKept: true, inCorner: true, hostPositionAfter: '' },
        inSlot: true,
        slotPosition: 'relative',
        untouched: true,
    });
});

test("infoButton 'touch': right-click only with a mouse, the button on a touch device", async ({ page, browser }) => {
    await open(page);
    await page.evaluate(() => h.mountMenu('full', { infoButton: 'touch' }));
    await page.waitForSelector('.rtd-attribution-button', { state: 'attached' });
    await expect(aboutButton(page)).toBeHidden();
    await expect(page.locator('.rtd-credit')).toBeHidden();
    await page.locator('.rtd').click({ button: 'right', position: { x: 30, y: 30 } });
    await expect(page.getByRole('menuitem')).toContainText('RT-DSPPLR by SAIT Digital');

    const phone = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });
    const touch = await phone.newPage();
    await open(touch);
    await touch.evaluate(() => h.mountMenu('compact', { infoButton: 'touch' }));
    await expect(aboutButton(touch)).toBeVisible();
    await aboutButton(touch).tap();
    await expect(touch.getByRole('menuitem')).toContainText('RT-DSPPLR by SAIT Digital');
    await phone.close();
});
