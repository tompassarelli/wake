import { defineConfig } from '@playwright/test';

if (typeof Bun === 'undefined') {
  throw new Error('Wake browser tests must run under Bun');
}

const nixosChrome = '/run/current-system/sw/bin/google-chrome-stable';
const executablePath =
  process.env.WAKE_PLAYWRIGHT_EXECUTABLE_PATH ??
  (Bun.file(nixosChrome).size > 0 ? nixosChrome : undefined);
const portText = process.env.WAKE_BROWSER_PORT ?? '8080';
const port = Number(portText);

if (
  !/^[0-9]+$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
) {
  throw new Error(`invalid WAKE_BROWSER_PORT: ${portText}`);
}

const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: {
    baseURL,
    headless: true,
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  webServer: {
    command: 'bun --no-install bin/serve.mjs',
    port,
    reuseExistingServer: process.env.WAKE_BROWSER_SERVER_MANAGED === '1',
  },
});
