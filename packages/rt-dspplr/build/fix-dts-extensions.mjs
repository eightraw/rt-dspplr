// Rewrites relative specifiers in the emitted declarations to explicit
// `.js` paths ('./core/AudioPlayer' -> './core/AudioPlayer.js',
// './core/engine' -> './core/engine/index.js'), so the types resolve under
// every TypeScript moduleResolution mode, including node16/nodenext, which
// require extensions in ESM packages. tsc does not add them for
// moduleResolution "bundler" sources.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const typesDir = path.join(root, 'dist', 'types');

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : entry.name.endsWith('.d.ts') ? [full] : [];
    });
}

let rewritten = 0;
const unresolved = [];

for (const file of walk(typesDir)) {
    const dir = path.dirname(file);
    const source = fs.readFileSync(file, 'utf8');
    const fixed = source.replace(
        /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\2/g,
        (match, lead, quote, spec) => {
            if (/\.(js|mjs|cjs|json|css)$/.test(spec)) return match;
            const bare = spec.replace(/\.ts$/, '');
            let next = null;
            if (fs.existsSync(path.join(dir, `${bare}.d.ts`))) next = `${bare}.js`;
            else if (fs.existsSync(path.join(dir, bare, 'index.d.ts'))) next = `${bare}/index.js`;
            if (!next) {
                unresolved.push(`${path.relative(typesDir, file)}: ${spec}`);
                return match;
            }
            rewritten += 1;
            return `${lead}${quote}${next}${quote}`;
        },
    );
    if (fixed !== source) fs.writeFileSync(file, fixed);
}

if (unresolved.length > 0) {
    console.error(`fix-dts-extensions: unresolved specifiers:\n  ${unresolved.join('\n  ')}`);
    process.exit(1);
}
console.log(`fix-dts-extensions: ${rewritten} relative specifiers now carry .js`);
