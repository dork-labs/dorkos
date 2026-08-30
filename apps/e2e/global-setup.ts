/**
 * Checks that every API leg is on a throwaway data directory, then puts the
 * first-run interruptions away — the onboarding wizard, its follow-up role
 * prompt, the telemetry-consent modal, and the full-power consent door — all
 * before any spec runs.
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
 * Retry an `/api/*` call through a leg's Vite proxy, waiting out a cold start
 * rather than failing on it.
 *
 * Playwright's `webServer.url` gate proves the Vite dev server's PORT is
 * answering, which is not the same as the API behind its proxy being up: on a
 * cold start the first `/api/*` request through that proxy can 500, ETIMEDOUT,
 * or otherwise fail while the server is still booting. It fired on two of
 * three suite launches for the read below, which is often enough to be a
 * broken gate rather than a flake — and it took the whole run with it,
 * because this is global setup. The write in {@link dismissOnboarding} hit
 * the identical cold-start race with no retry at all (DOR-1622): a single
 * ETIMEDOUT through the proxy killed the run before any spec executed, even
 * though the read just above it had already proven the leg was warming up
 * fine. Both go through this one retrying attempt now, and the write is safe
 * to repeat — its body is idempotent (see the comment on that call).
 *
 * Bounded, so a genuinely dead leg still fails the run instead of hanging it,
 * and it reports the last thing it saw.
 *
 * @param attempt - Makes one request; called again on failure until it
 *   succeeds or the deadline passes.
 * @param describe - What the call is doing, for the timeout error's message.
 * @param baseURL - The Vite dev server that proxies to the leg being checked.
 * @returns The successful response.
 */
async function requestWhenReady(
  attempt: () => Promise<APIResponse>,
  describe: string,
  baseURL: string
): Promise<APIResponse> {
  const deadline = Date.now() + CONFIG_READY_TIMEOUT_MS;
  let lastSeen = '(no response)';
  for (;;) {
    try {
      const response = await attempt();
      if (response.ok()) return response;
      lastSeen = String(response.status());
    } catch (error) {
      lastSeen = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Could not ${describe} at ${baseURL} within ${CONFIG_READY_TIMEOUT_MS / 1000}s: ${lastSeen}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIG_RETRY_DELAY_MS));
  }
}

/**
 * Read `/api/config`, waiting out a cold start rather than failing on it. See
 * {@link requestWhenReady}.
 *
 * @param context - A request context already bound to `baseURL`.
 * @param baseURL - The Vite dev server that proxies to the leg being checked.
 * @returns The successful response.
 */
async function readConfigWhenReady(
  context: Awaited<ReturnType<typeof request.newContext>>,
  baseURL: string
): Promise<APIResponse> {
  return requestWhenReady(() => context.get('/api/config'), 'read config', baseURL);
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
 * Telemetry consent is the third first-run interruption, and the one that bites
 * hardest now. It used to be a banner — harmless to ignore — but is now a launch
 * MODAL on the moments rail (spec `full-power-defaults` D5), which focus-traps
 * and sets `pointer-events: none` on the app body. A spec that clicks or opens a
 * dialog right after boot is ambushed by it (runtimes-tab, settings-dialog and
 * room-entry-actions all failed this way). Settling it here — a real, opted-out
 * decision, matching `capture/seed.ts` — makes the moment ineligible so no spec
 * ever sees it, and no spec has to know it exists. Channels stay off; the
 * defaults are already `false`, so `userHasDecided: true` alone closes it.
 *
 * The full-power consent door is the fourth, and it bites the same way: a launch
 * modal on the same rail, eligible whenever `ui.fullPowerDecidedAt` is null and
 * onboarding is settled — this suite's steady state. Settling a "supervised"
 * decision makes it ineligible without flipping any consent-gated value, so the
 * suite keeps its safe defaults; the opt-in `full-power-door.spec.ts` re-opens it
 * deliberately on a serial run.
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
    const { onboarding, profile, telemetry, ui, dorkHome } = (await current.json()) as {
      onboarding?: { dismissedAt?: string };
      profile?: { rolePromptDismissedAt?: string | null };
      telemetry?: { userHasDecided?: boolean };
      ui?: { fullPowerDecidedAt?: string | null; fullPowerChoice?: string | null };
      dorkHome?: string;
    };
    // Before the first write, and on the same read that was already happening.
    assertThrowawayHome(baseURL, dorkHome);
    if (
      onboarding?.dismissedAt &&
      profile?.rolePromptDismissedAt &&
      telemetry?.userHasDecided &&
      ui?.fullPowerDecidedAt
    ) {
      return;
    }

    const now = new Date().toISOString();
    // Retried the same way the read above is: the write hits the identical
    // cold-start proxy race, and its body is fully idempotent — every field
    // is either a fixed value or a `?? now`/`?? current-value` fallback
    // computed once above, so repeating it changes nothing (DOR-1622).
    await requestWhenReady(
      () =>
        context.patch('/api/config', {
          data: {
            onboarding: { dismissedAt: onboarding?.dismissedAt ?? now },
            profile: { rolePromptDismissedAt: profile?.rolePromptDismissedAt ?? now },
            // Record a settled decision so the launch modal never renders. NOT
            // `?? true` like the two above: `userHasDecided` defaults to an explicit
            // `false` (unlike `dismissedAt`, which is absent until set), and
            // `false ?? true` is `false` — which would write the unset value back
            // and leave the modal to ambush the next spec. The write is
            // idempotent: on a persistent home that already decided, this rewrites
            // the same `true`, and the channels it does not name keep their values.
            telemetry: { userHasDecided: true },
            // The full-power consent door is the second launch modal on the moments
            // rail (spec `full-power-defaults` D3), eligible whenever onboarding is
            // settled and `ui.fullPowerDecidedAt` is still null — which is EXACTLY
            // this suite's steady state, so without this every spec is ambushed by
            // it the way telemetry once ambushed them. Settle a real "supervised"
            // decision: it records that the question was answered WITHOUT flipping
            // any consent-gated value (no autonomy stop, no standing grants, no open
            // mesh), so the suite runs at the same safe defaults it always has. The
            // opt-in `full-power-door.spec.ts` re-opens the door on its own serial
            // run; nothing else should see it.
            ui: {
              fullPowerDecidedAt: ui?.fullPowerDecidedAt ?? now,
              // `?? 'supervised'` for the same reason the timestamp uses `?? now`: a
              // persistent home that already chose 'full' keeps it rather than being
              // quietly demoted. (Theoretical for a throwaway e2e home, but the two
              // fields settle together, so they defer together.)
              fullPowerChoice: ui?.fullPowerChoice ?? 'supervised',
            },
          },
        }),
      'dismiss first-run prompts',
      baseURL
    );
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
 * Settle the first-run prompts on every distinct API leg the run will use, then
 * warm each client so no spec pays Vite's cold start.
 *
 * @param config - The resolved Playwright config, read for its projects' base URLs.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURLs = new Set(
    config.projects.map((project) => project.use.baseURL).filter((url): url is string => !!url)
  );
  // Prompts first, and on every leg: the warm-up waits for the app shell, which
  // the first-run wizard renders instead of, and which the consent modal covers.
  await Promise.all([...baseURLs].map(dismissOnboarding));
  await Promise.all([...baseURLs].map(warmClient));
}
