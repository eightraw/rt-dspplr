import path from 'node:path';
import { build as esbuild } from 'esbuild';
import type { Plugin } from 'vite';

/**
 * Bundles worker and AudioWorklet entry files into self-contained scripts
 * that are embedded in the library output as strings and started from Blob
 * URLs at runtime. The published package therefore has no separate worker
 * files to resolve, and consumers need no bundler configuration (Vite,
 * webpack 5, Next.js, plain ESM all work the same way).
 *
 *   import createWorker from './x.worker.ts?inline-worker'
 *   const worker = createWorker();                       // new Worker(blobUrl)
 *
 *   import getWorkletUrl from './x.worklet.ts?inline-worklet'
 *   await ctx.audioWorklet.addModule(getWorkletUrl());   // blob URL, created once
 *
 * Trade-off: the page's Content-Security-Policy must allow `blob:` in
 * worker-src (workers) and script-src (AudioWorklet). Without it the player
 * still works, falling back to native playbackRate and native DSP nodes.
 */
export function inlineWorkersPlugin(options: { minify?: boolean } = {}): Plugin {
    const minify = options.minify ?? true;
    const marker = /\?(inline-worker|inline-worklet)$/;

    return {
        name: 'rtd-inline-workers',
        enforce: 'pre',

        async resolveId(source, importer) {
            const match = marker.exec(source);
            if (!match) return null;
            const cleanSource = source.slice(0, -match[0].length);
            const resolved = await this.resolve(cleanSource, importer, { skipSelf: true });
            if (!resolved) return null;
            return `\0${match[1]}:${resolved.id}`;
        },

        async load(id) {
            const match = /^\0(inline-worker|inline-worklet):(.*)$/.exec(id);
            if (!match) return null;
            const [, kind, filePath] = match;

            const result = await esbuild({
                entryPoints: [filePath],
                bundle: true,
                write: false,
                format: 'iife',
                platform: 'browser',
                target: 'es2020',
                minify,
                legalComments: 'none',
                metafile: true,
                logLevel: 'silent',
            });

            for (const input of Object.keys(result.metafile.inputs)) {
                this.addWatchFile(path.resolve(input));
            }

            const code = result.outputFiles[0].text;
            const name = path.basename(filePath).replace(/\.(worker|worklet)\.[cm]?[jt]s$/, '');

            if (kind === 'inline-worker') {
                return [
                    `const code = ${JSON.stringify(code)};`,
                    'let url = null;',
                    `/** Start the "${name}" worker from an inlined Blob URL. */`,
                    'export default function createWorker() {',
                    "    if (url === null) url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));",
                    `    return new Worker(url, { name: ${JSON.stringify(`rtd-${name}`)} });`,
                    '}',
                ].join('\n');
            }

            return [
                `const code = ${JSON.stringify(code)};`,
                'let url = null;',
                `/** Blob URL of the "${name}" AudioWorklet module (created on first use). */`,
                'export default function getWorkletUrl() {',
                "    if (url === null) url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));",
                '    return url;',
                '}',
            ].join('\n');
        },
    };
}
