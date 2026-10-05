// The manifest JSON Schema (schema/manifest.schema.json, shipped as
// `@saitdigital/rt-dspplr/manifest.schema.json`) and assertManifest() must agree:
// on the committed fixtures (formatVersion 1, 2, 3 with stem b, 3 with named
// stems), on every prepared manifest found on disk (the browser fixtures, the
// demo's long-audio folder), and on manifests broken in known ways.
//   LONG_STORAGE_DIR   the demo's prepared folder (default examples/demo/storage/long)
//   RTD_MANIFEST_DIRS  more folders to scan, separated by the platform's path delimiter

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import schema from '../schema/manifest.schema.json';
import { assertManifest, isStemKey, MANIFEST_FORMAT_VERSION } from '../src/core/stream/manifest';

const here = path.dirname(fileURLToPath(import.meta.url));
// The bundle runs from node_modules/.cache/rtd-test; find the package root from there or from test/.
const pkgRoot = [path.resolve(here, '..'), path.resolve(here, '../../..')].find((dir) => fs.existsSync(path.join(dir, 'schema', 'manifest.schema.json')))!;
const repoRoot = path.resolve(pkgRoot, '../..');
const validate = new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(schema as object);

const schemaOk = (m: unknown) => validate(m) === true;
const assertOk = (m: unknown) => {
    try {
        assertManifest(m);
        return true;
    } catch {
        return false;
    }
};

const results: string[] = [];

// ---- positive: committed fixtures and manifests on disk --------------------------------------
function findManifests(dir: string, depth = 2): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && (entry.name === 'manifest.json' || dir.endsWith(path.join('fixtures', 'manifests')))) out.push(full);
        else if (entry.isDirectory() && depth > 0) out.push(...findManifests(full, depth - 1));
    }
    return out;
}
const sources: Array<[string, string]> = [
    ['committed fixtures', path.join(pkgRoot, 'test', 'fixtures', 'manifests')],
    ['browser test fixtures', path.join(pkgRoot, 'node_modules', '.cache', 'rtd-long')],
    ['demo long-audio folder', path.resolve(repoRoot, 'examples', 'demo', process.env.LONG_STORAGE_DIR ?? 'storage/long')],
    ...(process.env.RTD_MANIFEST_DIRS ?? '').split(path.delimiter).filter(Boolean).map((d): [string, string] => ['RTD_MANIFEST_DIRS', path.resolve(d)]),
];
const versions = new Map<number, number>();
let agreedRejections = 0;
for (const [label, dir] of sources) {
    const files = findManifests(dir);
    let valid = 0;
    for (const file of files) {
        const m = JSON.parse(fs.readFileSync(file, 'utf8'));
        const s = schemaOk(m);
        const a = assertOk(m);
        assert.equal(s, a, `${file}: schema says ${s}, assertManifest says ${a} (${JSON.stringify(validate.errors)})`);
        if (label === 'committed fixtures' || label === 'browser test fixtures') assert.ok(s, `${file}: ${JSON.stringify(validate.errors)}`);
        if (s) {
            valid += 1;
            versions.set(m.formatVersion, (versions.get(m.formatVersion) ?? 0) + 1);
        } else {
            agreedRejections += 1;
        }
    }
    results.push(`${label}: ${files.length} manifest(s), ${valid} valid${files.length - valid ? `, ${files.length - valid} rejected by both` : ''}${files.length ? '' : ' (folder absent or empty: skipped)'}`);
}
for (const v of [1, 2, 3]) assert.ok(versions.get(v), `no valid formatVersion ${v} manifest was checked`);
results.push(`valid manifests by formatVersion: ${[...versions].sort().map(([v, n]) => `v${v} ${n}`).join(', ')}`);

