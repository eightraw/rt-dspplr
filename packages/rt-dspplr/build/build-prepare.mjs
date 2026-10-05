// Builds the Node-only "./prepare" entry, the `rtd-prepare` CLI and the
// analysis worker with esbuild:
//   dist/prepare.js          prepareAudio(), storage adapters, formats
//   dist/prepare-cli.js      main(argv) for bin/rtd-prepare.mjs
//   dist/prepare-worker.mjs  worker_threads entry for the analysis jobs
// No code splitting: the pool finds the worker next to the module that
// starts it (`new URL('./prepare-worker.mjs', import.meta.url)`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const common = {
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'warning',
    outdir: path.join(root, 'dist'),
};

await build({
    ...common,
    entryPoints: {
        prepare: path.join(root, 'src/prepare/index.ts'),
        'prepare-cli': path.join(root, 'src/prepare/cli.ts'),
    },
});
await build({
    ...common,
    entryPoints: { 'prepare-worker': path.join(root, 'src/prepare/worker.ts') },
    outExtension: { '.js': '.mjs' },
});
