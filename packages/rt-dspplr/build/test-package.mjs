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
const [pack] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root));
assert.ok(pack.files.every(file => !file.path.endsWith('.wasm') && !file.path.includes('node_modules/')));
assert.ok(pack.files.some(file => file.path === 'dist/bundle-sizes.json'));
fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, pack.filename)], temp);
assert.ok(!fs.existsSync(path.join(temp, 'node_modules/rubberband-wasm')), 'Default install must not install Rubber Band');
const manifest = JSON.parse(fs.readFileSync(path.join(temp, 'node_modules/@saitdigital/rt-dspplr/package.json'), 'utf8'));
assert.equal(manifest.peerDependenciesMeta['rubberband-wasm'].optional, true);
assert.ok(!manifest.dependencies?.['rubberband-wasm']);
assert.ok(!manifest.optionalDependencies?.['rubberband-wasm']);
for (const [name, entry] of Object.entries(manifest.exports)) {
    if (typeof entry === 'string') continue;
    for (const value of Object.values(entry)) assert.ok(fs.existsSync(path.join(temp, 'node_modules/@saitdigital/rt-dspplr', value)), `${name}: ${value}`);
}
const smoke = `import assert from 'node:assert/strict';
import * as core from '@saitdigital/rt-dspplr';
import { Track } from '@saitdigital/rt-dspplr/advanced';
import { rubberbandStretcher } from '@saitdigital/rt-dspplr/stretch-rubberband';
const player = core.createAudioPlayer();
assert.equal(player.audioContext, null);
assert.equal(player.getState().status, 'idle');
assert.equal('Track' in core, false);
assert.equal(typeof Track, 'function');
assert.equal(typeof rubberbandStretcher, 'function');
player.dispose();
console.log('Isolated package import and optional adapter import passed without React or Rubber Band.');`;
fs.writeFileSync(path.join(temp, 'smoke.mjs'), smoke);
console.log(execFileSync(process.execPath, ['smoke.mjs'], { cwd: temp, encoding: 'utf8' }).trim());
console.log(`Package consumer fixture: ${temp}`);
