import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { inlineWorkersPlugin } from './build/inline-plugin';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version as string;

/** Modules of the "./format" entry: pure code, no DOM / worker / Node APIs (check-dist verifies). */
const FORMAT_MODULES = /[\\/]src[\\/]core[\\/](stream[\\/](manifest|peaksFile|bandsFile|spectrogramFile|wavFormat|sourceRuns)|spectrogram[\\/]spectral|dsp[\\/]highPass)\.ts$/;

// Library build for the ".", "./react", "./advanced" and "./format" entries. The optional
// "./stretch-rubberband" entry is built separately by build/build-rubberband.mjs
// (it must keep a bare `rubberband-wasm` import and a `new Worker(new URL(...))`
// expression for the consumer's bundler, which Vite's lib mode would rewrite).
export default defineConfig({
    plugins: [inlineWorkersPlugin()],
    define: {
        __RTD_VERSION__: JSON.stringify(version),
    },
    esbuild: {
        jsx: 'automatic',
    },
    build: {
        target: 'es2020',
        outDir: 'dist',
        emptyOutDir: false,
        sourcemap: true,
        // Readable output; applications minify their own bundles.
        minify: false,
        copyPublicDir: false,
        lib: {
            entry: {
                index: path.resolve(rootDir, 'src/index.ts'),
                react: path.resolve(rootDir, 'src/react/index.ts'),
                advanced: path.resolve(rootDir, 'src/advanced.ts'),
                format: path.resolve(rootDir, 'src/format.ts'),
            },
            formats: ['es'],
        },
        rollupOptions: {
            external: [/^react($|\/)/, /^react-dom($|\/)/, /^rubberband-wasm($|\/)/],
            output: {
                entryFileNames: '[name].js',
                chunkFileNames: 'chunks/[name]-[hash].js',
                // The pure format code in a chunk of its own: "./format" loads only that
                // (in Node too). One shared chunk for the engine, used by the browser entries.
                manualChunks(id) {
                    if (FORMAT_MODULES.test(id)) return 'format';
                    return /[\\/]src[\\/]core[\\/]/.test(id) ? 'core' : undefined;
                },
                // Next.js App Router: the React entry is a client module.
                banner: (chunk) => (chunk.isEntry && chunk.name === 'react' ? "'use client';" : ''),
            },
        },
    },
});
