/**
 * Checks that every API leg is on a throwaway data directory, then puts the
 * first-run onboarding wizard away — both before any spec runs.
 *
 * The isolation check comes first and is the reason this file may write at all:
 * see {@link assertThrowawayHome}.
 *
 * `AppShell` renders the wizard *instead of* the cockpit, not on top of it — the
 * two are the branches of one ternary, and only the cockpit branch carries
 * `data-testid="app-shell"`. So against a `DORK_HOME` that has never been
 * onboarded, every spec that waits for the app shell times out, which is every
 * spec that does anything. The suite used to hide this by running against
 * whatever `~/.dork`-shaped directory the developer had already clicked through;
 * point it at a throwaway one — which is exactly what the isolated-run recipe in
 * `README.md` tells you to do — and the whole suite goes red for a reason that
 * has nothing to do with the code under test.
 *
 * Dismissing it here rather than in a fixture means it happens once per run
 * instead of once per test, and it covers specs that never touch the rooms
 * fixtures.
 *
 * Every API leg gets its own call: the cockpit server and the test-mode server
 * keep separate `DORK_HOME`s, so dismissing it on one says nothing about the
 * other. Each project's `baseURL` is a Vite dev server that proxies `/api` to
 * its own leg, so going through it needs no port bookkeeping here and exercises
 * the same path the browser does.
 *
 * @module global-setup
 */
import { chromium, request, type APIResponse, type FullConfig } from '@playwright/test';

/**
 * Where a leg's `DORK_HOME` is allowed to be.
 *
 * Both Express legs name a throwaway home under `/tmp`, keyed by port and
 * deleted before every boot (`playwright.config.ts`). macOS resolves `/tmp` to
 * `/private/tmp`, so both spellings are accepted — the server echoes the path it
 * was handed, but a leg pointed at a realpath is the same directory.
 */
const THROWAWAY_HOME_PREFIXES = ['/tmp/dorkos-', '/private/tmp/dorkos-'];

/**
 * Refuse to run against a data directory this suite does not own.
 *
 * THE GUARANTEE THIS MAKES EXECUTABLE (DOR-1223). The cockpit leg used to boot
 * with no `DORK_HOME` at all, so the server resolved its dev default —
 * `apps/server/.temp/.dork`, the directory `pnpm dev` and `pnpm dev:dogfood`
 * read — and every run wrote onboarding timestamps, sidebar groups, rooms and
 * agent registrations into the operator's live data. The fix was one `DORK_HOME:`
 * line per leg, and deleting that line again would fail NOTHING: the suite would
 * go green while quietly editing somebody's cockpit. A guarantee no test can
 * break is a comment, not a guarantee.
 *
 * So it is asserted here, from the server's own answer rather than from the
 * config that was supposed to set it — `GET /api/config` reports the `DORK_HOME`
 * the process actually resolved, which is the only thing that can disagree with
 * intent. Checked per leg, before any spec runs, because the first write this
 * file makes is the onboarding dismissal below.
 *
 * @param baseURL - The Vite dev server that proxies to the leg being checked.
 * @param dorkHome - The data directory that leg reported.
 */
function assertThrowawayHome(baseURL: string, dorkHome: string | undefined): void {
  if (dorkHome && THROWAWAY_HOME_PREFIXES.some((prefix) => dorkHome.startsWith(prefix))) return;
  throw new Error(
    `Refusing to run: the API leg behind ${baseURL} keeps its data in ${dorkHome ?? '(not reported)'}, ` +
      `which is not a throwaway this run owns (expected a path under ${THROWAWAY_HOME_PREFIXES[0]}).\n` +
      `That directory is somebody's real data — the installed cockpit's ~/.dork, or the dev stack's ` +
      `apps/server/.temp/.dork — and this suite archives rooms, registers agents and rewrites config.\n` +
      `Check that the leg still sets DORK_HOME in apps/e2e/playwright.config.ts (DOR-1223).`
  );
}

/** How long to keep asking the API for its config before giving up. */
const CONFIG_READY_TIMEOUT_MS = 30_000;

/** How long to wait between attempts. */
const CONFIG_RETRY_DELAY_MS = 500;

/**
 * Read `/api/config`, waiting out a cold start rather than failing on it.
 *
 * Playwright's `webServer.url` gate proves the Vite dev server's PORT is
 * answering, which is not the same as the API behind its proxy being up: on a
 * cold start the first `/api/*` request through that proxy can 500 or time out
 * while the server is still booting. It fired on two of three suite launches,
 * which is often enough to be a broken gate rather than a flake — and it took
 * the whole run with it, because this is global setup.
 *
 * Bounded, so a genuinely dead API still fails the run instead of hanging it,
 * and it reports the last thing it saw.
 *
 * @param context - A request context already bound to `baseURL`.
 * @param baseURL - The Vite dev server that proxies to the leg being checked.
 * @returns The successful response.
 */
