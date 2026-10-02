import { defineConfig } from '@playwright/test';

/** Self-contained real-app security proof: ephemeral listeners and data, no inference. */
export default defineConfig({
  testDir: './tests/workbench',
  testMatch: 'served-document-isolation.spec.ts',
  reporter: [['list'], ['./reporters/manifest-reporter.ts']],
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: { browserName: 'chromium', trace: 'retain-on-failure', video: 'on' },
});
