import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import { inlineWorkersPlugin } from '../../build/inline-plugin.ts';

/**
 * `/__slow/<KB per second>/<path>`: a file under the server's root, Range requests answered,
 * its bytes sent at that rate in 20 ms slices, so a test sees a response arrive as a slow
 * network delivers it (Playwright's routes hand a body over whole).
 */
function slowFiles() {
    return {
        name: 'rtd-slow-files',
        configureServer(server) {
            server.middlewares.use('/__slow', (req, res, next) => {
                const m = /^\/(\d+)(\/[^?]*)/.exec(req.url ?? '');
                if (!m) return next();
                const root = path.resolve(server.config.root);
                const file = path.resolve(root, `.${decodeURIComponent(m[2])}`);
                if (!file.startsWith(root) || !fs.existsSync(file)) return next();
                const size = fs.statSync(file).size;
                const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
                const start = range ? Number(range[1]) : 0;
                const end = range && range[2] ? Number(range[2]) + 1 : size;
                const bytes = fs.readFileSync(file).subarray(start, end);
                res.statusCode = range ? 206 : 200;
                res.setHeader('Accept-Ranges', 'bytes');
                res.setHeader('Content-Length', String(bytes.length));
                res.setHeader('Cache-Control', 'no-store');
                if (range) res.setHeader('Content-Range', `bytes ${start}-${end - 1}/${size}`);
                const slice = Math.max(1, Math.round((Number(m[1]) * 1024 * 20) / 1000));
                let at = 0;
                let closed = false;
                res.on('close', () => { closed = true; });
                const send = () => {
                    if (closed) return;
                    if (at >= bytes.length) return void res.end();
                    res.write(bytes.subarray(at, at + slice));
                    at += slice;
                    setTimeout(send, 20);
                };
                send();
            });
        },
    };
}

// Pre-bundle the harness's dependencies up front: discovering them on the first
// page load made Vite re-optimize and reload the page under a running test.
// The harness uses the built entries (dist/) for everything public; the few
// engine internals the engine tests drive directly are served from src/, with
// the same inline-worker plugin as the library build.
export default defineConfig({
    server: { host: '127.0.0.1', port: 4179, strictPort: true },
    plugins: [inlineWorkersPlugin(), slowFiles()],
    define: { __RTD_VERSION__: JSON.stringify('test') },
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { include: ['react', 'react/jsx-runtime', 'react-dom/client'] },
});
