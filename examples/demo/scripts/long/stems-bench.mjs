#!/usr/bin/env node
// Prepare time and peak RSS, A only vs A + B in one call, for every recording
// in the folder that has stems/<name>.b.wav. Output goes to a temporary folder
// (the demo's own prepared folders are left alone).
//   node scripts/long/stems-bench.mjs [dir] [--docker vcp-samples:local --docker-for espeak]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dockerProcessor, prepareAudio } from '@saitdigital/rt-dspplr-prepare';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dockerImage = flag('--docker');
const dockerFor = flag('--docker-for') ?? 'espeak';
const positional = args.filter((a, i) => !a.startsWith('--') && !['--docker', '--docker-for'].includes(args[i - 1]));
const dir = path.resolve(positional[0] ?? process.env.LONG_STORAGE_DIR ?? 'storage/long');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtd-stems-bench-'));

async function measure(src, options) {
    const out = path.join(tmp, 'out');
    fs.rmSync(out, { recursive: true, force: true });
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
    const t0 = performance.now();
    const job = prepareAudio(src, { outDir: out, ...options });
    const m = await job.done;
    clearInterval(timer);
    return { s: (performance.now() - t0) / 1000, rss: peak / 2 ** 20, m, t: job.stats.timings };
}

const rows = [];
for (const file of fs.readdirSync(path.join(dir, 'stems')).filter((f) => f.endsWith('.b.wav'))) {
    const name = file.slice(0, -'.b.wav'.length);
    const src = path.join(dir, `${name}.wav`);
    if (!fs.existsSync(src)) continue;
    const a = await measure(src, {});
    const ab = await measure(src, { stems: { b: { input: path.join(dir, 'stems', file) } } });
    const b = ab.m.stems.b;
    rows.push(`| ${name} | ready-made ${b.source.sampleRate / 1000} kHz ${b.source.channels} ch | ${a.s.toFixed(1)} s, ${a.rss.toFixed(0)} MB | ${ab.s.toFixed(1)} s, ${ab.rss.toFixed(0)} MB | +${(ab.s - a.s).toFixed(1)} s (B ${(ab.t.stemMs / 1000).toFixed(1)} s) | ${b.alignment.offsetMs} ms (${b.alignment.confidence}) | ${b.correlation.global} |`);
    console.log(rows[rows.length - 1]);
    if (dockerImage && name.includes(dockerFor)) {
        const p = dockerProcessor({
            image: dockerImage, entrypoint: 'ffmpeg', id: 'demo.ffmpeg-afftdn', version: '1',
            args: ['-nostdin', '-loglevel', 'error', '-y', '-i', '{in}', '-af', 'afftdn=nr=24:nf=-42:tn=1,highpass=f=90', '-c:a', 'pcm_s16le', '{out}'],
        });
        const d = await measure(src, { stems: { b: { processor: p } } });
        const db = d.m.stems.b;
        rows.push(`| ${name} | docker afftdn (processor ${(d.t.processorMs / 1000).toFixed(1)} s beside A, waited ${(d.t.processorWaitMs / 1000).toFixed(1)} s) | ${a.s.toFixed(1)} s | ${d.s.toFixed(1)} s, ${d.rss.toFixed(0)} MB | +${(d.s - a.s).toFixed(1)} s (B ${(d.t.stemMs / 1000).toFixed(1)} s) | ${db.alignment.offsetMs} ms (${db.alignment.confidence}) | ${db.correlation.global} |`);
        console.log(rows[rows.length - 1]);
    }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n| recording | B | A only | A + B | extra | offset (confidence) | ρ |\n|---|---|---|---|---|---|---|\n' + rows.join('\n'));
