// Test the npm artifacts outside the workspace: pack the player and prepare,
// install both tarballs in a throwaway consumer, run the installed `rtd-prepare`
// CLI on a small WAV (with a named stem), check the output against the shipped
// schema and assertManifest(), run the installed API with worker threads, and
// play the CLI's output in the browser through the player's test harness
// (test/browser/prepared-package.spec.mjs of packages/rt-dspplr).
//   RTD_SKIP_BROWSER=1   skip the browser step (no Chromium installed)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const player = path.resolve(root, '..', 'rt-dspplr');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-dspplr-prepare-consumer-'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run through npm run test:package');
const npm = (args, cwd, env = process.env) => execFileSync(process.execPath, [npmCli, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** 16-bit PCM WAV of a gliding tone with a slow envelope (always audible). */
function wav16(file, seconds, rate, channels, { gain = 1, delayFrames = 0 } = {}) {
    const frames = Math.round(seconds * rate);
    const buf = Buffer.alloc(44 + frames * channels * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * channels * 2, 28); buf.writeUInt16LE(channels * 2, 32);
    buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(frames * channels * 2, 40);
    let seed = 7;
    const noise = Float64Array.from({ length: frames }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; });
    for (let i = 0; i < frames; i += 1) {
        const k = i - delayFrames;
        const t = k / rate;
        const env = 0.3 + 0.2 * Math.sin(2 * Math.PI * 0.7 * t);
        for (let c = 0; c < channels; c += 1) {
            const v = k < 0 ? 0 : gain * (env * Math.sin(2 * Math.PI * (180 + 60 * Math.sin(0.5 * t) + c * 7) * t) + 0.05 * noise[k]);
            buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + (i * channels + c) * 2);
        }
    }
    fs.writeFileSync(file, buf);
}

