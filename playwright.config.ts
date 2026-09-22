import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineConfig } from '@playwright/test';

const port = process.env.E2E_PORT ?? '3119';
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const fixtureFile = process.env.E2E_FIXTURE_FILE ?? join(tmpdir(), `codex-status-dashboard-e2e-${randomUUID()}.json`);
process.env.E2E_FIXTURE_FILE = fixtureFile;

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
  webServer: {
    command: 'tsx tests/e2e/web-server.ts',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      E2E_FIXTURE_FILE: fixtureFile,
      E2E_PORT: port,
      APP_ORIGIN: baseURL,
    } as Record<string, string>,
  },
});
