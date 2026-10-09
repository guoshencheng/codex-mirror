import { defineConfig } from '@playwright/test';

const port = process.env.E2E_PORT ?? '3119';
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const displayPort = process.env.E2E_DISPLAY_PORT ?? '3120';
const displayURL = process.env.E2E_DISPLAY_BASE_URL ?? `http://127.0.0.1:${displayPort}`;
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  webServer: [
    {
      command: 'tsx tests/e2e/web-server.ts',
      url: `${baseURL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        E2E_PORT: port,
        APP_ORIGIN: baseURL,
        DASHBOARD_DISPLAY_ORIGINS: displayURL,
      } as Record<string, string>,
    },
    {
      command: `npm run display:dev -- --host 127.0.0.1 --port ${displayPort} --strictPort`,
      url: `${displayURL}/display/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
