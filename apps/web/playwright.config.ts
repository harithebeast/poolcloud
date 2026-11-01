import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against an isolated stack with fake Google:
 *   docker compose -p pooldrive-e2e -f docker-compose.yml -f docker-compose.e2e.yml up -d --build
 *   pnpm --filter @pooldrive/web test:e2e
 * The tests create the first admin, so they need a fresh database (see docs/runbook.md).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