try {
    // ---- the artifacts --------------------------------------------------------------------
    const [packMain] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], player));
    const [pack] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root));
    const files = pack.files.map((f) => f.path);
    for (const file of ['dist/index.js', 'dist/cli.js', 'dist/prepare-worker.mjs', 'dist/types/index.d.ts', 'bin/rtd-prepare.mjs', 'README.md', 'LICENSE.md', 'package.json']) {
        assert.ok(files.includes(file), `${file} is missing from the prepare tarball`);
    }
    assert.ok(!files.some((f) => f.startsWith('src/') || f.startsWith('test/') || f.includes('node_modules/')), 'sources, tests or dependencies in the tarball');

    // ---- an isolated consumer --------------------------------------------------------------
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packMain.filename), path.join(temp, pack.filename)], temp);
    const installed = path.join(temp, 'node_modules', '@saitdigital', 'rt-dspplr-prepare');
    const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(pkg.engines.node, '>=20.19');
    assert.ok(pkg.dependencies['@saitdigital/rt-dspplr'], 'depends on the player package for the formats');
    for (const value of Object.values(pkg.exports['.'])) assert.ok(fs.existsSync(path.join(installed, value)), value);
    // One implementation of the formats: the installed bundles import them.
    assert.match(fs.readFileSync(path.join(installed, 'dist/index.js'), 'utf8'), /from ["']@saitdigital\/rt-dspplr\/format["']/);

    // ---- the CLI on a small WAV, with a named stem -----------------------------------------
    const rate = 48000;
    wav16(path.join(temp, 'talk.wav'), 12, rate, 2);
    wav16(path.join(temp, 'talk.v1.wav'), 12, rate, 2, { gain: 0.5, delayFrames: Math.round(0.02 * rate) });
    const out = path.join(temp, 'prepared');
    const bin = path.join(installed, pkg.bin['rtd-prepare']);
    const printed = execFileSync(process.execPath, [bin, 'talk.wav', out, '--segment', '3', '--stem', 'v1=talk.v1.wav', '--label', 'v1=Variant one', '--quiet'], { cwd: temp, encoding: 'utf8' });
    const report = JSON.parse(printed);
    assert.equal(report.ok, true);
    assert.equal(report.segments, 4);
    assert.equal(report.stems.v1.status, 'ready');
    assert.ok(Math.abs(report.stems.v1.offsetMs - 20) < 0.1, `offset ${report.stems.v1.offsetMs} ms`);
    // A bad key is refused before any work, with a usage error.
    let refused = null;
    try {
        execFileSync(process.execPath, [bin, 'talk.wav', path.join(temp, 'bad'), '--stem', 'a=talk.v1.wav', '--quiet'], { cwd: temp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        refused = error;
    }
    assert.ok(refused && /reserved/.test(refused.stderr), 'stem key "a" must be refused');

    // ---- the output against the shipped schema and assertManifest() ------------------------
    const check = `import fs from 'node:fs';
import { createRequire } from 'node:module';
import { assertManifest } from '@saitdigital/rt-dspplr/format';
import { prepareAudio } from '@saitdigital/rt-dspplr-prepare';
const require = createRequire(import.meta.url);
const schema = require('@saitdigital/rt-dspplr/manifest.schema.json');
const { default: Ajv2020 } = await import(process.argv[2]);
const validate = new Ajv2020({ strict: false }).compile(schema);
const manifest = JSON.parse(fs.readFileSync('prepared/manifest.json', 'utf8'));
assertManifest(manifest);
if (!validate(manifest)) throw new Error(JSON.stringify(validate.errors));
if (manifest.stems.v1.label !== 'Variant one') throw new Error('label lost');
// The installed API, with worker threads found next to the installed bundle.
const job = prepareAudio('talk.wav', { outDir: 'prepared-api', segmentSeconds: 3, concurrency: 2 });
const m = await job.done;
if (job.stats.threads < 2) throw new Error('the installed worker was not found (' + job.stats.threads + ' thread)');
for (const f of ['source.wav', 'peaks.bin', 'bands.bin', 'spectrogram.bin']) if (!fs.existsSync('prepared-api/' + f)) throw new Error(f);
if (JSON.stringify(m.segments) !== JSON.stringify(manifest.segments)) throw new Error('CLI and API segments differ');
console.log('installed CLI output: schema and assertManifest agree; installed API ran on ' + job.stats.threads + ' threads, same segments');`;
    fs.writeFileSync(path.join(temp, 'check.mjs'), check);
    const ajv = pathToFileURL(path.join(root, '..', '..', 'node_modules', 'ajv', 'dist', '2020.js')).href;
    console.log(execFileSync(process.execPath, ['check.mjs', ajv], { cwd: temp, encoding: 'utf8' }).trim());
    const leaks = JSON.stringify(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')));
    assert.ok(!leaks.includes(temp) && !/[A-Za-z]:[\\/]|\/tmp\//.test(leaks), 'the manifest records an absolute path');

    // ---- the CLI's output in the browser player --------------------------------------------
    if (process.env.RTD_SKIP_BROWSER) {
        console.log('browser step skipped (RTD_SKIP_BROWSER)');
    } else {
        const fixture = path.join(player, 'node_modules', '.cache', 'rtd-long', 'pkgCli');
        fs.rmSync(fixture, { recursive: true, force: true });
        fs.cpSync(out, fixture, { recursive: true });
        const playwright = path.join(root, '..', '..', 'node_modules', '@playwright', 'test', 'cli.js');
        const run = execFileSync(process.execPath, [playwright, 'test', 'prepared-package', '--reporter=line'], {
            cwd: player, encoding: 'utf8', env: { ...process.env, RTD_PACKAGE_FIXTURE: 'pkgCli' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const line = run.split('\n').find((l) => /passed|failed/.test(l)) ?? run;
        console.log(`browser: the packed CLI's output plays in the player (${line.trim()})`);
        fs.rmSync(fixture, { recursive: true, force: true });
    }
    console.log(`Isolated install of ${pack.filename} + ${packMain.filename} passed.`);
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
