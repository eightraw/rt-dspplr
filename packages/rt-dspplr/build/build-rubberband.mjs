// Builds the optional "./stretch-rubberband" entry with esbuild.
//
// Two files, both plain ES modules:
//   dist/stretch-rubberband.js  main-thread strategy; contains the literal
//                               `new Worker(new URL('./rubberband-worker.js', import.meta.url), { type: 'module' })`
//   dist/rubberband-worker.js   the worker; keeps `import ... from 'rubberband-wasm'` bare and
//                               `new URL('rubberband-wasm/dist/rubberband.wasm', import.meta.url)`
//
// Both expressions are left for the application's bundler, which bundles the
// worker together with the application's own copy of rubberband-wasm. Nothing
// from rubberband-wasm (GPL-2.0-or-later) is copied into this package.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const common = {
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'warning',
    outdir: path.join(root, 'dist'),
    external: ['rubberband-wasm', 'rubberband-wasm/*'],
};

await build({
    ...common,
    entryPoints: { 'stretch-rubberband': path.join(root, 'src/stretch-rubberband/index.ts') },
});

await build({
    ...common,
    entryPoints: { 'rubberband-worker': path.join(root, 'src/stretch-rubberband/rubberband.worker.ts') },
});
