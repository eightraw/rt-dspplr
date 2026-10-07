// Hardening of the interface and the effect chain: React StrictMode loads from
// child effects, the credit menu inside a modal dialog and a focus trap, the
// loop keys, the card's seek bar across the compact breakpoint, aria-controls,
// the spoken time, device pixel ratio changes, CSS colours in the spectrogram,
// coalesced waveform rebuilds, every form of a plugin's process() preview, and
// plugins that fail to dispose, failed plugins after an output rebuild, inline
// worklet code and click-free removal.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
});

// ---- React --------------------------------------------------------------------------------------

test('StrictMode: a child that loads from its own effect gets the clip, and it plays', async ({ page }) => {
    await page.evaluate(() => { window.childRoot = h.mountStrictChild(); });
    await page.waitForFunction(() => window.strictChildLoads?.length >= 2);
    const loaded = await page.evaluate(async () => {
        const results = await Promise.all(window.strictChildLoads);
        const s = strictChildPlayer.getState();
        return { last: results.at(-1), status: s.status, duration: s.duration, disposed: strictChildPlayer.disposed };
    });
    // The last load is the one after StrictMode's simulated remount.
    expect(loaded).toEqual({ last: true, status: 'ready', duration: 8, disposed: false });
    await page.getByRole('button', { name: 'Child play' }).click();
    await expect.poll(() => page.evaluate(() => strictChildPlayer.getState().isPlaying)).toBe(true);
    await expect.poll(() => page.evaluate(() => h.rms(strictChildPlayer))).toBeGreaterThan(0.02);
    await page.evaluate(() => childRoot.unmount());
    expect(await page.evaluate(() => strictChildPlayer.disposed)).toBe(true);
});

// ---- the credit menu ---------------------------------------------------------------------------

test('the credit menu works inside a modal <dialog>: visible, focused, clickable', async ({ page }) => {
    await page.evaluate(() => {
        const dialog = document.createElement('dialog');
        dialog.innerHTML = '<section id="dlg-player" style="width:320px;padding:24px"><button id="dlg-play">Play</button></section>';
        document.body.append(dialog);
        window.dlgPlayer = h.createAudioPlayer({ element: dialog.querySelector('#dlg-player') });
        dialog.showModal();
    });
    await page.locator('#dlg-play').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'About this player' });
    const credit = menu.getByRole('menuitem');
    await expect(credit).toBeVisible();
    await expect(credit).toBeFocused();
    // In the dialog's subtree (outside it everything is inert under a modal dialog).
    expect(await credit.evaluate((el) => !!el.closest('dialog'))).toBe(true);
    await credit.evaluate((el) => {
        window.creditClicks = 0;
        el.addEventListener('click', (event) => { event.preventDefault(); window.creditClicks += 1; });
    });
    // A real pointer click: Playwright checks that the link is what receives it.
    await credit.click();
    expect(await page.evaluate(() => window.creditClicks)).toBe(1);
    await expect(menu).toHaveCount(0);
    // The ⓘ button opens it there too.
    await page.getByRole('button', { name: 'About this player' }).click();
    await expect(credit).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
});

test('the credit menu works inside a focus trap with the page made unclickable (as modal libraries do)', async ({ page }) => {
    await page.evaluate(() => {
        document.body.style.pointerEvents = 'none';
        const trap = document.createElement('div');
        trap.id = 'trap';
        trap.style.pointerEvents = 'auto';
        trap.innerHTML = '<button id="first">First</button><section id="trap-player" style="width:320px"><button id="trap-play">Play</button></section>';
        document.body.append(trap);
        // Focus that leaves the trap is pulled back to its first element.
        document.addEventListener('focusin', (event) => { if (!trap.contains(event.target)) trap.querySelector('#first').focus(); });
        h.createAudioPlayer({ element: trap.querySelector('#trap-player') });
    });
    await page.locator('#trap-play').click({ button: 'right' });
    const credit = page.getByRole('menu', { name: 'About this player' }).getByRole('menuitem');
    await expect(credit).toBeVisible();
    await expect(credit).toBeFocused();
    await page.waitForTimeout(100);
    await expect(credit).toBeVisible();
    await credit.evaluate((el) => {
        window.creditClicks = 0;
        el.addEventListener('click', (event) => { event.preventDefault(); window.creditClicks += 1; });
    });
    await credit.click();
    expect(await page.evaluate(() => window.creditClicks)).toBe(1);
});

// ---- the timeline ------------------------------------------------------------------------------------

