import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
    launchOptions: {
      executablePath: '/run/current-system/sw/bin/google-chrome-stable',
    },
  },
  webServer: {
    command: 'node bin/serve.mjs',
    port: 8080,
    reuseExistingServer: true,
  },
});
