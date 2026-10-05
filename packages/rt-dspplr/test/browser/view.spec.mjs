// The timeline's view (zoom, pan) belongs to the clip: transport actions keep
// it, only another clip resets it. Both sources, createTimeline and the card.
import { test, expect } from '@playwright/test';

const BASE = '/node_modules/.cache/rtd-long';

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    await page.evaluate((base) => {
        window.longBase = base;
        /** Zoom label and the overview window's place: the view, as the page shows it. */
        window.viewOf = (root) => {
            const win = root.querySelector('.rtd-overview-window');
            return {
                zoom: root.querySelector('.rtd-zoom-reset')?.textContent ?? '',
                left: win ? parseFloat(win.style.left) : NaN,
                width: win ? parseFloat(win.style.width) : NaN,
            };
        };
        /** Zoom 2.25× and pan to start at ~30 % of the clip. */
        window.zoomAndPan = async (root) => {
            const track = root.querySelector('.rtd-scrub-track');
            track.focus();
            for (let i = 0; i < 2; i += 1) track.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
            for (let i = 0; i < 6; i += 1) {
                track.dispatchEvent(new WheelEvent('wheel', { deltaX: 120, bubbles: true, cancelable: true, clientX: 100, clientY: 10 }));
                if (viewOf(root).left >= 30) break;
            }
            await h.sleep(50);
        };
        window.transportSteps = async (player, clip, view) => {
            const d = player.getState().duration;
            const inside = (view.left / 100 + view.width / 200) * d; // the middle of the view
            const seen = [];
            const step = async (name, fn) => { await fn(); await h.sleep(150); seen.push([name, viewOf(window.viewRoot)]); };
            await step('seek inside', () => player.seek(inside));
            await step('play', () => player.play());
            await step('pause', () => player.pause());
            await step('play again', () => player.play());
            await step('pause again', () => player.pause());
            await step('seek', () => player.seek(inside + 0.5));
            await step('speed', () => player.setSpeed(1.5));
            await step('loop on', () => player.setLoop({ start: inside, end: inside + 1 }));
            await step('loop off', () => player.setLoop(null));
            await step('restart same clip', () => player.play(clip, { startAt: inside }));
            await step('stop playing', () => player.pause());
            return seen;
        };
    }, BASE);
});

for (const kind of ['buffer', 'segmented']) {
    test(`createTimeline keeps zoom/pan across transport (${kind}); another clip resets it`, async ({ page }) => {
        const result = await page.evaluate(async (kind) => {
            const ui = document.body.appendChild(document.createElement('div'));
            ui.style.width = '800px';
            const seek = ui.appendChild(document.createElement('div'));
            seek.style.height = '100px';
            window.viewRoot = seek;
            const player = h.createAudioPlayer({ element: ui, prewarmSpeeds: false, stretcher: 'native' });
            h.createTimeline(seek, player);
            const clip = kind === 'buffer' ? { src: `${longBase}/mono30.wav` } : { manifest: `${longBase}/mono30/manifest.json` };
            await player.load(clip);
            await h.sleep(200);
            await zoomAndPan(seek);
            const view = viewOf(seek);
            const seen = await transportSteps(player, clip, view);
            const other = kind === 'buffer' ? { src: `${longBase}/stereo70.wav` } : { manifest: `${longBase}/stereo70/manifest.json` };
            await player.load(other);
            await h.sleep(200);
            const after = viewOf(seek);
            player.dispose();
            return { view, seen, after };
        }, kind);
        expect(result.view.zoom).toMatch(/×/);
        expect(result.view.left).toBeGreaterThan(5);
        for (const [name, v] of result.seen) {
            expect(v.zoom, name).toBe(result.view.zoom);
            expect(v.width, name).toBeCloseTo(result.view.width, 3);
            expect(v.left, name).toBeCloseTo(result.view.left, 3);
        }
        expect(result.after.zoom).toBe(''); // the new clip shows whole
    });
}

for (const kind of ['buffer', 'segmented']) {
    test(`React card keeps zoom/pan across transport (${kind})`, async ({ page }) => {
        await page.evaluate((args) => h.mountCard(args.kind === 'buffer' ? { src: `${args.base}/mono30.wav` } : { manifest: `${args.base}/mono30/manifest.json` }, { stretcher: 'native' }), { kind, base: BASE });
        await page.waitForFunction(() => window.cardPlayer?.getState().duration > 0);
        const result = await page.evaluate(async (kind) => {
            const root = document.querySelector('.rtd');
            window.viewRoot = root;
            await h.sleep(200);
            await zoomAndPan(root);
            const view = viewOf(root);
            const clip = kind === 'buffer' ? { src: `${longBase}/mono30.wav` } : { manifest: `${longBase}/mono30/manifest.json` };
            const seen = await transportSteps(window.cardPlayer, clip, view);
            return { view, seen };
        }, kind);
        expect(result.view.zoom).toMatch(/×/);
        for (const [name, v] of result.seen) {
            expect(v.zoom, name).toBe(result.view.zoom);
            expect(v.left, name).toBeCloseTo(result.view.left, 3);
        }
    });
}