test('[ and ] set the loop at the playhead in a standalone timeline', async ({ page }) => {
    await page.evaluate(() => h.mountTimeline({}));
    await page.waitForFunction(() => window.timelinePlayer?.getState().duration > 0);
    const track = page.getByRole('slider', { name: 'Seek' });
    // Loop edges snap to zero crossings (loopSnapping): compared to the hundredth of a second.
    const loop = () => page.evaluate(() => {
        const l = timelinePlayer.getState().loop;
        return l && { start: Math.round(l.start * 100) / 100, end: Math.round(l.end * 100) / 100 };
    });
    const at = (t) => page.evaluate((t) => timelinePlayer.seek(t), t);
    await track.focus();
    await at(2);
    await page.keyboard.press('[');
    // No loop yet: from the playhead to the end of the clip.
    await expect.poll(loop).toEqual({ start: 2, end: 8 });
    await at(5);
    await page.keyboard.press(']');
    await expect.poll(loop).toEqual({ start: 2, end: 5 });
    // Past the other edge: that edge moves to the clip's end.
    await page.keyboard.press('[');
    await expect.poll(loop).toEqual({ start: 5, end: 8 });
    await page.keyboard.press('Escape');
    await expect.poll(loop).toBe(null);
});

test('the card keeps its seek bar (zoom, focus) across the compact breakpoint', async ({ page }) => {
    await page.evaluate(() => h.mountCard(h.buffer(8), { stretcher: 'native' }));
    await page.waitForFunction(() => window.cardPlayer?.getState().duration > 0);
    const track = page.locator('.rtd-scrub-track');
    await track.focus();
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await expect(page.locator('.rtd-scrub[data-zoomed]')).toHaveCount(1);
    await track.evaluate((el) => { el.dataset.marker = 'kept'; });
    for (const [width, layout] of [[360, 'compact'], [720, 'full']]) {
        await page.evaluate((width) => { document.querySelector('.rtd').parentElement.style.width = `${width}px`; }, width);
        await expect(page.locator('.rtd')).toHaveAttribute('data-layout', layout);
        const kept = await page.evaluate(() => {
            const el = document.querySelector('.rtd-scrub-track');
            return { marker: el.dataset.marker, focused: document.activeElement === el, zoomed: !!document.querySelector('.rtd-scrub[data-zoomed]') };
        });
        expect(kept).toEqual({ marker: 'kept', focused: true, zoomed: true });
    }
});

for (const layout of ['full', 'compact']) {
    test(`${layout}: aria-controls names the panel only while it is open`, async ({ page }) => {
        await page.evaluate((layout) => h.mountMenu(layout), layout);
        const button = page.getByRole('button', { name: layout === 'compact' ? 'Player settings' : 'Post FX' });
        await expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(await button.getAttribute('aria-controls')).toBe(null);
        await button.click();
        await expect(button).toHaveAttribute('aria-expanded', 'true');
        const id = await button.getAttribute('aria-controls');
        expect(id).toBeTruthy();
        expect(await page.evaluate((id) => !!document.getElementById(id), id)).toBe(true);
        await button.click();
        await expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(await button.getAttribute('aria-controls')).toBe(null);
    });
}

test('the slider reads 119.96 s as 2 minutes, not 1 minute 60 seconds', async ({ page }) => {
    await page.evaluate(async () => {
        const ui = document.body.appendChild(document.createElement('div'));
        ui.style.width = '600px';
        const box = ui.appendChild(document.createElement('div'));
        box.style.height = '80px';
        window.longPlayer = h.createAudioPlayer({ element: ui, stretcher: 'native', prewarmSpeeds: false });
        h.createTimeline(box, longPlayer, {});
        await longPlayer.load(h.buffer(130));
        await longPlayer.seek(119.96);
    });
    await expect(page.getByRole('slider', { name: 'Seek' })).toHaveAttribute('aria-valuetext', '2 minutes 0 seconds of 2 minutes 10 seconds');
});

