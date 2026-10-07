// Builds the package's "./prepare" entry (Node) with esbuild, after the player's build,
// then its declarations:
//   dist/prepare/index.js            prepareAudio(), attachStem(), processors, storage adapters
//   dist/prepare/cli.js              main(argv) for bin/rtd-prepare.mjs
//   dist/prepare/prepare-worker.mjs  worker_threads entry for the analysis jobs
//   dist/prepare/types/              declarations
// The formats (manifest, peaks, bands, spectrogram, WAV) and the shared analysis kernels
// are imported as "@saitdigital/rt-dspplr/format", the package's own "./format" entry: Node
// resolves the name to the package itself (dist/format.js), also from a worker file a
// bundler copied elsewhere (through node_modules). One implementation for both sides.
// No code splitting: the pool finds the worker next to the module that starts
// it (`new URL('./prepare-worker.mjs', import.meta.url)`).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist', 'prepare');
fs.rmSync(dist, { recursive: true, force: true });
if (!fs.existsSync(path.join(root, 'dist', 'format.js'))) throw new Error('dist/format.js is missing: build-prepare runs after the player build');

const common = {
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'warning',
    outdir: dist,
    plugins: [formatByName()],
};

/** "@saitdigital/rt-dspplr/format" stays the package's own entry (external, by name). */
function formatByName() {
    return {
        name: 'format-by-name',
        setup(b) {
            b.onResolve({ filter: /^@saitdigital\/rt-dspplr\/format$/ }, (args) => ({ path: args.path, external: true }));
            b.onResolve({ filter: /^@saitdigital\/rt-dspplr(\/.*)?$/ }, (args) => ({ errors: [{ text: `${args.path}: prepare imports only the package's "./format"` }] }));
        },
    };
}

await build({ ...common, entryPoints: { index: path.join(root, 'src/prepare/index.ts') } });
// The CLI imports the built index.js instead of carrying a second copy of it.
await build({
    ...common,
    entryPoints: { cli: path.join(root, 'src/prepare/cli.ts') },
    plugins: [formatByName(), {
        name: 'cli-uses-index',
        setup(b) {
            b.onResolve({ filter: /^\.\/index$/ }, () => ({ path: './index.js', external: true }));
        },
    }],
});
await build({
    ...common,
    entryPoints: { 'prepare-worker': path.join(root, 'src/prepare/worker.ts') },
    outExtension: { '.js': '.mjs' },
});

// Declarations, with explicit .js extensions on relative specifiers (node16/nodenext consumers).
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.prepare.build.json')], { stdio: 'inherit' });
let rewritten = 0;
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.d.ts') ? [path.join(dir, e.name)] : []));
for (const file of walk(path.join(dist, 'types'))) {
    const source = fs.readFileSync(file, 'utf8');
    const fixed = source.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]*)\2/g, (match, lead, quote, spec) => {
        if (/\.(js|mjs|json)$/.test(spec)) return match;
        rewritten += 1;
        return `${lead}${quote}${spec.replace(/\.ts$/, '')}.js${quote}`;
    });
    if (fixed !== source) fs.writeFileSync(file, fixed);
}

// One implementation of the formats: the bundles import them and carry no copy.
const errors = [];
const code = (file) => fs.readFileSync(path.join(dist, file), 'utf8');
for (const file of ['index.js', 'cli.js', 'prepare-worker.mjs']) {
    if (/['"](RTDP|RTDS|RTDB|rtd-audio-manifest)['"]/.test(code(file))) errors.push(`${file} carries format code that belongs to the "./format" entry`);
}
if (!/from\s*["']\.\/index\.js["']/.test(code('cli.js'))) errors.push('cli.js does not import ./index.js');
for (const file of ['index.js', 'prepare-worker.mjs']) {
    if (!/from\s*["']@saitdigital\/rt-dspplr\/format["']/.test(code(file))) errors.push(`${file} does not import @saitdigital/rt-dspplr/format`);
}
if (errors.length) {
    console.error(`build FAILED:\n  ${errors.join('\n  ')}`);
    process.exit(1);
}
const sizes = fs.readdirSync(dist).filter((f) => /\.m?js$/.test(f)).map((f) => `${f} ${(fs.statSync(path.join(dist, f)).size / 1024).toFixed(1)} KB`);
console.log(`./prepare built: ${sizes.join(', ')}; ${rewritten} declaration specifiers now carry .js`);
