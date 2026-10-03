// Post-build checks + size report.
//  - "." and "./react" (and every chunk they load) must not reference rubberband-wasm.
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

for (const entry of ['index.js', 'react.js', 'advanced.js']) {
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
console.log('\ncheck-dist OK: core/react are free of rubberband-wasm; the optional entry keeps it external.\n');
