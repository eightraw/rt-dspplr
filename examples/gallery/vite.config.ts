import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The player package comes from its built dist/ through the workspace link,
// as an application would get it from npm: no worker or worklet settings here.
export default defineConfig({
    plugins: [react()],
    server: { port: 5175 },
    preview: { port: 5176 },
})
