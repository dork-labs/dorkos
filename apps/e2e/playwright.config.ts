import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { BOOT_CACHE_DISABLED_KEY } from './boot-cache-flag';

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
 * Every port here ends up interpolated into a shell command, and two of them
 * (`DORKOS_COCKPIT_PORT`, `DORKOS_MOCK_PORT`) name a directory that gets
 * `rm -rf`'d on boot. The fixed `/tmp/dorkos-cockpit-` and
 * `/tmp/dorkos-test-mode-` prefixes mean no port-shaped value can reach anything
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

/**
 * How many ways CI is cutting this suite, so `globalTimeout` can be sized to one
 * shard rather than to the whole run.
 *
 * `.github/workflows/browser-test.yml` runs `playwright test --shard=i/N` across
 * a matrix and sets this to the same N. Playwright gives each shard process its
 * own `globalTimeout`, so a deadline written for the unsharded suite would be
 * three times too generous — and a hung shard would sit there for half an hour
 * past the point anyone could learn anything from it.
 *
 * Reading it rather than hard-coding a per-shard number is what keeps the
 * deadline honest when the matrix changes size: the workflow's `shard:` list is
 * the single place the count is written, and both the `--shard` flag and this
 * variable come from it.
 *
 * Defaults to 1, which is the truth everywhere else — a local run, or any CI
 * invocation that does not shard, really is running the whole suite. The cost of
 * that default being wrong is a loose deadline, never a tight one: a CI run that
 * DOES shard while forgetting this variable gets the unsharded 75-minute budget,
 * so a hung shard sits past its job ceiling and is cancelled without a report
 * instead of failing with one. That is the DOR-1110 failure mode, which is why
 * the workflow sets it from the same `shard:` list the `--shard` flag comes from
 * rather than leaving the two to be kept in step by hand.
 */
function shardTotal(): number {
  const value = process.env.E2E_SHARD_TOTAL;
  if (value === undefined || value === '') return 1;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`E2E_SHARD_TOTAL must be a positive integer, got: ${JSON.stringify(value)}`);
  }
  return Number(value);
}

const SHARD_TOTAL = shardTotal();

// The two measured numbers `globalTimeout` is derived from, and its multiplier.
// The full argument — what was measured, on which runs, and why the deadline is
// computed instead of typed in — is on `globalTimeout` below.
const UNSHARDED_SUITE_MINUTES = 41;
const LEG_BOOT_MINUTES = 3;
const GLOBAL_TIMEOUT_HEADROOM = 1.75;

/** A healthy shard's derived wall time: fixed boot cost plus its share of the tests. */
const HEALTHY_SHARD_MINUTES =
  LEG_BOOT_MINUTES + (UNSHARDED_SUITE_MINUTES - LEG_BOOT_MINUTES) / SHARD_TOTAL;

/** That, with headroom, rounded up to the next five minutes so the ladder reads in round numbers. */
const SHARD_GLOBAL_TIMEOUT_MS =
  Math.ceil((HEALTHY_SHARD_MINUTES * GLOBAL_TIMEOUT_HEADROOM) / 5) * 5 * 60_000;

