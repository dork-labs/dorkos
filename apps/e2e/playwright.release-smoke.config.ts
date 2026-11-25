import { defineConfig, devices } from '@playwright/test';

/**
 * The release smoke (DOR-5123, design §6): one spec against a `dorkos` the
 * smoke job installed from the tarball a release is about to publish.
 *
 * Its own config, because nothing here boots a server: the job starts the
 * installed `dorkos` itself and names it in `RELEASE_SMOKE_URL`, and
 * `RELEASE_SMOKE_VERSION` is the version it must report. No retries: a smoke
 * that needs a second try is a release that should not ship.
 */
const url = process.env.RELEASE_SMOKE_URL;
if (!url || !process.env.RELEASE_SMOKE_VERSION) {
  throw new Error('RELEASE_SMOKE_URL and RELEASE_SMOKE_VERSION are both required.');
}

export default defineConfig({
  testDir: './release-smoke',
  reporter: [['list']],
  workers: 1,
  retries: 0,
  timeout: 120_000,
  forbidOnly: true,
  use: { baseURL: url, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
