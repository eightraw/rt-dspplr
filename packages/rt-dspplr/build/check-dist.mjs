// Post-build checks + size report.
//  - "." and "./react" (and every chunk they load) must not reference rubberband-wasm.
//  - No file in dist/ may reference Node-only modules (the package is for browsers;
//    Node-only code lives in @saitdigital/rt-dspplr-prepare).
//  - "./format" loads only the pure format chunk: no engine, DOM, worker or Node code.
//  - Vendored third-party code ships with its notice (in the chunk and in
//    THIRD_PARTY_NOTICES.md, which package.json "files" must list).
//  - The manifest JSON Schema is in place and is draft 2020-12.
//  - "./stretch-rubberband" must keep rubberband-wasm as a bare import and must
//    not contain the WASM binary.
//  - Sizes per entry: own file + statically imported chunks, raw and gzip.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const errors = [];

function read(rel) {
    return fs.readFileSync(path.join(dist, rel), 'utf8');
}

function staticImports(rel, seen = new Set()) {
    if (seen.has(rel)) return seen;
    seen.add(rel);
    const code = read(rel);
    const re = /(?:^|[;\n])\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|(?:^|[;\n])\s*import\s*['"](\.[^'"]+)['"]/g;
    for (const match of code.matchAll(re)) {
        const spec = match[1] ?? match[2];
        const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
        staticImports(next, seen);
    }
    return seen;
}

