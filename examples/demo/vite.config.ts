import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fakeObjectStoragePlugin } from './plugins/fakeObjectStorage'
import { longAudioListPlugin } from './plugins/longAudioList'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const storageDir = path.resolve(rootDir, process.env.STORAGE_DIR ?? 'storage/clips')
// Long-audio page (long.html): sources and their prepared folders.
const longDir = path.resolve(rootDir, process.env.LONG_STORAGE_DIR ?? 'storage/long')
const portRaw = Number(process.env.DEV_SERVER_PORT ?? '5173')
const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 5173

// Note what is NOT here: no worker, worklet, or WASM configuration for
// the player package. It is consumed from its built dist/ through the
// workspace link, exactly as an application would consume it from npm.
export default defineConfig({
    plugins: [
        react(),
        fakeObjectStoragePlugin({ dir: storageDir, bucket: 'clips' }),
        // Registered after 'clips', so /api/storage/list stays the clips bucket's.
        fakeObjectStoragePlugin({ dir: longDir, bucket: 'long' }),
        longAudioListPlugin({ dir: longDir, bucket: 'long' }),
    ],
    build: {
        rollupOptions: {
            input: {
                main: path.resolve(rootDir, 'index.html'),
                long: path.resolve(rootDir, 'long.html'),
            },
        },
    },
    optimizeDeps: {
        // Optional, Rubber Band entry only: rubberband-wasm is imported from a
        // worker, which Vite's dependency scan does not see, so without this the
        // dev server discovers it on first use and reloads the page once.
        include: ['rubberband-wasm'],
    },
    server: {
        port,
        watch: {
            usePolling: process.env.CHOKIDAR_USEPOLLING === 'true',
        },
    },
    preview: {
        port: port + 1,
    },
})
