// Bundles test/prepare.test.ts (the "./prepare" entry's tests) with esbuild and runs it.
// The analysis worker is built next to the bundle (the pool looks for prepare-worker.mjs
// there). "@saitdigital/rt-dspplr/format" and the schema are the package's own sources.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'node_modules', '.cache', 'rtd-prepare-test');
fs.mkdirSync(outDir, { recursive: true });
const common = {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
    alias: {
        '@saitdigital/rt-dspplr/format': path.join(root, 'src/format.ts'),
        '@saitdigital/rt-dspplr/manifest.schema.json': path.join(root, 'schema/manifest.schema.json'),
    },
    // The inline worker and worklet imports of the player's sources: not run here.
    plugins: [{
        name: 'stub-inline',
        setup(b) {
            b.onResolve({ filter: /\?inline-(worker|worklet)$/ }, (args) => ({ path: args.path, namespace: 'inline-stub' }));
            b.onLoad({ filter: /.*/, namespace: 'inline-stub' }, () => ({ contents: 'export default function stub() { throw new Error("not in node tests"); }', loader: 'js' }));
        },
    }],
};
await build({ ...common, entryPoints: [path.join(root, 'src/prepare/worker.ts')], outfile: path.join(outDir, 'prepare-worker.mjs') });
const outFile = path.join(outDir, 'prepare.test.mjs');
await build({ ...common, entryPoints: [path.join(root, 'test/prepare.test.ts')], outfile: outFile });
await import(pathToFileURL(outFile).href);
