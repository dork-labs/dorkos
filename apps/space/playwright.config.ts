import { defineConfig, devices } from '@playwright/test';

/** Isolated browser proof for the independent community. */
export default defineConfig({
  testDir: './browser-tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: 'browser-report.json' }]],
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
});
