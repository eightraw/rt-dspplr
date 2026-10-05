import { defineConfig } from 'vite';
import { inlineWorkersPlugin } from '../../build/inline-plugin.ts';
// Pre-bundle the harness's dependencies up front: discovering them on the first
// page load made Vite re-optimize and reload the page under a running test.
// The harness uses the built entries (dist/) for everything public; the few
// engine internals the engine tests drive directly are served from src/, with
// the same inline-worker plugin as the library build.
export default defineConfig({
    server: { host: '127.0.0.1', port: 4179, strictPort: true },
    plugins: [inlineWorkersPlugin()],
    define: { __RTD_VERSION__: JSON.stringify('test') },
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { include: ['react', 'react/jsx-runtime', 'react-dom/client'] },
});