test('the waveform is redrawn for a new device pixel ratio while its CSS size stays', async ({ page }) => {
    await page.evaluate(() => {
        const ui = document.body.appendChild(document.createElement('div'));
        ui.style.width = '600px';
        const box = ui.appendChild(document.createElement('div'));
        box.style.height = '80px';
        const player = h.createAudioPlayer({ element: ui, stretcher: 'native', prewarmSpeeds: false });
        h.createTimeline(box, player, { ruler: false });
        window.dprCanvas = box.querySelector('canvas.rtd-wave');
        return player.load(h.buffer(4));
    });
    await page.waitForFunction(() => dprCanvas.width > 0 && dprCanvas.width === dprCanvas.clientWidth);
    const viewport = page.viewportSize();
    const cdp = await page.context().newCDPSession(page);
    // Chromium re-evaluates media queries on a viewport change: the 1 px nudge delivers the
    // resolution change; the timeline's box keeps its CSS size, so no ResizeObserver fires.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 2, mobile: false });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width + 1, height: viewport.height, deviceScaleFactor: 2, mobile: false });
    await expect.poll(() => page.evaluate(() => [devicePixelRatio, dprCanvas.width / dprCanvas.clientWidth])).toEqual([2, 2]);
    // Armed again for the next change.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
    await expect.poll(() => page.evaluate(() => [devicePixelRatio, dprCanvas.width / dprCanvas.clientWidth])).toEqual([1, 1]);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
});

test('the spectrogram paints any CSS colour, not only hex', async ({ page }) => {
    const painted = await page.evaluate(() => {
        const one = (color) => {
            const target = new ImageData(2, 1);
            // A silent cell (the background) and one at the reference level (the peak colour).
            h.advanced.paintSpectrogram(target, { columns: 2, rows: 1, magA: new Float32Array([0, 1]), magB: null }, [1, 0],
                { colorMode: 'single', floorDb: 60, palette: { background: color, peak: color, colorA: color, colorB: color, colorMix: color } }, 1);
            return [[...target.data.slice(0, 3)].join(','), [...target.data.slice(4, 7)].join(',')];
        };
        return Object.fromEntries(['#0a0b0c', 'rgb(1, 2, 3)', 'red', 'hsl(120 100% 25%)', '#f008', 'color(srgb 0 0.5 1)', 'not-a-colour'].map((c) => [c, one(c)]));
    });
    expect(painted['#0a0b0c']).toEqual(['10,11,12', '10,11,12']);
    expect(painted['rgb(1, 2, 3)']).toEqual(['1,2,3', '1,2,3']);
    expect(painted.red).toEqual(['255,0,0', '255,0,0']);
    expect(painted['hsl(120 100% 25%)']).toEqual(['0,128,0', '0,128,0']);
    expect(painted['#f008']).toEqual(['255,0,0', '255,0,0']);
    expect(painted['color(srgb 0 0.5 1)'][0]).toMatch(/^0,12[78],255$/);
    expect(painted['not-a-colour']).toEqual(['0,0,0', '0,0,0']);
});

// ---- the waveform preview ------------------------------------------------------------------------

/** In the page: the processed peak of an analyzer's latest result, and how many results came. */
const analyzerHelpers = () => {
    window.peakOf = (pyramid) => {
        const level = pyramid.levels[0];
        let peak = 0;
        for (let i = 0; i < level.maxPeaks.length; i += 1) peak = Math.max(peak, level.maxPeaks[i], -level.minPeaks[i]);
        return peak;
    };
    window.processing = (outputGain, stages = null) => ({ inputGain: 1, highPassHz: 0, compression: 0, outputGain, mix: 0, stages, key: `${outputGain}|${JSON.stringify(stages)}` });
};

test('knob moves while the waveform is rebuilt do not queue up: the latest settings win', async ({ page }) => {
    await page.evaluate(analyzerHelpers);
    const r = await page.evaluate(async () => {
        const updates = [];
        const analyzer = new h.advanced.WaveformAnalyzer((p) => updates.push(p.processed ? peakOf(p.processed) : null));
        analyzer.setBuffers(h.buffer(60), null, processing(1));
        // 30 moves while the clip is analysed: only the last is built.
        for (let i = 1; i <= 30; i += 1) analyzer.setProcessing(processing(0.5 + i / 30));
        const t0 = performance.now();
        while (updates.length < 2 && performance.now() - t0 < 8000) await h.sleep(20);
        await h.sleep(500);
        analyzer.dispose();
        return updates;
    });
    expect(r.length).toBe(2);
    expect(r[0]).toBeCloseTo(0.1, 2);
    expect(r[1]).toBeCloseTo(0.15, 2); // 0.1 × (0.5 + 30/30)
});

