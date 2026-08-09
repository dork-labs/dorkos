import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * The checkout root, which the cockpit leg runs boundary-scoped to.
 *
 * The server refuses any agent path outside `DORKOS_BOUNDARY`, and that
 * defaults to the **home directory** — so the fixtures' own scratch dir under
 * `apps/e2e/.temp` is only in bounds while the checkout happens to live under
 * `$HOME`. Run the suite from `/private/tmp`, or from a worktree parked
 * anywhere else, and every seeded agent answers `Path outside boundary` and
 * fourteen specs fail for a reason no diff explains.
 *
 * Naming the boundary here makes that true by construction instead of by
 * coincidence. The checkout is the right root because the server's own default
 * working directory is already the repo root (`resolve-root.ts`), so nothing
 * the suite legitimately reaches falls outside it.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..');

/* eslint-disable no-restricted-syntax -- Playwright config has no env.ts; direct process.env access is expected */

/**
 * Read a port override, refusing anything that is not digits.
 *
 * Every port here ends up interpolated into a shell command, and one of them
 * (`DORKOS_MOCK_PORT`) names a directory that gets `rm -rf`'d on boot. The fixed
 * `/tmp/dorkos-test-mode-` prefix means no port-shaped value can reach anything
 * that matters, but a value containing a space or a quote would end the argument
 * and start a new one — so the shape is checked rather than assumed. These are
 * operator-supplied, so this is a footgun to close, not an attack to repel; it
 * costs a regex.
 *
 * @param name - The environment variable to read.
 * @param fallback - The default port when it is unset.
 */
