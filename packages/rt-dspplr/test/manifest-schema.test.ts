// The manifest JSON Schema (schema/manifest.schema.json, shipped as
// `@saitdigital/rt-dspplr/manifest.schema.json`) and assertManifest() must agree:
// on the committed fixtures (formatVersion 4: a WAV source with named stems
// kept as they are, an MP3 source, an Opus source), on every prepared manifest
// found on disk (the browser fixtures, and any folder named in
// RTD_MANIFEST_DIRS), and on manifests broken in known ways.
//   RTD_MANIFEST_DIRS  more folders to scan, separated by the platform's path delimiter

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import schema from '../schema/manifest.schema.json';
import { assertManifest, isStemKey, manifestProblem, MANIFEST_FORMAT_VERSION, MAX_SEGMENT_SECONDS } from '../src/core/stream/manifest';

const here = path.dirname(fileURLToPath(import.meta.url));
// The bundle runs from node_modules/.cache/rtd-test; find the package root from there or from test/.
const pkgRoot = [path.resolve(here, '..'), path.resolve(here, '../../..')].find((dir) => fs.existsSync(path.join(dir, 'schema', 'manifest.schema.json')))!;
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
assert.ok(versions.get(MANIFEST_FORMAT_VERSION), `no valid formatVersion ${MANIFEST_FORMAT_VERSION} manifest was checked`);
assert.deepEqual([...versions.keys()], [MANIFEST_FORMAT_VERSION], 'only the current format version is valid');
results.push(`valid manifests by formatVersion: ${[...versions].sort().map(([v, n]) => `v${v} ${n}`).join(', ')}`);

