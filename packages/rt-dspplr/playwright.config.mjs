import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './test/browser',
    timeout: 20000,
    workers: 1,
    use: { baseURL: 'http://127.0.0.1:4179', launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
    webServer: { command: 'node ../../node_modules/vite/bin/vite.js --config test/browser/vite.config.mjs', url: 'http://127.0.0.1:4179/test/browser/index.html', reuseExistingServer: false },
});
