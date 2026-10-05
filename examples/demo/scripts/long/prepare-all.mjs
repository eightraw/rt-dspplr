#!/usr/bin/env node
// Prepares every <name>.wav in a folder into <name>/ (manifest.json, peaks,
// bands, spectrogram, seg/*.wav) with the package's `./prepare` entry. Stem B
// is made in the same call, so one manifest has both A and B. B comes from:
//   - a ready-made file, when <dir>/stems/<name>.b.wav exists (make-stems.mjs,
//     make-speech-docker.sh);
//   - or a processor: with --docker <image> --docker-for <substring>, ffmpeg's
//     afftdn denoiser runs in that image (network none) on the matching
//     recordings.
//
//   node scripts/long/prepare-all.mjs [dir] [--force] [--docker vcp-samples:local --docker-for espeak]
// Folders that are up to date (manifest newer than its sources) are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { dockerProcessor, prepareAudio } from '@saitdigital/rt-dspplr/prepare';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const force = args.includes('--force');
const dockerImage = flag('--docker');
const dockerFor = flag('--docker-for') ?? 'espeak';
const positional = args.filter((a, i) => !a.startsWith('--') && !['--docker', '--docker-for'].includes(args[i - 1]));
const dir = path.resolve(positional[0] ?? process.env.LONG_STORAGE_DIR ?? 'storage/long');
const wavs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav')) : [];
if (wavs.length === 0) {
    console.log(`No .wav files in ${dir}. Generate some: npm run long:gen`);
}

/** ffmpeg's FFT denoiser as a stem processor, in a container without network. */
const denoiser = (image) => dockerProcessor({
    image,
    entrypoint: 'ffmpeg',
    args: ['-nostdin', '-loglevel', 'error', '-y', '-i', '{in}', '-af', 'afftdn=nr=24:nf=-42:tn=1,highpass=f=90', '-c:a', 'pcm_s16le', '{out}'],
    id: 'demo.ffmpeg-afftdn',
    version: '1',
    params: { filter: 'afftdn=nr=24:nf=-42:tn=1,highpass=f=90', image },
    timeoutMs: 10 * 60_000,
});

for (const file of wavs) {
    const name = file.slice(0, -4);
    const src = path.join(dir, file);
    const out = path.join(dir, name);
    const bFile = path.join(dir, 'stems', `${name}.b.wav`);
    const processor = dockerImage && name.includes(dockerFor) ? denoiser(dockerImage) : null;
    const stems = processor ? { b: { processor } } : fs.existsSync(bFile) ? { b: { input: bFile } } : undefined;
    const manifest = path.join(out, 'manifest.json');
    const newest = Math.max(fs.statSync(src).mtimeMs, stems?.b.input ? fs.statSync(bFile).mtimeMs : 0);
    if (!force && fs.existsSync(manifest) && fs.statSync(manifest).mtimeMs > newest) {
        const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (!stems || m.stems?.b?.status === 'ready') {
            console.log(`${file}: up to date`);
            continue;
        }
    }
    fs.rmSync(out, { recursive: true, force: true });
    const job = prepareAudio(src, { outDir: out, ...(stems ? { stems } : {}) });
    let last = 0;
    let peak = 0;
    const rss = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
    job.on('progress', (p) => {
        if (Date.now() - last < 1000) return;
        last = Date.now();
        process.stdout.write(`\r${file}: ${p.stage ?? ''} ${Number.isFinite(p.fraction) ? (p.fraction * 100).toFixed(0) : 0}%  rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB `);
    });
    const m = await job.done;
    clearInterval(rss);
    const t = job.stats.timings;
    const b = m.stems?.b;
    console.log(`\r${file}: ${m.segments.list.length} segments, ${(m.duration / 60).toFixed(1)} min @ ${m.sampleRate} Hz, ${(job.stats.elapsedMs / 1000).toFixed(1)} s total, peak rss ${(peak / 2 ** 20).toFixed(0)} MB`
        + ` (A ${(t.aMs / 1000).toFixed(1)} s${t.processorMs != null ? `, processor ${(t.processorMs / 1000).toFixed(1)} s beside A, waited ${(t.processorWaitMs / 1000).toFixed(1)} s` : ''}${t.stemMs != null ? `, B ${(t.stemMs / 1000).toFixed(1)} s` : ''})`);
    if (b?.status === 'ready') {
        console.log(`    stem B${b.processor ? ` by ${b.processor.id}@${b.processor.version}` : ' (ready-made)'}: offset ${b.alignment.offsetMs} ms, confidence ${b.alignment.confidence}, ρ ${b.correlation.global}, ${b.mixLaw}, ${b.loudnessDeltaDb} dB vs A (info), B ${b.source.sampleRate / 1000} kHz ${b.source.channels} ch, band ${(b.source.bandwidthHz / 1000).toFixed(1)} kHz`);
    } else if (b) {
        console.log(`    stem B not attached: ${b.error}`);
    }
    for (const w of job.stats.warnings) console.log(`    warning: ${w}`);
}
