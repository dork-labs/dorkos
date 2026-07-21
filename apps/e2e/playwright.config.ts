import { defineConfig, devices } from '@playwright/test';

/* eslint-disable no-restricted-syntax -- Playwright config has no env.ts; direct process.env access is expected */
const CI = !!process.env.CI;
const PORT = process.env.DORKOS_PORT || '4242';
const VITE_PORT = process.env.VITE_PORT || '4241';

// Test-mode server port (TestModeRuntime). Separate port avoids conflicting
// with the real server when both are running locally.
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
// Vite client for mock tests — proxies /api to MOCK_PORT instead of PORT.
// NOTE: port 6244 is taken by @dorkos/site (Next.js marketing site).
const MOCK_VITE_PORT = process.env.DORKOS_MOCK_VITE_PORT || '4248';
// Marketing site (Next.js) — hosts the public /marketplace pages exercised by
// `tests/marketplace.spec.ts`. Port matches `apps/site/package.json` `dev` script.
const SITE_PORT = process.env.DORKOS_SITE_PORT || '6244';

// The marketing-site leg is heavy (Next.js + Turbopack + a fumadocs file
// watcher) and only the site specs (see SITE_SPECS) need it. Booting it for
// cockpit-only runs wastes minutes and, under file-descriptor pressure (many
// recursive watchers → EMFILE), stalls its 180s readiness gate so no spec can
// run — exactly what blocked isolated runs in DOR-407. So the site leg (and its
// specs) are opt-in: set `E2E_SITE=1` to include them. No workflow runs this
// browser suite in CI today; the CI default-on below is a forward-looking
// mechanism so that if/when the suite is CI-wired, the site legs stay on unless
// `E2E_SITE=0` forces them off.
const INCLUDE_SITE = process.env.E2E_SITE === '1' || (CI && process.env.E2E_SITE !== '0');

// Specs that override baseURL to the marketing site (http://localhost:6244) —
// they need the site leg, so they are excluded from the cockpit project unless
// the leg is booted. Keep in sync by grepping tests/ for `6244`/`SITE_BASE_URL`.
const SITE_SPECS = ['**/marketplace.spec.ts', '**/features.spec.ts'];
/* eslint-enable no-restricted-syntax */

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 1 : undefined,
  timeout: 30_000,

  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
    CI ? ['github'] : ['list'],
    ['./reporters/manifest-reporter.ts'],
  ],

  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  webServer: [
    {
      command: 'dotenv -- turbo dev --filter=@dorkos/server',
      url: `http://localhost:${PORT}/api/health`,
      name: 'Express API',
      timeout: 120_000,
      reuseExistingServer: !CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'dotenv -- turbo dev --filter=@dorkos/client',
      url: `http://localhost:${VITE_PORT}`,
      name: 'Vite Client',
      timeout: 120_000,
      reuseExistingServer: !CI,
      stdout: 'pipe',
    },
    // Test-mode server: uses TestModeRuntime (no real Claude API calls).
    // Only started when the mock-browser project runs — separated by port so it
    // does not interfere with the real server used by integration tests.
    // DORKOS_TEST_RUNTIME_SECONDARY registers a SECOND TestModeRuntime under
    // the 'test-mode-b' type so chat-mock.spec.ts can exercise multi-runtime
    // UI (picker, ?runtime= binding, session-list marks) with no real binaries.
    //
    // Deliberately NOT `turbo dev` (tsx watch): the server rewrites its
    // runtime-compiled core-extension artifact (DORK_HOME/cache/extensions/
    // server/_run/*.js) on every boot and `require()`s it, so tsx watch sees a
    // tracked file change and restarts — an infinite boot loop that left the
    // mock port refusing connections mid-run. Tests never edit source, so the
    // server runs unwatched; the explicit `turbo run build` supplies the
    // workspace-dependency dists that `turbo dev` provided via ^build.
    {
      command: `DORKOS_TEST_RUNTIME=true DORKOS_TEST_RUNTIME_SECONDARY=true DORKOS_PORT=${MOCK_PORT} VITE_PORT=${MOCK_VITE_PORT} DORK_HOME=/tmp/dorkos-test-mode DORKOS_RELAY_ENABLED=true dotenv -- sh -c 'turbo run build --filter=@dorkos/server && pnpm --filter @dorkos/server exec tsx src/index.ts'`,
      url: `http://localhost:${MOCK_PORT}/api/health`,
      name: 'Express API (test-mode)',
      timeout: 240_000,
      reuseExistingServer: !CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    // Vite client for mock tests — proxies /api to the test-mode server on MOCK_PORT.
    // Without this, the main Vite client (port 4241) would proxy to the real server,
    // and mock scenarios set on MOCK_PORT would never be used by the UI.
    {
      command: `DORKOS_PORT=${MOCK_PORT} VITE_PORT=${MOCK_VITE_PORT} dotenv -- turbo dev --filter=@dorkos/client`,
      url: `http://localhost:${MOCK_VITE_PORT}`,
      name: 'Vite Client (test-mode)',
      timeout: 120_000,
      reuseExistingServer: !CI,
      stdout: 'pipe',
    },
    // Marketing site (Next.js) — hosts the public /marketplace and /features
    // pages exercised by the SITE_SPECS (marketplace.spec.ts, features.spec.ts).
    // The marketplace test mocks the upstream GitHub registry fetch so the dev
    // server does not need network access.
    // Opt-in via E2E_SITE (see INCLUDE_SITE) — omitted for cockpit-only runs.
    //
    // Wrapped in `dotenv --` to mirror the other legs: when Playwright is run
    // directly (e.g. `pnpm --filter @dorkos/e2e e2e`, no root `dotenv` wrapper),
    // this loads the root `.env` the site would otherwise start without.
    // SITE_PORT is passed through so the leg honors DORKOS_SITE_PORT overrides
    // (the site `dev` script binds `${SITE_PORT:-6244}`); dotenv does not clobber
    // an already-set env var, so the override wins.
    ...(INCLUDE_SITE
      ? [
          {
            command: `SITE_PORT=${SITE_PORT} dotenv -- pnpm --filter @dorkos/site dev`,
            url: `http://localhost:${SITE_PORT}`,
            name: 'Marketing Site',
            timeout: 180_000,
            reuseExistingServer: !CI,
            stdout: 'pipe' as const,
            stderr: 'pipe' as const,
          },
        ]
      : []),
  ],

  projects: [
    {
      // Standard integration project — runs all tests except mock-browser specs.
      // The site specs (SITE_SPECS) need the marketing-site leg, so they are
      // ignored unless that leg is booted (E2E_SITE / INCLUDE_SITE) — otherwise
      // they would hang on an unreachable http://localhost:6244.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/chat-mock.spec.ts', ...(INCLUDE_SITE ? [] : SITE_SPECS)],
    },
    {
      // Mock-browser project — runs chat-mock.spec.ts against the test-mode server.
      // No real Claude API calls; responses are controlled via /api/test/scenario.
      //
      // Deliberately a SINGLE spec file: the mock server is global mutable
      // state (POST /api/test/reset wipes scenarios, sessions, and projectors
      // for everyone), and fullyParallel schedules separate files onto
      // concurrent workers — a second mock spec file would race the first's
      // beforeEach resets. Add new mock-server suites to chat-mock.spec.ts.
      name: 'chromium-mock',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${MOCK_VITE_PORT}`,
      },
      testMatch: ['**/chat-mock.spec.ts'],
    },
  ],
});
