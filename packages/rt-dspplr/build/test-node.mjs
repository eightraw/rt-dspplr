// Bundles the Node tests in test/*.test.ts with esbuild and runs them in turn.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'node_modules', '.cache', 'rtd-test');
fs.mkdirSync(outDir, { recursive: true });

// prepare's worker_threads entry, next to the bundled tests (the pool looks for it there).
await build({
    entryPoints: [path.join(root, 'src/prepare/worker.ts')],
    outfile: path.join(outDir, 'prepare-worker.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
});

for (const name of ['stretch', 'dynamics', 'ruler', 'prepare']) {
    const outFile = path.join(outDir, `${name}.test.mjs`);
    await build({
        entryPoints: [path.join(root, `test/${name}.test.ts`)],
        outfile: outFile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        logLevel: 'warning',
        // Worker modules are not exercised here; stub the inline imports.
        plugins: [{
            name: 'stub-inline-workers',
            setup(b) {
                b.onResolve({ filter: /\?inline-(worker|worklet)$/ }, (args) => ({ path: args.path, namespace: 'inline-stub' }));
                b.onLoad({ filter: /.*/, namespace: 'inline-stub' }, () => ({
                    contents: 'export default function stub() { throw new Error("workers are not available in node tests"); }',
                    loader: 'js',
                }));
            },
        }],
    });
    await import(pathToFileURL(outFile).href);
}