// THE COCKPIT LEG'S OWN PORTS AND DATA DIRECTORY — never the operator's (DOR-1223).
//
// This leg used to boot with no `DORK_HOME` at all, so the server resolved its
// dev default, `apps/server/.temp/.dork`. That is the SAME directory
// `pnpm dev` and `pnpm dev:dogfood` read: every default `pnpm test:browser`
// wrote onboarding timestamps, sidebar groups, rooms (the rooms fixture ARCHIVES
// on cleanup, it never deletes) and agent registrations straight into the
// operator's live dev data. The mock leg had had a throwaway, port-keyed,
// wiped-per-boot home for a long time; this one simply never got one.
//
// So it gets the same treatment, and isolation stops being a recipe in README.md
// that a run has to remember: a home under /tmp, keyed by port so two runs never
// share (or wipe) one another's, deleted before every boot.
//
// AND ITS OWN ENV NAMES, which is the other half. Reading `DORKOS_PORT` looked
// harmless and was not: the root `.env` sets `DORKOS_PORT=6242` for dev, turbo
// passes it through, and `pnpm test:browser` wraps the run in `dotenv` — so from
// the repo root this leg aimed itself at the DEV server's port. A suite that
// borrows the variable naming the machine's other DorkOS cannot be isolated from
// it by construction. `DORKOS_COCKPIT_PORT` / `DORKOS_COCKPIT_VITE_PORT` are read
// by nothing else, so an ambient dev environment cannot move this leg; the leg
// then passes `DORKOS_PORT` DOWN to the server it starts, which is where that
// name belongs.
const PORT = port('DORKOS_COCKPIT_PORT', '4245');
const VITE_PORT = port('DORKOS_COCKPIT_VITE_PORT', '4244');
// Throwaway data directory for the cockpit server, keyed by its port. Deleted
// before every boot — see the leg below.
const COCKPIT_DORK_HOME = `/tmp/dorkos-cockpit-${PORT}`;

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
// to whatever was there — and the cockpit leg used to default to 4242, which is
// where `pnpm dev:dogfood` puts the operator's own DorkOS. A default-port run
// then drove the suite against the real `~/.dork`: real agents, real rooms, real
// config, mutated by tests that archive and delete things. (The leg's ports have
// since moved off both of the operator's stacks — see COCKPIT_DORK_HOME above —
// so this is now the second lock rather than the only one.)
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
 * Recreate a leg's throwaway `DORK_HOME` empty and readable only by the person
 * running the suite.
 *
 * **The wipe** is why the directory is safe to reuse: a server that keeps
 * yesterday's rows hands the specs that count them "expected 1, received 2" a
 * run later, and a home that survives at all is a home some future default could
 * point back at the operator's.
 *
 * **The mode is the other half, and it is `0700` rather than whatever `umask`
 * says** (DOR-1551). `/tmp` is world-readable and world-traversable, and this
 * directory holds a SQLite index of everything the suite indexed plus the
 * instance's own `mcp-local-token` and `better-auth-secret`. At the default
 * `umask 022` it was created `0755`, so every account on the machine could read
 * all of it. Creating it here rather than leaving it to the server means the
 * mode is set before the first byte is written, and `-m` states it outright
 * instead of inheriting whatever `umask` the run happened to start with.
 *
 * @param dorkHome - The leg's data directory. Always one of the fixed
 *   `/tmp/dorkos-*-<port>` paths above, whose port component is digit-checked
 *   by {@link port}.
 */
