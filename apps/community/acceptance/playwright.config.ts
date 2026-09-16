/**
 * Playwright configuration for the sealed packaged Community acceptance proof.
 *
 * The deployment runner starts every service. This config only refuses a
 * missing contract and writes the machine-readable report the runner audits.
 */
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const root = process.env.COMMUNITY_ACCEPTANCE_ROOT;
if (!root) throw new Error('COMMUNITY_ACCEPTANCE_ROOT is required for packaged acceptance.');

export default defineConfig({
  testDir: '.',
  testMatch: 'driver.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: resolve(root, 'playwright-artifacts'),
  reporter: [['list'], ['json', { outputFile: resolve(root, 'playwright-report.json') }]],
  timeout: 120_000,
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