function size(files) {
    let raw = 0;
    let gz = 0;
    for (const file of files) {
        const buf = fs.readFileSync(path.join(dist, file));
        raw += buf.length;
        gz += zlib.gzipSync(buf, { level: 9 }).length;
    }
    return { raw, gz };
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const report = [];

for (const entry of ['index.js', 'react.js', 'advanced.js', 'format.js']) {
    const files = [...staticImports(entry)];
    for (const file of files) {
        const code = read(file);
        if (/rubberband-wasm|RubberBandInterface|rubberband.wasm|rubberband-worker/.test(code)) {
            errors.push(`${file} (loaded by ${entry}) references rubberband-wasm or the Rubber Band worker`);
        }
    }
    const { raw, gz } = size(files);
    report.push({ entry, files: files.length, raw, gz });
}

// ---- no Node-only code anywhere in dist ------------------------------------------------
function walkDist(dir = dist) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        return e.isDirectory() ? walkDist(full) : [path.relative(dist, full).split(path.sep).join('/')];
    });
}
const nodeOnly = /\bfrom\s*["'](?:node:[\w/]+|fs|fs\/promises|path|os|child_process|worker_threads|crypto|stream|http|https|net|url|module)["']|\brequire\(\s*["'](?:node:|fs|path|os|child_process|worker_threads)|\bimport\(\s*["']node:|\bworker_threads\b|\bnode:fs\b|\bprocess\.(?:argv|exit|cwd)\b/;
for (const file of walkDist().filter((f) => /\.(m?js|d\.ts)$/.test(f))) {
    if (nodeOnly.test(read(file))) errors.push(`${file} references a Node-only module (worker_threads, node:fs, ...)`);
}
for (const file of walkDist()) {
    if (/(^|\/)(rtd-)?prepare([-./]|$)/i.test(file)) errors.push(`${file}: prepare code belongs to @saitdigital/rt-dspplr-prepare`);
}

// ---- "./format" is the pure format chunk only ------------------------------------------
{
    const files = [...staticImports('format.js')];
    for (const file of files) {
        if (/chunks\/core-/.test(file)) errors.push(`format.js loads the engine chunk ${file}`);
        const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/\b(?:window|document|navigator|AudioContext|AudioWorkletNode|importScripts)\b|new Worker\(|URL\.createObjectURL/.test(code)) {
            errors.push(`${file} (loaded by format.js) uses a browser-only API`);
        }
    }
}

// ---- third-party notices -------------------------------------------------------------------
{
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const noticesFile = path.join(root, 'THIRD_PARTY_NOTICES.md');
    if (!pkg.files?.includes('THIRD_PARTY_NOTICES.md')) errors.push('package.json "files" does not list THIRD_PARTY_NOTICES.md');
    const notices = fs.existsSync(noticesFile) ? fs.readFileSync(noticesFile, 'utf8') : '';
    if (!/Signalsmith Stretch/.test(notices) || !/Permission is hereby granted/.test(notices)) errors.push('THIRD_PARTY_NOTICES.md lacks the Signalsmith Stretch MIT notice');
    // Every vendored source (src/vendor/*) must have its notice in the chunk it ends up in.
    const vendored = walkDist().filter((f) => /^chunks\/signalsmithStretch-.*\.js$/.test(f));
    if (vendored.length !== 1) errors.push(`expected one Signalsmith Stretch chunk, found ${vendored.length}`);
    for (const file of vendored) {
        const code = read(file);
        if (!/Signalsmith Stretch [\d.]+ \(npm "signalsmith-stretch"\), MIT License/.test(code) || !/Permission is hereby granted/.test(code)) {
            errors.push(`${file} lost its MIT notice`);
        }
    }
    // The source-run decoders: each chunk carries its license as data.
    const decoders = [
        { name: 'rtdDecodeMp3', notice: /dr_mp3 and dr_flac by David Reid/ },
        { name: 'rtdDecodeFlac', notice: /dr_mp3 and dr_flac by David Reid/ },
        { name: 'rtdDecodeOpus', notice: /libopus [\d.]+ \(https:\/\/opus-codec\.org\), BSD-3-Clause/ },
    ];
    if (!/## dr_mp3 and dr_flac/.test(notices) || !/ALTERNATIVE 1 - Public Domain/.test(notices)) errors.push('THIRD_PARTY_NOTICES.md lacks the dr_mp3/dr_flac notice');
    if (!/## libopus/.test(notices) || !/Redistribution and use in source and binary forms/.test(notices)) errors.push('THIRD_PARTY_NOTICES.md lacks the libopus notice');
    for (const d of decoders) {
        const chunks = walkDist().filter((f) => f.startsWith(`chunks/${d.name}-`) && f.endsWith('.js'));
        if (chunks.length !== 1) errors.push(`expected one ${d.name} chunk, found ${chunks.length}`);
        for (const file of chunks) {
            const code = read(file);
            if (!d.notice.test(code)) errors.push(`${file} lost its notice`);
            if (d.name === 'rtdDecodeOpus' && !/Redistribution and use in source and binary forms/.test(code)) errors.push(`${file} lost the BSD text`);
        }
    }
    // Our own code, built from wasm/split.c (no third-party notice): one chunk.
    const splitChunks = walkDist().filter((f) => f.startsWith('chunks/rtdSplit-') && f.endsWith('.js'));
    if (splitChunks.length !== 1) errors.push(`expected one rtdSplit chunk, found ${splitChunks.length}`);
    const known = new Set(['signalsmithStretch.ts', 'rtdSplit.ts', ...decoders.map((d) => `${d.name}.ts`)]);
    const vendorDir = path.join(root, 'src', 'vendor');
    for (const name of fs.existsSync(vendorDir) ? fs.readdirSync(vendorDir) : []) {
        if (!known.has(name)) errors.push(`src/vendor/${name}: new vendored code needs a notice check in check-dist and THIRD_PARTY_NOTICES.md`);
    }
}

// ---- the manifest schema -------------------------------------------------------------------
{
    const schemaFile = path.join(root, 'schema', 'manifest.schema.json');
    try {
        const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
        if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') errors.push('schema/manifest.schema.json is not draft 2020-12');
    } catch (error) {
        errors.push(`schema/manifest.schema.json: ${error.message}`);
    }
}

if (!/^['"]use client['"];/.test(read('react.js'))) {
    errors.push("react.js does not start with 'use client'");
}

const rbEntry = read('stretch-rubberband.js');
if (!/new Worker\(\s*new URL\(\s*["']\.\/rubberband-worker\.js["']\s*,\s*import\.meta\.url\s*\)/.test(rbEntry)) {
    errors.push('stretch-rubberband.js lost the literal new Worker(new URL("./rubberband-worker.js", import.meta.url)) form');
}
const rbWorker = read('rubberband-worker.js');
if (!/from\s*["']rubberband-wasm["']/.test(rbWorker)) {
    errors.push('rubberband-worker.js does not import rubberband-wasm as a bare specifier');
}
if (/RubberBandInterface\s*=|class\s+RubberBandInterface/.test(rbWorker) || /AGFzbQ/.test(rbWorker)) {
    errors.push('rubberband-worker.js appears to embed rubberband-wasm code or WASM bytes');
}
if (fs.readdirSync(dist).some((name) => name.endsWith('.wasm'))) {
    errors.push('a .wasm file was emitted into dist');
}
for (const file of ['stretch-rubberband.js', 'rubberband-worker.js']) {
    const { raw, gz } = size([file]);
    report.push({ entry: file, files: 1, raw, gz });
}
{
    const { raw, gz } = size(['styles.css']);
    report.push({ entry: 'styles.css', files: 1, raw, gz });
}

console.log('\nBundle sizes (entry + statically imported chunks):');
// Ship measurements with the exact build instead of maintaining stale README numbers.
fs.writeFileSync(path.join(dist, 'bundle-sizes.json'), JSON.stringify({
    units: 'bytes', minified: false, gzipLevel: 9,
    note: 'Sum of each entry and its static chunks; entries share chunks, so do not add rows together.',
    entries: report,
}, null, 2) + '\n');
for (const row of report) {
    console.log(`  ${row.entry.padEnd(24)} ${String(row.files).padStart(2)} file(s)  ${kb(row.raw).padStart(9)}  gzip ${kb(row.gz).padStart(8)}`);
}

if (errors.length > 0) {
    console.error('\ncheck-dist FAILED:\n  ' + errors.join('\n  '));
    process.exit(1);
}
console.log('\ncheck-dist OK: no Node-only code, ./format is pure, notices and schema in place; core/react are free of rubberband-wasm, the optional entry keeps it external.\n');
