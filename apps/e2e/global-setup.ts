/**
 * Puts the first-run onboarding wizard away before any spec runs.
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
import { chromium, request, type FullConfig } from '@playwright/test';

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
    const current = await context.get('/api/config');
    if (!current.ok()) {
      throw new Error(`Could not read config at ${baseURL}: ${current.status()}`);
    }
    const { onboarding, profile } = (await current.json()) as {
      onboarding?: { dismissedAt?: string };
      profile?: { rolePromptDismissedAt?: string | null };
    };
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
