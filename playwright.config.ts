import { defineConfig } from '@playwright/test';
import { APP_ENV, APP_PORT, APP_URL, ATLASSIAN_MOCK_URL, WEBHOOK_URL } from './tests/e2e/support/env';

// E2E suite (task 39): the real app (next dev), worker and database against local Atlassian and webhook mocks, with
// the scripted FakeLlmClient. One app, one database and one mock are shared, so specs run serially.
// Servers start in this order: mocks, then web (creates the e2e database and migrates), then the worker.
const env = { ...(process.env as Record<string, string>), ...APP_ENV };

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: APP_URL,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      name: 'atlassian-mock',
      command: 'npx tsx tests/e2e/mocks/atlassianMock.ts',
      url: `${ATLASSIAN_MOCK_URL}/__mock/health`,
      env,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      name: 'webhook-receiver',
      command: 'npx tsx tests/e2e/mocks/webhookReceiver.ts',
      url: `${WEBHOOK_URL}/__mock/health`,
      env,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      name: 'web',
      command: `npx tsx tests/e2e/support/prepareDb.ts && npm run migrate && npx next dev --port ${APP_PORT}`,
      url: `${APP_URL}/login`,
      env,
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      name: 'worker',
      command: 'npm run worker',
      wait: { stdout: /\[worker\] started/ },
      stdout: 'pipe',
      env,
      timeout: 60_000,
    },
  ],
});