test('every form of a process() preview runs in the worker; one that does not compile is left out', async ({ page }) => {
    await page.evaluate(analyzerHelpers);
    const halve = 'for (const c of ch) for (let i = 0; i < c.length; i++) c[i] *= 0.5;';
    const forms = {
        function: `function process(ch) { ${halve} }`,
        'arrow with a default that calls': `(ch, sr = Number(1)) => { ${halve} }`,
        method: `process(ch) { ${halve} }`,
        'quoted method': `'process'(ch) { ${halve} }`,
        'computed method': `['process'](ch) { ${halve} }`,
        'not code': 'this is not ( javascript',
    };
    const r = await page.evaluate(async (forms) => {
        const out = {};
        let latest = null;
        const analyzer = new h.advanced.WaveformAnalyzer((p) => { latest = p.processed; });
        analyzer.setBuffers(h.buffer(2), null, processing(1));
        const t0 = performance.now();
        while (!latest && performance.now() - t0 < 4000) await h.sleep(10);
        out.loaded = latest ? peakOf(latest) : null;
        for (const [name, code] of Object.entries(forms)) {
            latest = null;
            analyzer.setProcessing(processing(1, [{ kind: 'process', id: name, code, params: {}, level: false }]));
            const t0 = performance.now();
            while (!latest && performance.now() - t0 < 4000) await h.sleep(10);
            out[name] = latest ? peakOf(latest) : null;
        }
        analyzer.dispose();
        return out;
    }, forms);
    expect(r.loaded).toBeCloseTo(0.1, 3);
    for (const name of Object.keys(forms).filter((n) => n !== 'not code')) expect(r[name], name).toBeCloseTo(0.05, 3);
    expect(r['not code']).toBeCloseTo(0.1, 3);
});

test('previewCoverage: an async process() is left out at once; one that does not compile once the worker says so', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const ui = document.body.appendChild(document.createElement('div'));
        ui.style.width = '600px';
        const box = ui.appendChild(document.createElement('div'));
        box.style.height = '80px';
        const player = h.createAudioPlayer({ element: ui, stretcher: 'native', prewarmSpeeds: false, processing: { highPassHz: 0, compression: 0 } });
        h.createTimeline(box, player, {});
        const pass = { kind: 'nodes', create(ctx) { const g = ctx.createGain(); return { input: g, output: g, setParam() {}, dispose() { g.disconnect(); } }; } };
        const plugin = (name, process) => ({ id: `t.${name}`, name, version: '1', params: [], realtime: pass, preview: { process } });
        // (Without a magnitude response every plugin is missing from a prepared clip's overview: the flags tell.)
        const flags = () => { const c = player.getState().previewCoverage; return { waveform: c.waveform, spectrogram: c.spectrogram }; };
        await player.load(h.buffer(2));
        const good = player.effects.add(plugin('Good', { process(ch) { for (const c of ch) for (let i = 0; i < c.length; i++) c[i] *= 0.5; } }.process));
        const withGood = flags();
        const asyncId = player.effects.add(plugin('Async', { async process(ch) { for (const c of ch) c.fill(0); } }.process));
        const withAsync = flags();
        player.effects.remove(asyncId);
        player.effects.remove(good);
        const broken = function (ch) {};
        broken.toString = () => 'this is not ( javascript';
        player.effects.add(plugin('Broken', broken));
        const brokenBefore = flags();
        const t0 = performance.now();
        while (player.getState().previewCoverage.waveform && performance.now() - t0 < 5000) await h.sleep(20);
        const brokenAfter = flags();
        player.dispose();
        return { withGood, withAsync, brokenBefore, brokenAfter };
    });
    expect(r.withGood).toEqual({ waveform: true, spectrogram: true });
    expect(r.withAsync).toEqual({ waveform: false, spectrogram: false });
    expect(r.brokenBefore).toEqual({ waveform: true, spectrogram: true });
    // Needs AudioPlayerCore.refreshPreviewCoverage (the worker's report reaches the state through it).
    expect(r.brokenAfter).toEqual({ waveform: false, spectrogram: false });
});

// ---- the effect chain ------------------------------------------------------------------------------------

test('a plugin whose dispose() throws: remove() and dispose() go on, report it, and the player plays after reactivate()', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const throwing = (id) => ({
            id, name: id, version: '1', params: [],
            realtime: { kind: 'nodes', create(ctx) { const g = ctx.createGain(); return { input: g, output: g, setParam() {}, dispose() { g.disconnect(); throw new Error('dispose boom'); } }; } },
        });
        const p = h.make();
        const errors = [];
        p.on('effecterror', (e) => errors.push(e));
        await p.play(h.buffer(8));
        const a = p.effects.add(throwing('Thrower A'));
        p.effects.add(throwing('Thrower B'));
        await h.sleep(200);
        let removeThrew = false;
        try { p.effects.remove(a); } catch { removeThrew = true; }
        await h.sleep(300);
        const afterRemove = { rms: h.rms(p), errors: errors.map((e) => e.message) };
        let disposeThrew = false;
        try { p.dispose(); } catch { disposeThrew = true; }
        p.reactivate();
        await p.play(h.buffer(8));
        await h.sleep(300);
        const replay = { playing: p.getState().isPlaying, rms: h.rms(p) };
        p.dispose();
        return { removeThrew, disposeThrew, afterRemove, replay };
    });
    expect(r.removeThrew).toBe(false);
    expect(r.afterRemove.errors).toEqual([expect.stringMatching(/Thrower A: dispose\(\) threw: dispose boom/)]);
    expect(r.afterRemove.rms).toBeGreaterThan(0.02);
    expect(r.disposeThrew).toBe(false);
    expect(r.replay.playing).toBe(true);
    expect(r.replay.rms).toBeGreaterThan(0.02);
});

