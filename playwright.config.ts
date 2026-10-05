import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: { baseURL: process.env.APP_BASE_URL ?? 'http://localhost:3000' },
});