function port(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be digits only, got: ${JSON.stringify(value)}`);
  }
  return value;
}

const CI = !!process.env.CI;
const PORT = port('DORKOS_PORT', '4242');
const VITE_PORT = port('VITE_PORT', '4241');

// Test-mode server port (TestModeRuntime). Separate port avoids conflicting
// with the real server when both are running locally.
const MOCK_PORT = port('DORKOS_MOCK_PORT', '4243');
// Vite client for mock tests — proxies /api to MOCK_PORT instead of PORT.
// NOTE: port 6244 is taken by @dorkos/site (Next.js marketing site).
const MOCK_VITE_PORT = port('DORKOS_MOCK_VITE_PORT', '4248');
// Throwaway data directory for the test-mode server, keyed by its port so two
// runs on different ports do not share (or wipe) one another's. Deleted before
// every boot — see the leg below.
const MOCK_DORK_HOME = `/tmp/dorkos-test-mode-${MOCK_PORT}`;
// Marketing site (Next.js) — hosts the public /marketplace pages exercised by
// `tests/marketplace.spec.ts`. Port matches `apps/site/package.json` `dev` script.
const SITE_PORT = port('DORKOS_SITE_PORT', '6244');

// The marketing-site leg is heavy (Next.js + Turbopack + a fumadocs file
// watcher) and only the site specs (see SITE_SPECS) need it. Booting it for
// cockpit-only runs wastes minutes and, under file-descriptor pressure (many
// recursive watchers → EMFILE), stalls its 180s readiness gate so no spec can
// run — exactly what blocked isolated runs in DOR-407. So the site leg (and its
// specs) are opt-in: set `E2E_SITE=1` to include them. Under CI the leg
// defaults ON (unless `E2E_SITE=0` forces it off), and the CI gate
// (.github/workflows/browser-test.yml) also sets E2E_SITE=1 explicitly so its
// coverage does not ride this conditional.
const INCLUDE_SITE = process.env.E2E_SITE === '1' || (CI && process.env.E2E_SITE !== '0');

// `@integration`-tagged specs drive a REAL agent runtime — they start a turn and
// wait for a model to answer. That needs model credentials, which a PR runner
// does not have and should not be given, and it spends real money per run. So
// they are off by default, everywhere, and opting in is a deliberate act:
//
//   E2E_INTEGRATION=1 pnpm --filter @dorkos/e2e e2e --project chromium
//
// Off by default rather than off-only-in-CI on purpose. A gate that silently
// skips is one thing; a local run that silently bills you is another, and the
// failure mode of forgetting is worse in the second case. This is an explicit,
// named exclusion so nobody has to infer it from a suite that is red for a
// reason no diff explains.
const INCLUDE_INTEGRATION = process.env.E2E_INTEGRATION === '1';

// Never adopt a server this run did not start.
//
// This was `!CI`, so any local run whose ports were already answering attached
// to whatever was there — and the default cockpit port is 4242, which is where
// `pnpm dev:dogfood` puts the operator's own DorkOS. A default-port run then
// drove the suite against the real `~/.dork`: real agents, real rooms, real
// config, mutated by tests that archive and delete things.
//
// It also silently voided this file's guarantees. An adopted server was started
// by somebody else, so it has none of the env below — not the boundary that
// keeps fixtures in bounds, not the Tasks and Relay flags the dialog specs
// need. The suite would have been testing a differently-configured server than
// the one it describes.
//
// With reuse off, a busy port is a startup error naming the port instead of a
// silent adoption. Override the ports (see README's isolated-run recipe) to run
// alongside a live cockpit.
const REUSE_EXISTING_SERVER = false;

// Specs that override baseURL to the marketing site (http://localhost:6244) —
// they need the site leg, so they are excluded from the cockpit project unless
// the leg is booted. Keep in sync by grepping tests/ for `6244`/`SITE_BASE_URL`.
const SITE_SPECS = ['**/marketplace.spec.ts', '**/features.spec.ts'];
/* eslint-enable no-restricted-syntax */

/**
 * The command that boots an Express API leg, for every leg that needs one.
 *
 * Deliberately NOT `turbo dev` (`tsx watch`). On boot the server compiles each
 * core extension into `DORK_HOME/cache/extensions/server/_run/<id>.js` and
 * `require()`s it (`extension-server-lifecycle.ts`). `tsx watch` watches
 * everything the process requires, so it sees that write as a source change and
 * restarts — which rewrites the file, which restarts again. A measured ~23
 * restarts in 45s, until the run dies.
 *
 * The default `DORK_HOME` (`apps/server/.temp/.dork`) hides the loop by
 * accident: `tsx` ignores dot-directories under its own cwd. Point `DORK_HOME`
 * anywhere else — a throwaway dir, `/tmp`, another worktree — and the loop is
 * back. So no e2e leg may watch. Tests never edit source, so nothing is lost.
 *
 * `turbo run build` supplies the workspace-dependency dists that `turbo dev`
 * used to provide via `^build`. Both legs run it concurrently and turbo
 * deduplicates them, so the second is free.
 *
 * @param env - Leg-specific environment, prefixed onto the command.
 * @param preBoot - Shell run before the build, for a leg that must start from a
 *   known-empty state.
 */
function apiLegCommand(env: Record<string, string> = {}, preBoot?: string): string {
  const prefix = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  const boot = `turbo run build --filter=@dorkos/server && pnpm --filter @dorkos/server exec tsx src/index.ts`;
  const script = preBoot ? `${preBoot} && ${boot}` : boot;
  return `${prefix ? `${prefix} ` : ''}dotenv -- sh -c '${script}'`;
}

export default defineConfig({
  testDir: './tests',
  // Puts the first-run wizard away on every API leg before any spec runs —
  // without it, a never-onboarded DORK_HOME renders the wizard instead of the
  // app shell and every spec times out. See `global-setup.ts`.
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: CI,
  // One retry in CI, zero locally — a decision, not a default. The full
  // argument lives in .github/workflows/browser-test.yml; the short form: one
  // retry absorbs the suite's single tracked test-side flake (DOR-698) without
  // being wide enough to hide a product race behind two coincidences, and
  // every pass-on-retry is named in the CI log by the assert step's flaky
  // warning, so nothing is absorbed silently.
  retries: CI ? 1 : 0,
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
      // Tasks and Relay are opt-in server features, both defaulting to off. The
      // specs that exercise their dialogs assert on the real panels, not on the
      // "start DorkOS with --tasks" placeholder, so the suite turns them on
      // itself. Inheriting them from the developer's `.env` — which is
      // untracked — made whether those specs could pass a property of the
      // machine rather than of the code.
      command: apiLegCommand({
        DORKOS_TASKS_ENABLED: 'true',
        DORKOS_RELAY_ENABLED: 'true',
        // Keeps the fixtures' scratch dir in bounds wherever the checkout is —
        // see REPO_ROOT.
        DORKOS_BOUNDARY: REPO_ROOT,
      }),
      url: `http://localhost:${PORT}/api/health`,
      name: 'Express API',
      timeout: 240_000,
      reuseExistingServer: REUSE_EXISTING_SERVER,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'dotenv -- turbo dev --filter=@dorkos/client',
      url: `http://localhost:${VITE_PORT}`,
      name: 'Vite Client',
      timeout: 120_000,
      reuseExistingServer: REUSE_EXISTING_SERVER,
      stdout: 'pipe',
    },
    // Test-mode server: uses TestModeRuntime (no real Claude API calls).
    // Only started when the mock-browser project runs — separated by port so it
    // does not interfere with the real server used by integration tests.
    // DORKOS_TEST_RUNTIME_SECONDARY registers a SECOND TestModeRuntime under
    // the 'test-mode-b' type so chat-mock.spec.ts can exercise multi-runtime
    // UI (picker, ?runtime= binding, session-list marks) with no real binaries.
    // Boots unwatched via `apiLegCommand` — see the note there.
    //
    // Its DORK_HOME is deleted before every boot, and keyed by port so two runs
    // on different ports never share one. `POST /api/test/reset` clears the
    // runtime's in-memory state but not the database underneath it, so sessions
    // and agents accumulated across runs — and the specs that count rows
    // ("expected 1, received 2") were the ones that eventually noticed. That was
    // masked for a long time by `reuseExistingServer`, which usually handed the
    // run a server someone had already started.
    {
      command: apiLegCommand(
        {
          DORKOS_TEST_RUNTIME: 'true',
          DORKOS_TEST_RUNTIME_SECONDARY: 'true',
          // Registers a claude-code-typed TestModeRuntime alias so the managed-MCP
          // OAuth spec's seeded agent (manifest `runtime: 'claude-code'`) resolves
          // a real `getMcpStatus` via GET /api/mcp-config (DOR-952). Invisible to
          // the other test-mode specs — it adds an unused registered runtime and
          // no spec asserts the registered set is exactly {test-mode, test-mode-b}.
          DORKOS_TEST_RUNTIME_CLAUDE_ALIAS: 'true',
          DORKOS_PORT: MOCK_PORT,
          VITE_PORT: MOCK_VITE_PORT,
          DORK_HOME: MOCK_DORK_HOME,
          DORKOS_RELAY_ENABLED: 'true',
        },
        `rm -rf ${MOCK_DORK_HOME}`
      ),
      url: `http://localhost:${MOCK_PORT}/api/health`,
      name: 'Express API (test-mode)',
      timeout: 240_000,
      reuseExistingServer: REUSE_EXISTING_SERVER,
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
      reuseExistingServer: REUSE_EXISTING_SERVER,
      stdout: 'pipe',
    },
    // Marketing site (Next.js) — hosts the public /marketplace and /features
    // pages exercised by the SITE_SPECS (marketplace.spec.ts, features.spec.ts).
    // The /marketplace pages fetch the LIVE dork-labs/marketplace registry
    // SERVER-side (a page.route mock can never intercept that), so this leg
    // needs network access to raw.githubusercontent.com and the marketplace
    // specs depend on that registry being reachable and non-empty. The trade
    // is stated in .github/workflows/browser-test.yml's header.
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
            reuseExistingServer: REUSE_EXISTING_SERVER,
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
      // tests/connections/ needs the test-mode server (the scripted
      // `test-connector` provider exists only under DORKOS_TEST_RUNTIME), so it
      // runs in chromium-connections below, never against the real cockpit leg.
      testIgnore: [
        '**/chat-mock.spec.ts',
        '**/connections/**',
        // Runs against the test-mode leg in `chromium-streams` below.
        '**/streams/**',
        // Needs the test-mode server's `/api/test/seed-bridge` seam, so it runs
        // in `chromium-bridge` below, never against the real cockpit leg.
        '**/relay/bridged-channel.spec.ts',
        ...(INCLUDE_SITE ? [] : SITE_SPECS),
      ],
      // Skips the specs that need real model credentials — see INCLUDE_INTEGRATION.
      ...(INCLUDE_INTEGRATION ? {} : { grepInvert: /@integration/ }),
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
    {
      // Connector-gateway specs — also against the test-mode server, whose
      // DORKOS_TEST_RUNTIME gate is what makes the scripted `test-connector`
      // provider exist. A separate project rather than more chat-mock suites
      // because these specs share none of chat-mock's scenario/reset choreography.
      //
      // connections.spec.ts is a SINGLE serial file for the same reason
      // chat-mock is: the provider credential and its accounts are server-global
      // state. marketplace-connectors.spec.ts may run beside it freely — it
      // touches only the marketplace source list. chat-mock's global
      // `POST /api/test/reset` clears runtime sessions and scenarios, neither of
      // which these specs' assertions depend on (the session-attach spec uses
      // its session only as an id; the attach surface is connector-service
      // state, not runtime state). Verified empirically 2026-07-29: both
      // projects run concurrently against one test-mode server, 18/18 passed.
      name: 'chromium-connections',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${MOCK_VITE_PORT}`,
      },
      testMatch: ['**/connections/**/*.spec.ts'],
    },
    {
      // Multi-window connection-budget guard (DOR-927) — the suite had no
      // multi-window test at all, which is how a bug that made three windows
      // freeze the whole app reached users.
      //
      // Against the test-mode leg so it spends nothing on a model: it opens
      // windows and times a plain request, and never drives a turn. A separate
      // project rather than a chat-mock suite because it shares none of
      // chat-mock's scenario/reset choreography — it asserts only on its own
      // pages' sockets, so it runs beside the other test-mode projects.
      name: 'chromium-streams',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${MOCK_VITE_PORT}`,
      },
      testMatch: ['**/streams/*.spec.ts'],
    },
    {
      // Chats-as-channels cockpit proof — also against the test-mode server,
      // whose `DORKOS_TEST_RUNTIME` gate is what mounts `/api/test/seed-bridge`.
      // A separate project rather than a chat-mock suite because it shares none
      // of chat-mock's scenario/reset choreography: it seeds its own bridged
      // room and asserts only on that room, so it runs beside the other
      // test-mode projects without racing them.
      name: 'chromium-bridge',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${MOCK_VITE_PORT}`,
      },
      testMatch: ['**/relay/bridged-channel.spec.ts'],
    },
  ],
});