async function readConfigWhenReady(
  context: Awaited<ReturnType<typeof request.newContext>>,
  baseURL: string
): Promise<APIResponse> {
  const deadline = Date.now() + CONFIG_READY_TIMEOUT_MS;
  let lastSeen = '(no response)';
  for (;;) {
    try {
      const response = await context.get('/api/config');
      if (response.ok()) return response;
      lastSeen = String(response.status());
    } catch (error) {
      lastSeen = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Could not read config at ${baseURL} within ${CONFIG_READY_TIMEOUT_MS / 1000}s: ${lastSeen}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIG_RETRY_DELAY_MS));
  }
}

/**
 * Mark onboarding dismissed — and the follow-up role prompt with it — on the
 * server behind one base URL.
 *
 * The role prompt matters for the same reason the wizard does, one notch
 * subtler. `ProfilePromptCard` shows precisely when onboarding is dismissed
 * but no profile role was ever saved — which is this suite's steady state by
 * construction — and it mounts INTO THE SIDEBAR asynchronously, once the
 * config query resolves. A card appearing mid-test shifts every sidebar row
 * under a pointer-driven drag (sidebar-groups.spec.ts failed exactly that
 * way when the card shipped). Suppressing it here is the shipped "Don't ask
 * again" write, so the suite tests the settled state, not the one-time ask.
 *
 * Reads before it writes so a re-run against a persistent `DORK_HOME` is a no-op
 * rather than a redundant write.
 *
 * @param baseURL - A Vite dev server that proxies `/api` to its own API leg.
 */
async function dismissOnboarding(baseURL: string): Promise<void> {
  const context = await request.newContext({ baseURL });
  try {
    const current = await readConfigWhenReady(context, baseURL);
    const { onboarding, profile, dorkHome } = (await current.json()) as {
      onboarding?: { dismissedAt?: string };
      profile?: { rolePromptDismissedAt?: string | null };
      dorkHome?: string;
    };
    // Before the first write, and on the same read that was already happening.
    assertThrowawayHome(baseURL, dorkHome);
    if (onboarding?.dismissedAt && profile?.rolePromptDismissedAt) return;

    const now = new Date().toISOString();
    const res = await context.patch('/api/config', {
      data: {
        onboarding: { dismissedAt: onboarding?.dismissedAt ?? now },
        profile: { rolePromptDismissedAt: profile?.rolePromptDismissedAt ?? now },
      },
    });
    if (!res.ok()) {
      throw new Error(
        `Could not dismiss onboarding at ${baseURL}: ${res.status()} ${await res.text()}`
      );
    }
  } finally {
    await context.dispose();
  }
}

/**
 * Load a base URL once in a real browser so Vite has pre-bundled before any
 * spec navigates.
 *
 * Vite answers its readiness probe long before it can serve the app: the module
 * graph is transformed on first request, and for this client that first load
 * costs tens of seconds. Playwright's `webServer.url` gate only proves the port
 * is answering, so the specs that happened to run first wore that cost and
 * failed on `page.goto: Test timeout` — five of them in one run.
 *
 * This used to be hidden by `reuseExistingServer`, which handed most local runs
 * an already-warm dev server. Now that no run adopts a server it did not start,
 * every run starts cold and the warm-up has to be explicit. Paying it once here
 * is not the same as raising the per-test timeout: nothing about cold-start
 * latency is under test, and a spec that genuinely hangs still fails at 30s.
 *
 * @param baseURL - The Vite dev server to warm.
 */
async function warmClient(baseURL: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL });
    await page.goto('/', { timeout: 180_000 });
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 180_000 });
  } finally {
    await browser.close();
  }
}

/**
 * Dismiss onboarding on every distinct API leg the run will use, then warm each
 * client so no spec pays Vite's cold start.
 *
 * @param config - The resolved Playwright config, read for its projects' base URLs.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURLs = new Set(
    config.projects.map((project) => project.use.baseURL).filter((url): url is string => !!url)
  );
  // Onboarding first, and on every leg: the warm-up waits for the app shell,
  // which the first-run wizard renders instead of.
  await Promise.all([...baseURLs].map(dismissOnboarding));
  await Promise.all([...baseURLs].map(warmClient));
}
