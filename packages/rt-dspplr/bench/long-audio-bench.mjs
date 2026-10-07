#!/usr/bin/env node
// Long-audio benchmark: plays big files in Chromium (Playwright) and measures
// time to UI ready (waveform drawn), time to first audio, seek latency, and
// memory, for the normal (whole-file decode) mode and the manifest mode.
//
//   node bench/long-audio-bench.mjs --dir <folder> [--mode buffer|stream|both] [--only name] [--out results.json] [--mbps 50 --rtt 40]
//
// <folder> holds <name>.wav sources and, for the manifest mode, <name>/manifest.json
// (from `rtd-prepare`, the package's ./prepare). Needs a built dist/
// (npm run build:lib); the internals it measures directly are bundled from
// src/ by bench/internals.ts at start. Each run gets a
// fresh browser; memory is the summed private bytes of every browser process
// (sampled every 250 ms with PowerShell on Windows, /proc elsewhere is not wired)
// plus the page's JS heap from the DevTools protocol.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The internals (segment engine, approximate preview...) are not exported by the
// package: bundle them from src/, with the inline worker/worklet imports the
// library build uses (as Blob-URL strings).
const internalsFile = path.join(root, 'node_modules', '.cache', 'rtd-bench', 'internals.js');
const inlineWorkers = {
    name: 'inline-workers',
    setup(b) {
        b.onResolve({ filter: /\?inline-(worker|worklet)$/ }, (a) => ({ path: path.resolve(a.resolveDir, a.path.replace(/\?inline-(worker|worklet)$/, '')), namespace: a.path.endsWith('worker') ? 'inline-worker' : 'inline-worklet' }));
        b.onLoad({ filter: /.*/, namespace: 'inline-worker' }, async (a) => ({ contents: await inlined(a.path, 'worker'), loader: 'js' }));
        b.onLoad({ filter: /.*/, namespace: 'inline-worklet' }, async (a) => ({ contents: await inlined(a.path, 'worklet'), loader: 'js' }));
    },
};
async function inlined(file, kind) {
    const r = await build({ entryPoints: [file], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020', minify: true, logLevel: 'silent' });
    const code = JSON.stringify(r.outputFiles[0].text);
    return kind === 'worker'
        ? `const code = ${code}; let url = null; export default function createWorker() { url ??= URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); return new Worker(url); }`
        : `const code = ${code}; let url = null; export default function getWorkletUrl() { url ??= URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); return url; }`;
}
await build({
    entryPoints: [path.join(root, 'bench', 'internals.ts')],
    outfile: internalsFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'warning',
    define: { __RTD_VERSION__: JSON.stringify('bench') },
    plugins: [inlineWorkers],
});
const args = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const dir = path.resolve(arg('dir', process.env.LONG_AUDIO_DIR ?? '.'));
const mode = arg('mode', 'both');
const only = arg('only', null);
const outFile = arg('out', null);
// Optional network emulation, e.g. --mbps 50 --rtt 40 (a decent office/home link).
const mbps = Number(arg('mbps', '0'));
const rtt = Number(arg('rtt', '0'));
const SEEK_TARGETS = [0.71, 0.13, 0.42, 0.93, 0.05];

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.wav': 'audio/wav', '.bin': 'application/octet-stream', '.map': 'application/json' };

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/dist/styles.css"></head>
<body><div id="ui" style="width:1000px"><div id="seek" style="height:120px"></div><div id="spec" style="height:120px"></div></div>
<script type="module">
import * as api from '/dist/index.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
function rms(analyser) {
    const d = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(d);
    let s = 0; for (const v of d) s += v * v; return Math.sqrt(s / d.length);
}
function drawn() {
    for (const c of document.querySelectorAll('#seek canvas')) {
        if (!c.width || !c.height) continue;
        const g = c.getContext('2d'); if (!g) continue;
        const px = g.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < px.length; i += 4 * 7) if (px[i] > 0) return true;
    }
    return false;
}
async function until(fn, timeout = 600000, step = 5) {
    const t0 = now();
    while (now() - t0 < timeout) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
}
function spectrogramDrawn() {
    const c = document.querySelector('#spec canvas.rtd-spectrogram');
    if (!c || !c.width) return false;
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < px.length; i += 4 * 5) if (px[i] + px[i + 1] + px[i + 2] > 200) return true;
    return false;
}
window.run = async ({ mode, url }) => {
    const ui = document.getElementById('ui');
    // One player core for both: a manifest clip plays through the segmented source.
    const player = api.createAudioPlayer({ element: ui });
    const tl = api.createTimeline(document.getElementById('seek'), player);
    const spec = api.createTimeline(document.getElementById('spec'), player, { display: 'spectrogram', ruler: false });
    const r = { mode };
    const t0 = now();
    const playing = player.play(mode === 'stream' ? { manifest: url } : url);
    const uiReady = until(() => drawn() && now()).then((t) => { r.uiReadyMs = t - t0; });
    const specReady = until(() => spectrogramDrawn() && now(), 120000).then((t) => { r.spectrogramMs = t ? t - t0 : null; });
    await until(() => player.analyser && rms(player.analyser) > 1e-4 && now()).then((t) => { r.firstAudioMs = t - t0; });
    await playing;
    await uiReady;
    await specReady;
    spec.dispose();
    if (player.getState().status === 'error') r.error = String(player.getState().error);
    r.duration = player.getState().duration;
    await sleep(3000);
    r.seeks = [];
    for (const f of ${JSON.stringify(SEEK_TARGETS)}) {
        const target = f * r.duration;
        const s0 = now();
        await player.seek(target);
        const t = await until(() => player.getCurrentTime() > target + 0.02 && rms(player.analyser) > 1e-4 && now(), 20000, 2);
        r.seeks.push(t ? t - s0 : null);
        await sleep(1500);
    }
    r.timeAfter = player.getCurrentTime();
    r.stats = player.getStreamStats();
    window.__player = player; window.__tl = tl;
    return r;
};
// Approximate (stored peaks + bands) vs exact (peaks worker over the decoded file)
// processed waveform, per drawn column: RMS and peak differences in dB.
window.approxError = async ({ wav, manifest, settings, windows }) => {
    const adv = await import('/internals.js');
    const ui = document.getElementById('ui');
    const a = api.createAudioPlayer({ element: ui, prewarmSpeeds: false, stretcher: 'native' });
    const b = api.createAudioPlayer({ element: ui });
    await a.load({ src: wav });
    await b.load({ manifest });
    await until(() => b.getState().prepared?.peaks?.levels[0]?.binSize === 256 && b.getState().prepared?.bands, 60000);
    const buffer = a.getState().buffer;
    const prepared = b.getState().prepared;
    const sr = b.getState().manifest.sampleRate;
    const out = [];
    for (const s of settings) {
        const processing = { highPassHz: s.hp ?? 0, compression: s.comp ?? 0, outputGain: 10 ** ((s.gainDb ?? 0) / 20), mix: 0 };
        const exact = await new Promise((resolve) => {
            const an = new adv.WaveformAnalyzer(({ processed }) => { if (processed) { an.dispose(); resolve(processed); } });
            an.setBuffers(buffer, null, processing);
        });
        const t0 = now();
        const approx = adv.approximateProcessedPyramid(prepared.peaks, prepared.bands, processing, sr);
        const approxMs = now() - t0;
        // Per 256-frame bin (the stored grid; the exact pyramid has the same bins), where the exact RMS is above -50 dBFS.
        {
            const le = exact.levels.find((l) => l.binSize === 256), la = approx.levels[0];
            const db = (v) => 20 * Math.log10(Math.max(v, 1e-9));
            const re = [], pe = [];
            let bias = 0;
            const n = Math.min(le.rmsPeaks.length, la.rmsPeaks.length);
            for (let i = 0; i < n; i += 1) {
                if (db(le.rmsPeaks[i]) < -50) continue;
                re.push(Math.abs(db(la.rmsPeaks[i]) - db(le.rmsPeaks[i])));
                bias += db(la.rmsPeaks[i]) - db(le.rmsPeaks[i]);
                pe.push(Math.abs(db(Math.max(-la.minPeaks[i], la.maxPeaks[i])) - db(Math.max(-le.minPeaks[i], le.maxPeaks[i]))));
            }
            bias /= Math.max(1, re.length);
            const mean = (x) => x.reduce((p, q) => p + q, 0) / Math.max(1, x.length);
            const p95 = (x) => { const y = [...x].sort((p, q) => p - q); return y[Math.floor(y.length * 0.95)] ?? 0; };
            out.push({ setting: s.name, window: 'bins@256', columns: re.length, approxMs, rmsMean: mean(re), rmsP95: p95(re), rmsMax: re.reduce((m, v) => Math.max(m, v), 0), rmsBias: bias, peakMean: mean(pe), peakP95: p95(pe) });
        }
        for (const w of windows) {
            const start = Math.round(w.start * sr), end = Math.round(Math.min(w.end, buffer.duration) * sr);
            const ce = adv.resolveColumns(exact, start, end, 1000);
            const ca = adv.resolveColumns(approx, start, end, 1000);
            const db = (v) => 20 * Math.log10(Math.max(v, 1e-9));
            const rmsErr = [], peakErr = [];
            for (let i = 0; i < 1000; i += 1) {
                if (db(ce.rms[i]) < -50) continue; // silence: nothing to see
                rmsErr.push(Math.abs(db(ca.rms[i]) - db(ce.rms[i])));
                const pe = Math.max(Math.abs(ce.min[i]), Math.abs(ce.max[i]));
                const pa = Math.max(Math.abs(ca.min[i]), Math.abs(ca.max[i]));
                peakErr.push(Math.abs(db(pa) - db(pe)));
            }
            const mean = (x) => x.reduce((p, q) => p + q, 0) / Math.max(1, x.length);
            const p95 = (x) => { const y = [...x].sort((p, q) => p - q); return y[Math.floor(y.length * 0.95)] ?? 0; };
            out.push({ setting: s.name, window: w.name, columns: rmsErr.length, approxMs,
                rmsMean: mean(rmsErr), rmsP95: p95(rmsErr), rmsMax: rmsErr.reduce((m, v) => Math.max(m, v), 0),
                peakMean: mean(peakErr), peakP95: p95(peakErr) });
        }
    }
    a.dispose();
    b.dispose();
    return out;
};
// Realtime stretch through the stream engine, offline: input as base64 Float32 (mono, 48 kHz).
window.stretchRender = async ({ input, rate }) => {
    const adv = await import('/internals.js');
    const bytes = Uint8Array.from(atob(input), (c) => c.charCodeAt(0));
    const x = new Float32Array(bytes.buffer);
    const sr = 48000;
    const lead = 256;
    const outLen = Math.floor(x.length / rate);
    const ctx = new OfflineAudioContext(1, lead + outLen, sr);
    await adv.loadStreamEngine(ctx, true);
    await adv.stretchAvailable(ctx);
    const seg = 480000;
    const starts = [0];
    for (let o = 0; o < x.length; o += seg) starts.push(Math.min(x.length, o + seg));
    const engine = new adv.StreamEngine(ctx, { channels: 1, starts, stretch: true });
    engine.node.connect(ctx.destination);
    for (let i = 0; i + 1 < starts.length; i += 1) engine.feed('a', i, [x.slice(starts[i], starts[i + 1])]);
    engine.setRate(rate);
    let renderStart = 0;
    ctx.suspend(lead / sr).then(async () => {
        const t = performance.now();
        while (!engine.stretch.ready && performance.now() - t < 20000) await sleep(5);
        engine.play(0);
        await sleep(60);
        renderStart = performance.now();
        ctx.resume();
    });
    const rendered = await ctx.startRendering();
    const wall = performance.now() - renderStart;
    const out = rendered.getChannelData(0).slice(lead);
    const b = new Uint8Array(out.buffer);
    let str = '';
    for (let i = 0; i < b.length; i += 0x8000) str += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return { output: btoa(str), wallMs: wall, latencyFrames: engine.stretch.latencyFrames, ready: engine.stretch.ready };
};
window.ready = true;
</script></body></html>`;

function serve() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let file;
        if (url.pathname === '/bench.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(PAGE);
            return;
        }
        if (url.pathname.startsWith('/dist/')) file = path.join(root, decodeURIComponent(url.pathname));
        else if (url.pathname === '/internals.js') file = internalsFile;
        else if (url.pathname.startsWith('/audio/')) file = path.join(dir, decodeURIComponent(url.pathname.slice(7)));
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404);
            res.end();
            return;
        }
        const size = fs.statSync(file).size;
        const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
            res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
            fs.createReadStream(file, { start, end }).pipe(res);
            return;
        }
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Samples the summed private bytes of Playwright's browser processes. */
function memorySampler() {
    let peak = 0;
    let last = 0;
    if (process.platform !== 'win32') return { stop: () => ({ peak: NaN, last: NaN }), current: () => NaN };
    const ps = spawn('powershell', ['-NoProfile', '-Command',
        "while($true){ $p = Get-Process | Where-Object { $_.Path -like '*ms-playwright*' -or $_.Path -like '*pw-browsers*' }; "
        + "$s = ($p | Measure-Object -Property PrivateMemorySize64 -Sum).Sum; [Console]::Out.WriteLine([string]$s); [Console]::Out.Flush(); Start-Sleep -Milliseconds 250 }"]);
    ps.stdout.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
            const v = Number(line.trim());
            if (Number.isFinite(v) && v > 0) {
                last = v;
                peak = Math.max(peak, v);
            }
        }
    });
    return {
        current: () => last,
        resetPeak: () => { peak = last; },
        stop: () => { ps.kill(); return { peak, last }; },
    };
}

async function runOne(server, name, runMode) {
    const port = server.address().port;
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--js-flags=--expose-gc'] });
    const page = await browser.newPage();
    let crashed = false;
    page.on('crash', () => { crashed = true; });
    page.on('pageerror', (e) => console.log('  pageerror', e.message));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    if (mbps > 0) {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: (mbps * 1e6) / 8, uploadThroughput: (mbps * 1e6) / 8 });
    }
    await page.goto(`http://127.0.0.1:${port}/bench.html`);
    await page.waitForFunction(() => window.ready);
    await new Promise((r) => setTimeout(r, 600));
    const mem = memorySampler();
    await new Promise((r) => setTimeout(r, 800));
    const idle = mem.current();
    const url = runMode === 'stream' ? `/audio/${name}/manifest.json` : `/audio/${name}.wav`;
    let result;
    try {
        result = await page.evaluate((o) => window.run(o), { mode: runMode, url });
    } catch (error) {
        result = { mode: runMode, error: crashed ? 'renderer crashed' : String(error).slice(0, 300) };
    }
    const metrics = crashed ? null : await cdp.send('Performance.getMetrics').catch(() => null);
    const heap = metrics?.metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? NaN;
    await new Promise((r) => setTimeout(r, 500));
    const { peak, last } = mem.stop();
    await browser.close();
    return { name, ...result, crashed, idleMB: idle / 2 ** 20, peakMB: peak / 2 ** 20, steadyMB: last / 2 ** 20, jsHeapMB: heap / 2 ** 20 };
}

