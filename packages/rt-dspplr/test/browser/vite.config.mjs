import { defineConfig } from 'vite';
// Pre-bundle the harness's dependencies up front: discovering them on the first
// page load made Vite re-optimize and reload the page under a running test.
export default defineConfig({
    server: { host: '127.0.0.1', port: 4179, strictPort: true },
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { include: ['react', 'react/jsx-runtime', 'react-dom/client'] },
});