function resetThrowawayHome(dorkHome: string): string {
  return `rm -rf ${dorkHome} && mkdir -m 700 -p ${dorkHome}`;
}

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

  // STOP AFTER FIVE FAILURES IN CI — fail fast, report loudly (DOR-1110).
  //
  // The incident this is sized against: one product change broke 21 @smoke
  // specs at once, every one of them dying on a 30s locator timeout. Serially,
  // with one retry, that is 21 × (30s + 30s) ≈ 21 minutes of a runner waiting
  // to be told the same thing 21 times — on top of a healthy suite that already
  // took over half an hour (measured, see the workflow header). The attempt hit
  // the job ceiling and was CANCELLED with zero Playwright output, so the run
  // cost a full debug cycle and reported nothing. `globalTimeout` below fixes
  // the "reported nothing" half; this fixes the "waited 21 minutes" half.
  //
  // WHY FIVE, and not one and not twenty.
  //
  //   * A break of this shape is one root cause, so the fifth named spec tells
  //     you nothing the third did not. Five red spec names is a diagnosis;
  //     twenty-one is the same diagnosis, sixteen minutes later.
  //   * It must not be so tight that ONE test kills the job, because retries
  //     exist and this suite has a tracked flake budget of exactly one (DOR-698
  //     — see `retries` above and the workflow header). A flake that passes on
  //     its retry is `flaky`, never `unexpected`, so it does not count here at
  //     all; only a test that fails BOTH attempts does. At 5 the suite still
  //     surfaces four other genuine failures past a hard flake, and at 1 or 2 a
  //     single hard flake would abort the run and hide everything behind it.
  //   * Cost when it trips: at worst 5 × (30s + 30s retry) ≈ 5 minutes of
  //     failure burn, and much less in practice because an assertion failure is
  //     immediate and only a locator timeout pays the full 30s.
  //
  // INERT ON A HEALTHY RUN, by construction rather than by measurement: the
  // counter only advances on an `unexpected` result, so a run with zero
  // failures cannot reach any threshold. A green run is bit-for-bit the run it
  // was before this line, which is why it can be raised in CI without a
  // corresponding local change.
  //
  // PER SHARD, now that CI cuts the suite three ways (DOR-1363) — so a
  // catastrophic break can burn 3 × 5 failures instead of 5. That is the right
  // trade rather than a regression: the three shards spend it CONCURRENTLY, so
  // the wall-clock cost is the same ~5 minutes it always was, and each shard
  // names five of its own specs instead of the run naming five out of one
  // arbitrary third. Fifteen red spec names across three logs is still one
  // diagnosis; what it buys is that a break confined to one shard's projects
  // cannot hide behind five failures in another's.
  //
  // Local runs keep 0 (unlimited). A developer running one spec file wants the
  // whole picture, has no job meter running, and is watching the output live —
  // the failure mode this guards against does not exist there.
  maxFailures: CI ? 5 : 0,

  // PLAYWRIGHT MUST DIE BEFORE THE JOB DOES — never cancel silently (DOR-1110).
  //
  // A GitHub job that hits its own `timeout-minutes` is CANCELLED, not failed:
  // the step is killed mid-write, `if: failure()` steps do not run, and no
  // report, trace, screenshot or video survives. That is what turned the
  // incident above into an "infra hang" that nobody could read. A run that
  // proves nothing is worse than a red one, because a red one at least names a
  // spec.
  //
  // So Playwright gets its own deadline, deliberately BELOW the job's — what
  // happens when it fires is spelled out with the ladder further down.
  //
  // DERIVED, NOT TYPED IN (DOR-1363). This used to be a flat 45 minutes, chosen
  // as ~48% headroom over a 30m24s green run measured on 2026-08-12. By
  // 2026-08-19 a green run took 40m33s to 43m11s across four consecutive main
  // runs — so the headroom had quietly fallen to under two minutes, and the rung
  // that exists to fire FIRST was one slow runner away from firing on a
  // perfectly healthy suite. A number that has to be re-measured by hand every
  // time the suite grows is a number that goes stale; this one is computed from
  // the two facts it actually depends on.
  //
  // The two facts, both measured on 2026-08-19:
  //
  //   * a full unsharded suite takes ~41 minutes in the `playwright test` step
  //     (40m33s / 41m45s / 42m43s / 43m11s on runs 32281755292, 32272418644,
  //     32251346554, 32259784745)
  //   * ~2m24s of that is the five webServer legs booting SEQUENTIALLY plus
  //     `global-setup.ts` — fixed cost every shard re-pays, and the only part
  //     that does NOT divide. (Run 32239903731: its suite step began 10:39:15
  //     and its globalSetup blew a 180s `waitForSelector` at 10:44:39, so the
  //     legs were up by 10:41:39. Rounded up to 3 in LEG_BOOT_MINUTES above.)
  //
  // So a healthy shard is `boot + (suite − boot) / shards` — about 15m40s at
  // three shards — and the deadline is 1.75× that, rounded up to the next five
  // minutes: 30 minutes. The 1.75 is deliberately looser than the 1.5 the flat
  // number was originally set at, because `--shard` divides by TEST COUNT and
  // not by duration: the split is 110/109/109 of 328, but shards 1 and 2 are
  // pure `chromium` while shard 3 carries all six test-mode projects, and no
  // measurement yet says those thirds take equally long.
  //
  // The ladder this sits in is on the job in .github/workflows/browser-test.yml:
  // shard ~16m (healthy) → Playwright gives up at 30m → the step is killed at
  // 35m → the job at 45m. Each rung above the one below it, and the FIRST rung
  // to fire is the one that leaves output behind — when this one fires,
  // Playwright stops the run itself, gracefully, through its own shutdown path,
  // so every reporter still flushes: the HTML report, the JSON the gate job
  // reads, and the `github` annotations. The job then fails on a non-zero exit
  // WITH output, instead of vanishing.
  //
  // If this ever fires on a genuinely healthy suite, the fix is another shard,
  // not a bigger multiplier.
  //
  // Unset locally: a developer's machine has no job ceiling to lose a report
  // to, and a debugging session paused on a breakpoint must not be shot.
  globalTimeout: CI ? SHARD_GLOBAL_TIMEOUT_MS : undefined,

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
    // **Every spec gets a COLD cockpit.** The app remembers its sidebar between
    // loads (`shared/lib/query-persister.ts`), which is right for a person and
    // wrong for a suite written against a cold first paint. A fresh context per
    // test is not enough on its own: WITHIN one test every navigation shares the
    // context, so the second `page.goto` restores what the first left, and specs
    // that assert on paint order, scroll anchoring or a live lane's first frame
    // start racing a warm boot they were never written for. CI's slower machines
    // widen every one of those races.
    //
    // Set HERE rather than in a fixture because half this suite does not use the
    // shared `test` — 48 files import `test` straight from `@playwright/test`,
    // and a fixture-level opt-out silently misses every one of them (measured:
    // `now-survives-reload.ts` was the one that noticed, by reloading into a
    // snapshot taken before the session it was asserting on errored). A config
    // `storageState` applies to every context in every project however `test`
    // was imported, which is the property this needs.
    //
    // One entry per leg, because `localStorage` is per-origin.
    // `dashboard-sidebar/boot-stability.spec.ts` removes the key to opt back in —
    // warm boot is the thing it tests.
    storageState: {
      cookies: [],
      origins: [VITE_PORT, MOCK_VITE_PORT].map((vitePort) => ({
        origin: `http://localhost:${vitePort}`,
        localStorage: [{ name: BOOT_CACHE_DISABLED_KEY, value: '1' }],
      })),
    },
  },

  webServer: [
    {
      // Tasks and Relay are opt-in server features, both defaulting to off. The
      // specs that exercise their dialogs assert on the real panels, not on the
      // "start DorkOS with --tasks" placeholder, so the suite turns them on
      // itself. Inheriting them from the developer's `.env` — which is
      // untracked — made whether those specs could pass a property of the
      // machine rather than of the code.
      command: apiLegCommand(
        {
          DORKOS_TASKS_ENABLED: 'true',
          DORKOS_RELAY_ENABLED: 'true',
          // Keeps the fixtures' scratch dir in bounds wherever the checkout is —
          // see REPO_ROOT.
          DORKOS_BOUNDARY: REPO_ROOT,
          // Named explicitly rather than left to the `dotenv` inside the command:
          // dotenv does not clobber an already-set variable, so setting them here
          // is what stops the root `.env`'s dev values (DORKOS_PORT=6242) from
          // deciding where this leg listens and where it keeps its data.
          DORKOS_PORT: PORT,
          DORK_HOME: COCKPIT_DORK_HOME,
          // Index this leg's own throwaway data directory and NOTHING ELSE
          // (DOR-1551). `DORK_HOME` isolates what DorkOS owns; it does not move
          // `~/.claude`, `$CODEX_HOME` or OpenCode's store, so without this the
          // message-search sweep full-text-copied the operator's real
          // transcripts — ~9,250 Claude Code messages, measured 2026-08-25 —
          // into the directory below on EVERY run of this suite. Nothing about
          // the product under test needs somebody's history in the index; the
          // rooms the specs seed are indexed exactly as before.
          DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
          // The SERVER reads VITE_PORT too, and not for listening: in dev its
          // trusted-origin list is localhost/127.0.0.1 on the API port AND on
          // the Vite port (`getStaticLocalOrigins`), and the same value picks
          // the origin OAuth callbacks land on. Leave it out and the server
          // trusts 4241 while the browser is on this leg's client — measured as
          // 12 `Origin http://localhost:4244 not allowed by CORS` refusals in a
          // run that still went green, because the smoke spec never needed one
          // of the refused calls. The mock leg passes it for the same reason.
          VITE_PORT,
        },
        // Wiped and recreated `0700` before every boot — see resetThrowawayHome.
        resetThrowawayHome(COCKPIT_DORK_HOME)
      ),
      url: `http://localhost:${PORT}/api/health`,
      name: 'Express API',
      // Every leg below carries a DISTINCT timeout, on purpose (DOR-1243).
      // Playwright's own readiness-timeout error names only the millisecond
      // number — `Timed out waiting 180000ms from config.webServer.` — never
      // the leg (verified against installed playwright@1.59.1:
      // webServerPlugin.js's `_waitForProcess` throws that string with no
      // access to `this._options.name`, which is used only to prefix piped
      // stdout/stderr lines). So the leg's `name` field, though set on every
      // entry below for that log-prefixing, cannot disambiguate a bare
      // timeout number by itself. Giving each leg its own value is what lets
      // a future "Timed out waiting N" be grepped straight back to the one
      // config line that set N.
      timeout: 240_000,
      reuseExistingServer: REUSE_EXISTING_SERVER,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Both ports named for the same reason the API leg names its own: without
      // them the root `.env` decides which port this client binds and which
      // server it proxies `/api` to, which on a developer machine is the dev
      // stack rather than the leg above.
      //
      // **NOTHING IN THIS SUITE SEES THE PRODUCTION CONTENT-SECURITY-POLICY.**
      // The browser loads the app from Vite, which serves its own shell with no
      // CSP header; the Express leg's policy (`SHELL_CSP` in
      // `apps/server/src/app.ts`) only goes out with the BUILT shell it serves
      // under `NODE_ENV=production`, which no leg here runs. So a directive
      // that breaks a real browser surface stays green through this whole
      // suite — `workbench/dev-server-preview.spec.ts` would have passed
      // forever while the shipped app reported every dev server unreachable
      // (DOR-560, caught in review by driving a production-mode server in
      // Chromium by hand). Until a production-mode leg exists, the policy's
      // only automated coverage is `app-spa-fallback.test.ts`, which asserts
      // the whole header string.
      //
      // **AND NO HOT MODULE REPLACEMENT** (DOR-1412). No spec edits source, so
      // the suite loses nothing — while a run leaves it on, anything that
      // rewrites a watched file hot-replaces React context modules under a live
      // page and the app is replaced by its error boundary mid-test. The
      // rewriters are ordinary: the Express legs beside this one each boot by
      // running `turbo run build`, and this checkout is routinely shared with
      // other agents. `apps/client/vite.config.ts` carries the measurement and
      // the mechanism; `__tests__/playwright-config.test.ts` fails if either
      // Vite leg loses this.
      command: `DORKOS_PORT=${PORT} VITE_PORT=${VITE_PORT} DORKOS_E2E_NO_HMR=true dotenv -- turbo dev --filter=@dorkos/client`,
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
          // Same lock as the cockpit leg above, for the same reason — this leg
          // boots the same server and swept the same real transcripts into its
          // own temp directory (DOR-1551).
          DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
        },
        resetThrowawayHome(MOCK_DORK_HOME)
      ),
      url: `http://localhost:${MOCK_PORT}/api/health`,
      name: 'Express API (test-mode)',
      // Same boot path and the same 240s budget as the cockpit Express leg
      // above — offset by +1s so the two are still distinct timeout VALUES
      // (see that leg's comment for why a distinct number matters).
      timeout: 241_000,
      reuseExistingServer: REUSE_EXISTING_SERVER,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    // Vite client for mock tests — proxies /api to the test-mode server on MOCK_PORT.
    // Without this, the main Vite client (port 4241) would proxy to the real server,
    // and mock scenarios set on MOCK_PORT would never be used by the UI.
    {
      command: `DORKOS_PORT=${MOCK_PORT} VITE_PORT=${MOCK_VITE_PORT} DORKOS_E2E_NO_HMR=true dotenv -- turbo dev --filter=@dorkos/client`,
      url: `http://localhost:${MOCK_VITE_PORT}`,
      name: 'Vite Client (test-mode)',
      // Same reasoning as the test-mode Express leg above: same budget as the
      // cockpit Vite leg, offset +1s so the two timeout VALUES stay distinct.
      timeout: 121_000,
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
            // Was 180_000 (DOR-1243). The readiness probe is a GET on `/`,
            // which needs a cold-cache Turbopack compile of the marketing
            // homepage — measured 12.8s on a warm laptop, but that says
            // nothing about a cold ubuntu-latest runner under load, which is
            // what CI always is. `Error: Timed out waiting 180000ms from
            // config.webServer.` hit PR #1032 twice and one main push (run
            // 31922834734); nothing about the product was broken either
            // time, only the runner losing the race against 180s.
            //
            // 180s was never a measured number for THIS leg. 240s is: it is
            // what the two Express legs already run at, and they boot a
            // heavier `turbo run build` + `tsx` chain than a Next dev server
            // compiling one page. Matching that budget, instead of inventing
            // a third number, borrows a margin already proven adequate for
            // the suite's slower legs. +2s over the test-mode Express leg's
            // 241_000 keeps every timeout in this array a distinct value
            // (see the cockpit Express leg's comment for why that matters)
            // while staying visibly in the "≈240s" family rather than
            // reading as its own tuned number.
            //
            // The probe stays on `/`, not a cheaper route: this leg's whole
            // point is proving the live marketing pages render, and the
            // specs that need it (marketplace.spec.ts, features.spec.ts)
            // exercise pages behind the same root layout that `/` already
            // forces Turbopack to compile. A cheaper probe would only hide a
            // slow or broken homepage behind a green webServer gate.
            timeout: 242_000,
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
        // Runs against the test-mode leg in `chromium-team-room` below. It must
        // NEVER run here: posting in #team on this leg starts a real
        // claude-code turn on DorkBot's `always` seat and bills the machine's
        // own sign-in — see that spec's header.
        '**/home-surface/team-room.spec.ts',
        // Runs against the test-mode leg in `chromium-streams` below.
        '**/streams/**',
        // Both run against the test-mode leg in `chromium-rooms-agents` below,
        // and both must NEVER run here. They are the only rooms specs that
        // un-silence an agent, so on this leg every turn they start would be a
        // real, billable claude-code turn — see their headers.
        '**/rooms/room-autonomy.spec.ts',
        '**/rooms/agent-reactions.spec.ts',
        '**/rooms/room-tool-only-replies.spec.ts',
        // Needs the test-mode server's `/api/test/seed-bridge` seam, so it runs
        // in `chromium-bridge` below, never against the real cockpit leg.
        '**/relay/bridged-channel.spec.ts',
        // Belt and braces. `tests/chat/session-read-state*` is a MODULE, not a
        // spec — it is registered into `chat-mock.spec.ts` and runs on the
        // test-mode leg (see its header), so the default `**/*.spec.ts` match
        // already cannot reach it. Named anyway because `tests/chat/` is
        // otherwise a cockpit-leg directory, and this suite drives real turns:
        // one rename to `.spec.ts` would put four billable sessions on the
        // machine's own `claude` sign-in, and nothing else here would object.
        '**/chat/session-read-state*',
        // Same shape, same lock: a module registered into `chat-mock.spec.ts`,
        // living under `tests/chat/` because that is the feature it belongs to.
        // It drives a send and flips a server-global preference, so it must
        // never reach this leg (DOR-948).
        '**/chat/composer-escape-and-ime*',
        // Two more of the same shape (DOR-1214). Both drive turns that PARK on
        // an operator answer or a step barrier, and both depend on the
        // interactive scenarios that exist only under `DORKOS_TEST_RUNTIME`. On
        // this leg they would neither find their scenario nor be free: every
        // send would start a real, billable claude-code turn.
        '**/chat/interactive-prompts*',
        '**/chat/live-turn-visibility*',
        // And again: the compaction suite (L-04, DOR-1215) drives three turns
        // and a `/compact` per run, so reaching this leg would bill the
        // machine's own `claude` sign-in for every one of them.
        '**/chat/compaction*',
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
      // beforeEach resets.
      //
      // So a new mock-server suite takes one of two shapes, never a second spec
      // file. Write it into chat-mock.spec.ts when it is a handful of tests. Put
      // it in a MODULE that exports a register function when it is a coherent
      // feature suite worth finding by name — `tests/chat/session-read-state.ts`
      // is the worked example. Playwright groups workers by the file it LOADED
      // (`_requireFile`), so a registered module runs on this file's worker, in
      // its order, and is as safe from the resets as a suite written inline.
      // What it must not be is its own `*.spec.ts`.
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
      // Home is the #team room (spec `team-room-home` Phase 2) — against the
      // test-mode leg, and that is a safety property rather than a convenience.
      // DorkBot holds #team's `always` seat and its manifest names
      // `claude-code`; the cockpit leg registers the real Claude Code runtime,
      // so one Enter in the home composer would start a real, billable turn
      // against whatever `claude` sign-in the machine has. This leg registers a
      // claude-code-typed TestModeRuntime alias
      // (`DORKOS_TEST_RUNTIME_CLAUDE_ALIAS`), so the same seat answers for free.
      //
      // A separate project rather than a chat-mock suite because it shares none
      // of chat-mock's scenario/reset choreography: it drives room turns, whose
      // replies do not depend on the scenario the store happens to hold. It is
      // internally serial (the file configures it) because one of its tests
      // archives the shared #team, which changes what `/` renders for every
      // page on this server until it is restored.
      name: 'chromium-team-room',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${MOCK_VITE_PORT}`,
      },
      testMatch: ['**/home-surface/team-room.spec.ts'],
    },
    {
      // Rooms that let an agent ACT (room-participation RP6–RP8) — against the
      // test-mode leg, and that is a safety property rather than a convenience,
      // exactly as it is for `chromium-team-room`. Every spec here un-silences a
      // room agent, which the `roomsApi` fixture otherwise guarantees never
      // happens; on the cockpit leg that is a real claude-code turn on the
      // machine's own sign-in, once per test. This leg's
      // `DORKOS_TEST_RUNTIME_CLAUDE_ALIAS` answers the same seat for free, and
      // each spec re-checks the leg before it seeds anything.
      //
      // TWO spec files rather than one suite because they need nothing from each
      // other: `room-autonomy` drives turns (and borrows the server-global
      // scenario store, as `streams/session-queue.spec.ts` does), while
      // `agent-reactions` drives no turn at all — it acts as an agent over HTTP
      // with a real minted token. Neither reads state the other writes, and both
      // assert only on rooms they seeded, so they run beside each other and
      // beside the other test-mode projects.
      name: 'chromium-rooms-agents',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${MOCK_VITE_PORT}`,
      },
      testMatch: [
        '**/rooms/room-autonomy.spec.ts',
        '**/rooms/agent-reactions.spec.ts',
        // The flip (DOR-1613). Here for the same reason as its two neighbours:
        // it un-silences an agent, so on the cockpit leg every test in it would
        // start a real, billable claude-code turn.
        '**/rooms/room-tool-only-replies.spec.ts',
      ],
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