test('a failed plugin is not instantiated again by an output rebuild, and un-bypassing leaves it out', async ({ page }) => {
    const r = await page.evaluate(async () => {
        let creates = 0;
        // Fails the first time; a second instance would mute the output.
        const flaky = {
            id: 'test.flaky', name: 'Flaky', version: '1', params: [],
            realtime: { kind: 'nodes', create(ctx) { creates += 1; if (creates === 1) throw new Error('first create fails'); const g = ctx.createGain(); g.gain.value = 0; return { input: g, output: g, setParam() {}, dispose() { g.disconnect(); } }; } },
        };
        const p = h.make();
        await p.play(h.buffer(8));
        const id = p.effects.add(flaky);
        await h.sleep(100);
        const error = p.getState().effects.find((e) => e.id === id).error;
        // An output rebuild: the chain is made again from the state.
        p.dispose();
        p.reactivate();
        await p.play(h.buffer(8));
        await h.sleep(100);
        p.effects.bypass(id, true);
        p.effects.bypass(id, false);
        await h.sleep(300);
        const result = { error, creates, rms: h.rms(p) };
        p.dispose();
        return result;
    });
    expect(r.error).toMatch(/first create fails/);
    // Needs AudioPlayer to pass the effect's failure to EffectChain.add (its 6th argument).
    expect(r.creates).toBe(1);
    expect(r.rms).toBeGreaterThan(0.02);
});

test('inline worklet code is keyed by the code: two plugins with one id and version each get their own', async ({ page }) => {
    const r = await page.evaluate(async () => {
        const worklet = (name) => ({
            id: 'test.same', name, version: '1', params: [],
            realtime: {
                kind: 'worklet', processorName: `test-${name}`,
                moduleCode: `registerProcessor('test-${name}', class extends AudioWorkletProcessor {
                    process(inputs, outputs) { const i = inputs[0], o = outputs[0]; for (let c = 0; c < o.length; c++) if (i[c]) o[c].set(i[c]); return true; }
                });`,
            },
        });
        const p = h.make();
        const errors = [];
        p.on('effecterror', (e) => errors.push(e.message));
        await p.play(h.buffer(4));
        p.effects.add(worklet('one'));
        p.effects.add(worklet('two'));
        await h.sleep(500);
        const result = { errors, failed: p.getState().effects.filter((e) => e.error).length, rms: h.rms(p) };
        p.dispose();
        return result;
    });
    expect(r.errors).toEqual([]);
    expect(r.failed).toBe(0);
    expect(r.rms).toBeGreaterThan(0.02);
});

test('remove() crossfades the effect out before it leaves the graph', async ({ page }) => {
    const r = await page.evaluate(async () => {
        let disposed = 0;
        const mute = {
            id: 'test.mute', name: 'Mute', version: '1', params: [],
            realtime: { kind: 'nodes', create(ctx) { const g = ctx.createGain(); g.gain.value = 0; return { input: g, output: g, setParam() {}, dispose() { disposed += 1; g.disconnect(); } }; } },
        };
        const p = h.make();
        await p.play(h.buffer(8));
        const id = p.effects.add(mute);
        await h.sleep(300);
        const muted = h.rms(p);
        p.effects.remove(id);
        const disposedAtOnce = disposed;
        const inState = p.getState().effects.some((e) => e.id === id);
        await h.sleep(300);
        const result = { muted, disposedAtOnce, inState, disposedLater: disposed, rms: h.rms(p) };
        p.dispose();
        return result;
    });
    expect(r.muted).toBeLessThan(0.001);
    expect(r.inState).toBe(false);
    // Still wired while it fades to dry; disposed once the ramp is over.
    expect(r.disposedAtOnce).toBe(0);
    expect(r.disposedLater).toBe(1);
    expect(r.rms).toBeGreaterThan(0.02);
});
