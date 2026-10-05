// Test the actual npm artifact outside the workspace, with no Rubber Band installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-dspplr-consumer-'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run through npm run test:package');
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
    const [pack] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root));
    assert.ok(pack.files.every(file => !file.path.endsWith('.wasm') && !file.path.includes('node_modules/')));
    assert.ok(pack.files.some(file => file.path === 'dist/bundle-sizes.json'));
    // Browser package: no Node-only prepare code, no CLI; the notices and the schema ship.
    for (const file of ['THIRD_PARTY_NOTICES.md', 'schema/manifest.schema.json', 'dist/format.js', 'LICENSE.md', 'README.md']) {
        assert.ok(pack.files.some(f => f.path === file), `${file} is missing from the tarball`);
    }
    assert.ok(!pack.files.some(f => /(^|\/)(rtd-)?prepare([-./]|$)|^bin\//.test(f.path)), 'prepare code or a bin in the browser package');
    assert.ok(!pack.files.some(f => f.path.startsWith('test/') || f.path.startsWith('src/')), 'tests or sources in the tarball');
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, pack.filename)], temp);
    assert.ok(!fs.existsSync(path.join(temp, 'node_modules/rubberband-wasm')), 'Default install must not install Rubber Band');
    const manifest = JSON.parse(fs.readFileSync(path.join(temp, 'node_modules/@saitdigital/rt-dspplr/package.json'), 'utf8'));
    assert.equal(manifest.peerDependenciesMeta['rubberband-wasm'].optional, true);
    assert.ok(!manifest.dependencies?.['rubberband-wasm']);
    assert.ok(!manifest.optionalDependencies?.['rubberband-wasm']);
    assert.equal(manifest.bin, undefined, 'the CLI lives in @saitdigital/rt-dspplr-prepare');
    assert.equal(manifest.exports['./prepare'], undefined);
    for (const [name, entry] of Object.entries(manifest.exports)) {
        if (typeof entry === 'string') continue;
        for (const value of Object.values(entry)) assert.ok(fs.existsSync(path.join(temp, 'node_modules/@saitdigital/rt-dspplr', value)), `${name}: ${value}`);
    }
    const smoke = `import assert from 'node:assert/strict';
import * as core from '@saitdigital/rt-dspplr';
import { Track, TimelineCore } from '@saitdigital/rt-dspplr/advanced';
import * as advanced from '@saitdigital/rt-dspplr/advanced';
import * as format from '@saitdigital/rt-dspplr/format';
import { createRequire } from 'node:module';
import { rubberbandStretcher } from '@saitdigital/rt-dspplr/stretch-rubberband';
const player = core.createAudioPlayer();
assert.equal(player.audioContext, null);
assert.equal(player.getState().status, 'idle');
assert.equal('Track' in core, false);
assert.equal(typeof Track, 'function');
assert.equal(typeof rubberbandStretcher, 'function');
assert.equal(typeof TimelineCore, 'function');
assert.equal('SegmentStore' in advanced || 'StreamEngine' in advanced || 'createStreamPlayer' in core, false);
// "./format" runs in Node (no DOM): validation, stem keys, WAV.
assert.equal(format.MANIFEST_FORMAT_VERSION, 3);
assert.equal(format.isStemKey('v1') && !format.isStemKey('a'), true);
assert.throws(() => format.assertManifest({ format: 'rtd-audio-manifest', formatVersion: 99 }), /Unsupported manifest version/);
const wav = format.parseWavFile(format.wavHeader16(1, 48000, 0).buffer);
assert.equal(wav.sampleRate, 48000);
const schema = createRequire(import.meta.url)('@saitdigital/rt-dspplr/manifest.schema.json');
assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
player.dispose();
console.log('Isolated package import, ./format and the schema in Node, and the optional adapter import passed without React or Rubber Band.');`;
    fs.writeFileSync(path.join(temp, 'smoke.mjs'), smoke);
    console.log(execFileSync(process.execPath, ['smoke.mjs'], { cwd: temp, encoding: 'utf8' }).trim());
} finally {
    // The fixture is a throwaway: one is left behind per run otherwise.
    fs.rmSync(temp, { recursive: true, force: true });
}