// ---- negative: broken in known ways, both must refuse ------------------------------------------
const base = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'test', 'fixtures', 'manifests', 'v4-named.json'), 'utf8'));
const clone = () => structuredClone(base);
const broken: Array<[string, (m: any) => void]> = [
    ['not a manifest', (m) => { m.format = 'something-else'; }],
    [`formatVersion ${MANIFEST_FORMAT_VERSION + 1} (unknown major)`, (m) => { m.formatVersion = MANIFEST_FORMAT_VERSION + 1; }],
    ['formatVersion 3 (WAV segment files, not read)', (m) => { m.formatVersion = 3; }],
    ['formatVersion 0', (m) => { m.formatVersion = 0; }],
    ['formatVersion as a string', (m) => { m.formatVersion = '4'; }],
    ...['format', 'formatVersion', 'analyzerVersion', 'id', 'createdAt', 'duration', 'sampleRate', 'sourceSampleRate', 'channels', 'frames', 'source', 'segments', 'peaks', 'loudness']
        .map((field): [string, (m: any) => void] => [`no ${field}`, (m) => { delete m[field]; }]),
    ['sampleRate 0', (m) => { m.sampleRate = 0; }],
    ['channels 1.5', (m) => { m.channels = 1.5; }],
    ['negative duration', (m) => { m.duration = -1; }],
    ['revision 0', (m) => { m.revision = 0; }],
    ['no segments.source', (m) => { delete m.segments.source; }],
    ['source codec aac', (m) => { m.segments.source.codec = 'aac'; }],
    ['source without url', (m) => { delete m.segments.source.url; }],
    ['source bytes negative', (m) => { m.segments.source.bytes = -1; }],
    ['wav source without pcm', (m) => { delete m.segments.source.pcm; }],
    ['wav source pcm encoding pcm-int', (m) => { m.segments.source.pcm.encoding = 'pcm-int'; }],
    ['opus source without header', (m) => { m.segments.source.codec = 'opus'; }],
    ['flac source without header', (m) => { m.segments.source.codec = 'flac'; }],
    ['segment without range', (m) => { delete m.segments.list[0].range; }],
    ['segment without tail', (m) => { delete m.segments.list[0].tail; }],
    ['segment range of one number', (m) => { m.segments.list[0].range = [44]; }],
    ['segment range negative', (m) => { m.segments.list[0].range = [-1, 100]; }],
    ['segment lead a string', (m) => { m.segments.list[0].lead = '5'; }],
    ['segment trail 1.5', (m) => { m.segments.list[0].trail = 1.5; }],
    ['segments.list not an array', (m) => { m.segments.list = {}; }],
    ['peaks format', (m) => { m.peaks.format = 'other'; }],
    ['peak level without byteLength', (m) => { delete m.peaks.levels[0].byteLength; }],
    ['bands format', (m) => { m.bands.format = 'rtd-peaks'; }],
    ['spectrogram without url', (m) => { delete m.spectrogram.url; }],
    ['loudness without gatedRmsDb', (m) => { delete m.loudness.gatedRmsDb; }],
    ['source.name a number', (m) => { m.source.name = 3; }],
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
    ['gainDb +60', (m) => { m.stems.b.gainDb = 60; }],
    ['gainDb -61', (m) => { m.stems.b.gainDb = -61; }],
    // Fields the player does not read, typed by the schema all the same.
    ['stem loudness empty', (m) => { m.stems.b.loudness = {}; }],
    ['bands.bins negative', (m) => { m.bands.bins = -1; }],
    ['failed stem with segments a number', (m) => { m.stems.b.status = 'failed'; m.stems.b.segments = 5; }],
    ['peaks encoding float32', (m) => { m.peaks.encoding = 'float32'; }],
    ['processor params a string', (m) => { m.stems.b.processor = { id: 'x', version: '1', params: 'a=1' }; }],
    ['spectrogram rows 0', (m) => { m.spectrogram.rows = 0; }],
    ['alignment offsetFrames 1.5', (m) => { m.stems.b.alignment = { ...m.stems.b.alignment, offsetFrames: 1.5 }; }],
    ['loudness perChannel item a number', (m) => { m.loudness.perChannel = [3]; }],
    ['stem error a number', (m) => { m.stems.b.error = 503; }],
    // The limits the player allocates under (MIN_SAMPLE_RATE, MAX_SAMPLE_RATE, MAX_CHANNELS).
    ['sampleRate 7999', (m) => { m.sampleRate = 7999; }],
    ['sampleRate 384001', (m) => { m.sampleRate = 384001; }],
    ['sourceSampleRate 400000', (m) => { m.sourceSampleRate = 400000; }],
    ['channels 0', (m) => { m.channels = 0; }],
    ['channels 33', (m) => { m.channels = 33; }],
    ['source sampleRate 7999', (m) => { m.segments.source.sampleRate = 7999; }],
    ['source channels 33', (m) => { m.segments.source.channels = 33; }],
    ['stem source sampleRate 1000000', (m) => { m.stems.b.segments.source.sampleRate = 1000000; }],
    ['an opus source at 44100 Hz', (m) => { Object.assign(m.segments.source, { codec: 'opus', header: 'T3B1c0hlYWQ=', sampleRate: 44100 }); }],
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

// Labels count characters as the schema does (code points): 120 emoji fit, 121 do not.
{
    const m = clone();
    m.stems.b.label = '\u{1F3B5}'.repeat(120);
    assert.ok(schemaOk(m) && assertOk(m), 'a label of 120 emoji must be accepted');
    m.stems.b.label = '\u{1F3B5}'.repeat(121);
    assert.ok(!schemaOk(m) && !assertOk(m), 'a label of 121 emoji must be refused');
    results.push('labels: 120 emoji accepted, 121 refused by both (code points)');
}

// Segments tile the timeline and stems sit on A's grid: assertManifest only (JSON Schema cannot express them).
{
    const tiling: Array<[string, (m: any) => void]> = [
        ['no segments', (m) => { m.segments.list = []; }],
        ['a gap between segments', (m) => { m.segments.list[1].startFrame += 1; }],
        ['segments overlap', (m) => { m.segments.list[1].startFrame -= 1; }],
        ['an empty segment', (m) => { m.segments.list[0].frames = 0; }],
        ['segments shorter than the timeline', (m) => { m.frames += 1; }],
        ['an index out of order', (m) => { m.segments.list[1].index = 5; }],
        ['a ready stem with a segment fewer', (m) => { m.stems.b.segments.list.pop(); }],
        ['a ready stem off the grid', (m) => { m.stems.b.segments.list[0].frames -= 1; m.stems.b.segments.list[1].startFrame -= 1; }],
        ['a range past the source', (m) => { m.segments.list[0].range = [44, m.segments.source.bytes + 1]; }],
        ['a range that ends where it starts', (m) => { m.segments.list[0].range = [100, 100]; }],
        ['lead + trail longer than the segment', (m) => { m.segments.list[0].lead = m.segments.list[0].frames; m.segments.list[0].trail = 1; }],
    ];
    for (const [name, mutate] of tiling) {
        const m = clone();
        mutate(m);
        assert.equal(assertOk(m), false, `assertManifest accepted: ${name}`);
    }
    results.push(`${tiling.length} manifests off the grid (gaps, overlaps, empty or short lists, stems off A's grid, ranges past the source or empty, lead + trail too long): refused by assertManifest (documented: not expressible in the schema)`);
}

// Rules across fields: segments of at most MAX_SEGMENT_SECONDS at the timeline's rate, and sources
// that decode to the timeline (A) or to A's rate with A's channels or one (a stem). assertManifest
// only (JSON Schema cannot compare fields): the schema accepts these.
{
    const rate = base.sampleRate;
    const over = MAX_SEGMENT_SECONDS * rate + 1;
    const oneSegment = (frames: number) => (m: any) => {
        delete m.stems;
        m.frames = frames;
        m.duration = frames / rate;
        m.segments.list = [{ ...m.segments.list[0], frames, tail: frames }];
    };
    const crossField: Array<[string, (m: any) => void, RegExp]> = [
        ['one segment of 2^27 frames (a 1 GB allocation)', oneSegment(2 ** 27), /over 60 s/],
        [`one segment of ${MAX_SEGMENT_SECONDS} s + 1 frame`, oneSegment(over), /over 60 s/],
        [`framesPerSegment of ${MAX_SEGMENT_SECONDS} s + 1 frame`, (m) => { m.segments.framesPerSegment = over; }, /framesPerSegment is over 60 s/],
        ['a stem segment over 60 s', (m) => { m.stems.b.status = 'failed'; m.stems.b.segments.list[0].frames = over; }, /stems\.b\.segments\.list\[0\] is over 60 s/],
        ['A source at another rate', (m) => { m.segments.source.sampleRate = 44100; }, /the timeline is 48000/],
        ['A source with other channels', (m) => { m.segments.source.channels = 2; }, /the timeline is/],
        ['a stem source at another rate', (m) => { m.stems.b.segments.source.sampleRate = 44100; }, /A's rate/],
        ['a stereo stem under a mono A', (m) => { m.stems.b.segments.source.channels = 2; }, /A's channels/],
    ];
    for (const [name, mutate, reason] of crossField) {
        const m = clone();
        mutate(m);
        assert.ok(schemaOk(m), `the schema should accept (not expressible): ${name} (${JSON.stringify(validate.errors)})`);
        assert.match(manifestProblem(m) ?? 'accepted', reason, `assertManifest: ${name}`);
    }
    results.push(`${crossField.length} manifests with segments over ${MAX_SEGMENT_SECONDS} s or sources off the timeline's rate and channels: refused by assertManifest (documented: not expressible in the schema)`);
    // A mono stem under a stereo A plays on both channels.
    const m = clone();
    m.channels = 2;
    Object.assign(m.segments.source, { channels: 2, pcm: { ...m.segments.source.pcm, blockAlign: 4 } });
    assert.ok(schemaOk(m) && assertOk(m), `a mono stem under a stereo A must be accepted: ${manifestProblem(m)}`);
    results.push('a mono stem under a stereo A: accepted by both');
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
