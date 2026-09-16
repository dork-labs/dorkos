import { defineConfig, devices } from '@playwright/test';

/** Isolated browser proof for the independent community approval page. */
export default defineConfig({
  testDir: './browser-tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
});