// ---- negative: broken in known ways, both must refuse ------------------------------------------
const base = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'test', 'fixtures', 'manifests', 'v3-named.json'), 'utf8'));
const clone = () => structuredClone(base);
const broken: Array<[string, (m: any) => void]> = [
    ['not a manifest', (m) => { m.format = 'something-else'; }],
    [`formatVersion ${MANIFEST_FORMAT_VERSION + 1} (unknown major)`, (m) => { m.formatVersion = MANIFEST_FORMAT_VERSION + 1; }],
    ['formatVersion 0', (m) => { m.formatVersion = 0; }],
    ['formatVersion as a string', (m) => { m.formatVersion = '3'; }],
    ...['format', 'formatVersion', 'analyzerVersion', 'id', 'createdAt', 'duration', 'sampleRate', 'sourceSampleRate', 'channels', 'frames', 'source', 'resample', 'segments', 'peaks', 'loudness']
        .map((field): [string, (m: any) => void] => [`no ${field}`, (m) => { delete m[field]; }]),
    ['sampleRate 0', (m) => { m.sampleRate = 0; }],
    ['channels 1.5', (m) => { m.channels = 1.5; }],
    ['negative duration', (m) => { m.duration = -1; }],
    ['revision 0', (m) => { m.revision = 0; }],
    ['segment codec flac', (m) => { m.segments.codec = 'flac'; }],
    ['segment without url', (m) => { delete m.segments.list[0].url; }],
    ['segments.list not an array', (m) => { m.segments.list = {}; }],
    ['peaks format', (m) => { m.peaks.format = 'other'; }],
    ['peak level without byteLength', (m) => { delete m.peaks.levels[0].byteLength; }],
    ['bands format', (m) => { m.bands.format = 'rtd-peaks'; }],
    ['spectrogram without url', (m) => { delete m.spectrogram.url; }],
    ['loudness without gatedRmsDb', (m) => { delete m.loudness.gatedRmsDb; }],
    ['source.name a number', (m) => { m.source.name = 3; }],
    ['resample without to', (m) => { m.resample = { from: 96000 }; }],
    ['stems an array', (m) => { m.stems = []; }],
    ['stem key a', (m) => { m.stems.a = m.stems.b; }],
    ['stem key A', (m) => { m.stems.A = m.stems.b; }],
    ['stem key with a space', (m) => { m.stems['my stem'] = m.stems.b; }],
    ['stem key with a slash', (m) => { m.stems['x/y'] = m.stems.b; }],
    ['stem key of 33 characters', (m) => { m.stems['k'.repeat(33)] = m.stems.b; }],
    ['stem key starting with -', (m) => { m.stems['-b'] = m.stems.b; }],
    ['stem status unknown', (m) => { m.stems.b.status = 'done'; }],
    ['stem without updatedAt', (m) => { delete m.stems.v1.updatedAt; }],
    ['ready stem without segments', (m) => { delete m.stems.v1.segments; }],
    ['ready stem without peaks', (m) => { delete m.stems.v1.peaks; }],
    ['empty label', (m) => { m.stems.b.label = ''; }],
    ['label of 121 characters', (m) => { m.stems.b.label = 'x'.repeat(121); }],
    ['label a number', (m) => { m.stems.b.label = 7; }],
    ['mixLaw unknown', (m) => { m.stems.b.mixLaw = 'separation'; }],
    ['gainDb a string', (m) => { m.stems.b.gainDb = '-6'; }],
    ['processor without version', (m) => { m.stems.b.processor = { id: 'x', durationMs: 1 }; }],
];
for (const [name, mutate] of broken) {
    const m = clone();
    mutate(m);
    assert.equal(schemaOk(m), false, `schema accepted: ${name}`);
    assert.equal(assertOk(m), false, `assertManifest accepted: ${name}`);
}
results.push(`${broken.length} broken manifests: refused by the schema and by assertManifest alike`);

// Case-insensitive key collisions are checked by assertManifest only (JSON Schema cannot express them).
{
    const m = clone();
    m.stems.V1 = m.stems.v1;
    assert.equal(assertOk(m), false, 'assertManifest accepted colliding keys v1 / V1');
    results.push('colliding stem keys (v1 / V1): refused by assertManifest (documented: not expressible in the schema)');
}

// Forward compatibility: unknown optional fields are ignored by both.
{
    const m = clone();
    m.futureField = { anything: true };
    m.stems.b.futureField = 1;
    m.segments.futureField = 'x';
    assert.ok(schemaOk(m) && assertOk(m), 'unknown optional fields must be ignored');
    results.push('unknown optional fields (top level, stems, segments): accepted by both');
}

// The key rule itself.
for (const key of ['b', 'v1', 'B', '0', 'take_2', 'mix-a', 'k'.repeat(32)]) assert.ok(isStemKey(key), key);
for (const key of ['a', 'A', '', '-x', '_x', 'x y', 'x/y', 'x.y', 'k'.repeat(33), 'é']) assert.ok(!isStemKey(key), key);
results.push('stem keys: [A-Za-z0-9][A-Za-z0-9_-]{0,31}, a reserved');

console.log(results.map((line) => `  ok  ${line}`).join('\n'));
console.log('\nmanifest schema tests passed');
