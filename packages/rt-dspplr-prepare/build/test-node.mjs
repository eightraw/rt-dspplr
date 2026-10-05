// Bundles test/prepare.test.ts with esbuild and runs it. The analysis worker is
// built next to the bundle (the pool looks for prepare-worker.mjs there).
// `@saitdigital/rt-dspplr/format` stays external: the tests run against the
// built player package (npm run build -w packages/rt-dspplr first).
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
    // The schema JSON and ajv are bundled; the format code is imported from the built package.
    plugins: [{
        name: 'format-external',
        setup(b) {
            b.onResolve({ filter: /^@saitdigital\/rt-dspplr\/format$/ }, (args) => ({ path: args.path, external: true }));
        },
    }],
};
await build({ ...common, entryPoints: [path.join(root, 'src/worker.ts')], outfile: path.join(outDir, 'prepare-worker.mjs') });
const outFile = path.join(outDir, 'prepare.test.mjs');
await build({ ...common, entryPoints: [path.join(root, 'test/prepare.test.ts')], outfile: outFile });
await import(pathToFileURL(outFile).href);
