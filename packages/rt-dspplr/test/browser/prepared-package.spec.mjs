// A prepared folder plays in the player: segments, overview, and its named stems.
// By default the folder is the pairNamed fixture (made by the workspace's prepare
// package). `npm run test:package -w packages/rt-dspplr-prepare` runs this spec
// again with RTD_PACKAGE_FIXTURE set to the output of the packed CLI installed
// in an isolated consumer (copied under node_modules/.cache/rtd-long/).
import { test, expect } from '@playwright/test';

const BASE = '/node_modules/.cache/rtd-long';
const FIXTURE = process.env.RTD_PACKAGE_FIXTURE ?? 'pairNamed';

test(`prepared folder "${FIXTURE}" plays: overview, audio, every ready stem`, async ({ page }) => {
    await page.goto('/test/browser/index.html');
    await page.waitForFunction(() => window.h);
    const r = await page.evaluate(async (url) => {
        const ui = document.body.appendChild(document.createElement('div'));
        const seek = ui.appendChild(document.createElement('div'));
        seek.style.height = '80px';
        ui.style.width = '800px';
        const player = h.createAudioPlayer({ element: ui, prewarmSpeeds: false, stretcher: 'native', processing: { highPassHz: 0, compression: 0 } });
        h.createTimeline(seek, player);
        const level = async () => { let s = 0; for (let i = 0; i < 20; i += 1) { s += h.rms(player) ** 2; await h.sleep(25); } return 10 * Math.log10(s / 20 + 1e-20); };
        const ok = await player.play({ manifest: url });
        const t0 = player.getCurrentTime();
        await h.sleep(600);
        const state = player.getState();
        const out = {
            ok, status: state.status, kind: state.sourceKind, playing: state.isPlaying, moved: player.getCurrentTime() - t0,
            peaks: !!player.getPeakPyramid(), level: await level(), stems: state.capabilities.stems.map((s) => s.key), stemLevels: {},
        };
        player.setMix(1);
        for (const key of out.stems) {
            player.setStem(key);
            await h.sleep(700);
            out.stemLevels[key] = await level();
        }
        out.underruns = player.getStreamStats().underruns;
        player.dispose();
        return out;
    }, `${BASE}/${FIXTURE}/manifest.json`);
    console.log(`prepared ${FIXTURE}:`, JSON.stringify(r));
    expect(r.ok).toBe(true);
    expect(r.status).toBe('ready');
    expect(r.kind).toBe('segmented');
    expect(r.playing).toBe(true);
    expect(r.moved).toBeGreaterThan(0.3);
    expect(r.peaks).toBe(true);
    expect(r.level).toBeGreaterThan(-40);
    expect(r.stems.length).toBeGreaterThan(0);
    for (const key of r.stems) expect(r.stemLevels[key]).toBeGreaterThan(-40);
    expect(r.underruns).toBe(0);
});