if (args.includes('--stretch-quality')) {
    // Realtime stretch (engine) vs Rubber Band offline: level, timing, spectral
    // distance to the time-scaled input, CPU; WAVs to --listen <dir>.
    const { build } = await import('esbuild');
    const helper = path.join(root, 'node_modules', '.cache', 'stretch-offline.mjs');
    await build({ entryPoints: [path.join(root, 'bench/stretch-offline.ts')], outfile: helper, bundle: true, platform: 'node', format: 'esm', logLevel: 'warning', external: ['rubberband-wasm'] });
    const { offlineStretch } = await import(pathToFileURL(helper).href);
    const listen = arg('listen', null);
    if (listen) fs.mkdirSync(listen, { recursive: true });
    const sr = 48000;
    const rand = ((seed) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; })(7);
    const seconds = 10;
    const voiceDir = fs.readdirSync(dir).find((n) => n.includes('espeak') && fs.existsSync(path.join(dir, n, 'manifest.json')));
    // The voice: segments 1 and 2 of a prepared mono 16-bit WAV (their byte ranges of the source).
    const voice = voiceDir ? (() => {
        const m = JSON.parse(fs.readFileSync(path.join(dir, voiceDir, 'manifest.json'), 'utf8'));
        const src = m.segments.source;
        if (src.codec !== 'wav' || src.pcm.bitsPerSample !== 16 || src.channels !== 1) return null;
        const b = fs.readFileSync(path.join(dir, voiceDir, src.url));
        const [start] = m.segments.list[1].range;
        const [, end] = m.segments.list[2].range;
        return Float32Array.from({ length: (end - start) / 2 }, (_, i) => b.readInt16LE(start + 2 * i) / 32768);
    })() : null;
    const signals = {
        tone: Float32Array.from({ length: sr * seconds }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / sr)),
        noise: Float32Array.from({ length: sr * seconds }, () => (rand() * 2 - 1) * 0.2),
        ...(voice ? { voice } : {}),
    };
    const writeWav = (file, x) => {
        const buf = Buffer.alloc(44 + x.length * 2);
        buf.write('RIFF', 0); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
        buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
        buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(x.length * 2, 40);
        for (let i = 0; i < x.length; i += 1) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + 2 * i);
        fs.writeFileSync(file, buf);
    };
    const rmsDb = (x, from, to) => { let s = 0; for (let i = from; i < to; i += 1) s += x[i] * x[i]; return 10 * Math.log10(s / Math.max(1, to - from) + 1e-20); };
    // 64 log bands × 2048-frame Hann frames (512 hop), dB.
    const spec = (x) => {
        const N = 2048, hop = 512, bands = 64, frames = Math.max(0, Math.floor((x.length - N) / hop));
        const win = Float64Array.from({ length: N }, (_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)));
        const edges = Array.from({ length: bands + 1 }, (_, b) => Math.round((60 * Math.pow(12000 / 60, b / bands)) * N / sr));
        const out = [];
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let f = 0; f < frames; f += 1) {
            for (let n = 0; n < N; n += 1) { re[n] = x[f * hop + n] * win[n]; im[n] = 0; }
            fft(re, im);
            const row = new Float64Array(bands);
            for (let b = 0; b < bands; b += 1) {
                let e = 0;
                for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k += 1) e += re[k] * re[k] + im[k] * im[k];
                row[b] = 10 * Math.log10(e + 1e-12);
            }
            out.push(row);
        }
        return out;
    };
    function fft(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i += 1) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = -2 * Math.PI / len;
            for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k += 1) {
                const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
                const ur = re[i + k], ui = im[i + k];
                const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi, vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
                re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
            }
        }
    }
    // Distance of an output's spectrogram to the input's, time-warped by the speed (mean |dB| over loud cells).
    const distance = (input, output, rate) => {
        const a = spec(input), b = spec(output);
        let sum = 0, n = 0;
        for (let f = 2; f < b.length - 2; f += 1) {
            const g = Math.round(f * rate);
            if (g >= a.length) break;
            const top = Math.max(...a[g]);
            for (let k = 0; k < a[g].length; k += 1) {
                if (a[g][k] < top - 50) continue;
                sum += Math.abs(a[g][k] - b[f][k]);
                n += 1;
            }
        }
        return sum / Math.max(1, n);
    };
    // Envelope cross-correlation lag (ms) of output against the time-scaled input.
    const lagMs = (input, output, rate) => {
        const hop = 240;
        const env = (x, scale) => { const n = Math.floor(x.length / (hop * scale)); const e = new Float64Array(n); for (let i = 0; i < n; i += 1) { let s = 0; const from = Math.floor(i * hop * scale); for (let k = 0; k < hop * scale; k += 1) s += Math.abs(x[from + k] ?? 0); e[i] = s; } return e; };
        const ei = env(input, rate), eo = env(output, 1);
        let best = 0, bestLag = 0;
        for (let lag = -40; lag <= 40; lag += 1) {
            let s = 0;
            for (let i = 50; i < Math.min(ei.length, eo.length) - 50; i += 1) s += ei[i] * (eo[i + lag] ?? 0);
            if (s > best) { best = s; bestLag = lag; }
        }
        return (bestLag * hop / sr) * 1000;
    };
    const server = await serve();
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('  pageerror', e.message));
    page.setDefaultTimeout(600000);
    await page.goto(`http://127.0.0.1:${server.address().port}/bench.html`);
    await page.waitForFunction(() => window.ready);
    const rows = [];
    for (const [name, input] of Object.entries(signals)) {
        const inDb = rmsDb(input, sr, input.length - sr);
        if (listen) writeWav(path.join(listen, `${name}-source.wav`), input);
        for (const rate of [1, 0.75, 1.25, 1.5, 2]) {
            const r = await page.evaluate((o) => window.stretchRender(o), { input: Buffer.from(input.buffer).toString('base64'), rate });
            const rt = new Float32Array(Buffer.from(r.output, 'base64').buffer.slice(0));
            const outs = { realtime: { out: rt, ms: r.wallMs } };
            if (rate !== 1) {
                outs.rubberband = await offlineStretch(input, sr, rate);
            }
            for (const [method, { out, ms }] of Object.entries(outs)) {
                const lvl = rmsDb(out, Math.round(sr / rate), out.length - Math.round(sr / rate)) - inDb;
                const row = { signal: name, rate, method, levelDb: lvl, lagMs: lagMs(input, out, rate), spectralDb: name === 'voice' ? distance(input, out, rate) : null, cpuPct: method === 'realtime' ? (ms / (out.length / sr / 1000 * 1000)) * 100 / 1000 * 1000 / 1000 : null, ms };
                row.cpuPct = method === 'realtime' ? (ms / 1000) / (out.length / sr) * 100 : null;
                rows.push(row);
                if (listen && (name === 'voice' || rate === 1.5)) writeWav(path.join(listen, `${name}-${rate}x-${method}.wav`), out);
                if (method === 'realtime' && rate !== 1 && !r.ready) console.log('  (stretcher not ready: this row used plain resampling)');
                console.log(`${name.padEnd(5)} ${String(rate).padEnd(4)}x ${method.padEnd(10)} level ${lvl >= 0 ? '+' : ''}${lvl.toFixed(2)} dB, lag ${row.lagMs.toFixed(1)} ms${row.spectralDb !== null ? `, spectral distance ${row.spectralDb.toFixed(2)} dB` : ''}${row.cpuPct !== null ? `, CPU ${row.cpuPct.toFixed(1)} % of a core` : `, ${ms.toFixed(0)} ms offline`}`);
            }
        }
    }
    console.log(`stretcher window (latency compensated by the engine's look-ahead): ${(await page.evaluate(() => 0)) || ''}`);
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
    await browser.close();
    server.close();
    process.exit(0);
}
if (args.includes('--approx-error')) {
    const server = await serve();
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('  pageerror', e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/bench.html`);
    await page.waitForFunction(() => window.ready);
    const settings = [
        { name: 'none (grid only)' }, { name: 'HP 100 Hz', hp: 100 }, { name: 'HP 200 Hz', hp: 200 }, { name: 'HP 400 Hz', hp: 400 },
        { name: 'comp 0.5', comp: 0.5 }, { name: 'comp 1.0', comp: 1 }, { name: 'gain -12 dB', gainDb: -12 },
        { name: 'HP 200 + comp 1 + gain +6', hp: 200, comp: 1, gainDb: 6 },
    ];
    const all = [];
    for (const name of fs.readdirSync(dir).filter((n) => (!only || n.includes(only)) && fs.existsSync(path.join(dir, n, 'manifest.json')) && fs.existsSync(path.join(dir, `${n}.wav`)))) {
        const duration = JSON.parse(fs.readFileSync(path.join(dir, name, 'manifest.json'), 'utf8')).duration;
        const windows = [{ name: 'whole', start: 0, end: duration }, { name: '2 min', start: duration * 0.4, end: duration * 0.4 + 120 }];
        page.setDefaultTimeout(600000);
        const rows = await page.evaluate((o) => window.approxError(o), { wav: `/audio/${name}.wav`, manifest: `/audio/${name}/manifest.json`, settings, windows });
        for (const r of rows) {
            all.push({ name, ...r });
            console.log(`${name} | ${r.setting} | ${r.window} | RMS ${r.rmsBias !== undefined ? 'bias ' + r.rmsBias.toFixed(2) + ' ' : ''}mean ${r.rmsMean.toFixed(2)} p95 ${r.rmsP95.toFixed(2)} max ${r.rmsMax.toFixed(2)} dB | peak mean ${r.peakMean.toFixed(2)} p95 ${r.peakP95.toFixed(2)} dB | ${r.approxMs.toFixed(0)} ms`);
        }
    }
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(all, null, 2));
    await browser.close();
    server.close();
    process.exit(0);
}
const names = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).map((f) => f.slice(0, -4)).filter((n) => !only || n.includes(only));
const server = await serve();
const results = [];
for (const name of names) {
    for (const runMode of mode === 'both' ? ['buffer', 'stream'] : [mode]) {
        if (runMode === 'stream' && !fs.existsSync(path.join(dir, name, 'manifest.json'))) continue;
        process.stdout.write(`${name} [${runMode}] ... `);
        const r = await runOne(server, name, runMode);
        results.push(r);
        const f = (v) => (v == null || Number.isNaN(v) ? '—' : Math.round(v));
        console.log(`ui ${f(r.uiReadyMs)} ms, spectrogram ${f(r.spectrogramMs)} ms, audio ${f(r.firstAudioMs)} ms, seeks ${(r.seeks ?? []).map(f).join('/')} ms, `
            + `peak ${f(r.peakMB)} MB, steady ${f(r.steadyMB)} MB (idle ${f(r.idleMB)}), heap ${f(r.jsHeapMB)} MB${r.error ? `, ERROR ${r.error}` : ''}${r.crashed ? ', CRASHED' : ''}`);
    }
}
server.close();
if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
