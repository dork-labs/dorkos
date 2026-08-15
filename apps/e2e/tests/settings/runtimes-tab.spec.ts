import { test, expect } from '../../fixtures';
import type { APIRequestContext } from '@playwright/test';

/**
 * Settings → Runtimes: the status board, and the two writes it owns.
 *
 * The tab draws one card per runtime and every setting that belongs to a runtime
 * lives on that runtime's card (spec `runtimes-settings-redesign`). What this
 * file proves in a real browser, which no unit test can:
 *
 * 1. the tab renders a card for each of the three runtimes DorkOS ships,
 *    whatever this machine has installed;
 * 2. a card opens and closes independently, and its body is only offered when
 *    there is something inside it;
 * 3. `Check again` really re-probes the server rather than re-rendering;
 * 4. `Make default` writes `runtimes.default` and the choice survives a full
 *    page reload — the whole round trip through Express and `config.json`;
 * 5. a runtime that is NOT the default can still have its model set, which is
 *    the capability hole this redesign closes.
 *
 * WHAT THIS SUITE CAN AND CANNOT SEE, stated plainly, because the difference is
 * a property of the machine and not of the code. A card renders its settings
 * rows (Model, Effort, Trust) only while its runtime is READY, and ready means
 * the server resolved the CLI *and* found an authentication for it. The CLI half
 * travels with the repo (Claude Code and Codex both vendor their binary through
 * `pnpm install`), but the sign-in half cannot: a CI runner has no
 * `claude auth login`, no ChatGPT login and no `CODEX_API_KEY`, so on CI every
 * card renders in its not-yet-connected state and there are no rows to drive. So:
 *
 * - Tests 1-4 assert only what is true with nothing connected — verified that
 *   way, not assumed: run against a genuinely unconnected runtime they pass
 *   unchanged. They cover the default-runtime write end to end, because
 *   `Make default` is offered on every card regardless of readiness (pointing
 *   new conversations at a runtime you are about to connect is a legitimate
 *   thing to do, and the card then says so itself).
 * - Test 5 needs a SECOND connected runtime, and skips with a reason when Codex
 *   is not signed in here. It is the only part of the spec's flow that cannot be
 *   expressed on a machine with nothing connected, and faking it would mean
 *   faking readiness — at which point the test would prove something about the
 *   fake and nothing about the product. It runs on any machine where `codex` is
 *   signed in (it does, and passes, on a developer laptop); the same wiring
 *   under a mocked capability map is `RuntimeCard.test.tsx`.
 *
 * The test-mode server is not an escape hatch for that gap either: `TestModeRuntime`
 * declares `settings.configSection: null`, which means it has nowhere to keep a
 * per-runtime setting at all — its card says so and offers no rows to drive —
 * and its project (`chromium-mock`) is a single spec file by design.
 *
 * SERIAL, and it has to be: two of these tests move `runtimes.default`, which is
 * one global setting on a server the whole suite shares. Run in parallel with
 * each other they would each be asserting about a value the other is changing.
 * Nothing outside this file reads it (the only cockpit specs that start sessions
 * are `@integration`-tagged and off by default), and the `afterEach` below puts
 * both writes back however a test ends.
 */
test.describe.configure({ mode: 'serial' });

/**
 * The three runtimes the tab always draws, whatever this machine has installed.
 *
 * `listRuntimeTypes` puts the primaries first and unconditionally, so this is a
 * claim about the product and not about the server the run happens to have.
 */
const SHIPPED_RUNTIMES = ['claude-code', 'codex', 'opencode'];

/** The runtime a fresh DorkOS points new conversations at. */
const DEFAULT_RUNTIME = 'claude-code';

/** The non-default runtime this file drives. */
const OTHER_RUNTIME = 'codex';

/**
 * What `GET /api/config` says about the two settings this file moves.
 *
 * The curated read, not the raw config block: `executionDefaults` is what the
 * Runtimes card itself renders (`describeExecutionDefaults`), so reading it here
 * asks the same question the screen asks.
 */
interface ExecutionDefaultsView {
  executionDefaults?: {
    runtime?: string;
    perRuntime?: { runtime: string; model: string | null }[];
  };
}

/** The two values this file moves, as they were before it ran. */
interface PriorDefaults {
  /** Which runtime new conversations start on. */
  runtime: string;
  /**
   * The non-default runtime's model, or `null` for "the runtime's choice".
   *
   * `undefined` means the server did not report that runtime at all, which is
   * what a DISABLED runtime looks like from here (`describeExecutionDefaults`
   * covers the registered ones). Its stored model still exists in config and is
   * simply not visible — so the restore below leaves that key alone rather than
   * writing a `null` it never read.
   */
  otherModel: string | null | undefined;
}

/**
 * Read the two settings this file moves, so they can be put back as found.
 *
 * @param request - Playwright's request fixture, based at the cockpit leg.
 */
async function readPriorDefaults(request: APIRequestContext): Promise<PriorDefaults> {
  const response = await request.get('/api/config');
  expect(response.ok()).toBe(true);
  const { executionDefaults } = (await response.json()) as ExecutionDefaultsView;
  const other = executionDefaults?.perRuntime?.find((entry) => entry.runtime === OTHER_RUNTIME);
  return {
    runtime: executionDefaults?.runtime ?? DEFAULT_RUNTIME,
    otherModel: other ? other.model : undefined,
  };
}

test.describe('Settings — Runtimes tab @smoke', () => {
  /**
   * Captured once, before the first test moves anything — so the `afterEach`
   * below restores what this machine HAD rather than what the schema says a
   * fresh install would have. Those two agree on a leg whose `DORK_HOME` is
   * thrown away every boot, and nowhere else: point a run at a home that
   * persists — an operator's own install, a leg someone rewired — and the old
   * hardcoded reset silently retyped their chosen default runtime to
   * `claude-code` on every run. Restoring what you found costs one GET (DOR-1223).
   */
  let prior: PriorDefaults;

  test.beforeAll(async ({ request }) => {
    prior = await readPriorDefaults(request);
  });

  test.beforeEach(async ({ basePage, settingsPage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
    await settingsPage.open();
    await settingsPage.switchTab('Runtimes');
  });

  // Everything this file writes, undone — whether the test that wrote it passed,
  // failed halfway, or timed out. Both keys are global to the server, and a run
  // that left either one moved would hand the next spec (or the next run against
  // a persistent DORK_HOME) a machine configured by a test.
  test.afterEach(async ({ request }) => {
    const restored = await request.patch('/api/config', {
      data: {
        runtimes: {
          default: prior.runtime,
          // Only when the server reported it — see `PriorDefaults.otherModel`.
          ...(prior.otherModel !== undefined
            ? { [OTHER_RUNTIME]: { defaultModel: prior.otherModel } }
            : {}),
        },
      },
    });
    expect(restored.ok()).toBe(true);
  });

  test('renders one card per runtime, with exactly one marked default', async ({
    settingsPage,
  }) => {
    for (const type of SHIPPED_RUNTIMES) {
      await expect(settingsPage.runtimeCard(type)).toBeVisible();
    }

    // One default, and it is a state a CARD is in — the dropdown that used to
    // say this is gone.
    await expect(settingsPage.runtimeDefaultPills).toHaveCount(1);
    await expect(settingsPage.runtimeDefaultPill(DEFAULT_RUNTIME)).toBeVisible();

    // The two things that are true of the whole fleet, beneath the cards.
    await expect(settingsPage.globalTrustRow).toBeVisible();
    await expect(settingsPage.runtimesRecheck).toBeVisible();
  });

  test('opens and closes one card without touching the others', async ({ settingsPage }) => {
    const toggle = settingsPage.runtimeCardToggle(DEFAULT_RUNTIME);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(settingsPage.runtimeCardBody(DEFAULT_RUNTIME)).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(settingsPage.runtimeCardBody(DEFAULT_RUNTIME)).toBeVisible();

    // No accordion: opening one card leaves every other card shut (design §4).
    await expect(settingsPage.runtimeCardBody(OTHER_RUNTIME)).toBeHidden();
    await expect(settingsPage.runtimeCardToggle(OTHER_RUNTIME)).toHaveAttribute(
      'aria-expanded',
      'false'
    );

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(settingsPage.runtimeCardBody(DEFAULT_RUNTIME)).toBeHidden();
  });

  test('Check again re-probes the server', async ({ page, settingsPage }) => {
    // The requirements query is deliberately never automatic (it shells out to
    // each runtime's binary), so this button is the only thing that re-asks.
    // Asserting the REQUEST, not a repaint: a button that re-rendered stale
    // state would look identical.
    const reprobe = page.waitForResponse(
      (response) =>
        response.url().includes('/api/system/requirements') && response.request().method() === 'GET'
    );
    await settingsPage.runtimesRecheck.click();
    expect((await reprobe).ok()).toBe(true);
  });

  test('Make default moves the default, and it survives a reload', async ({
    basePage,
    settingsPage,
  }) => {
    await settingsPage.runtimeMakeDefault(OTHER_RUNTIME).click();

    await expect(settingsPage.runtimeDefaultPill(OTHER_RUNTIME)).toBeVisible();
    await expect(settingsPage.runtimeDefaultPill(DEFAULT_RUNTIME)).toBeHidden();
    await expect(settingsPage.runtimeDefaultPills).toHaveCount(1);
    // The card that just became the default can no longer be made it.
    await expect(settingsPage.runtimeMakeDefault(OTHER_RUNTIME)).toHaveCount(0);

    // The point of the reload: the pill after a repaint proves a cache write,
    // the pill after a reload proves the server stored it.
    await basePage.goto();
    await basePage.waitForAppReady();
    await settingsPage.open();
    await settingsPage.switchTab('Runtimes');

    await expect(settingsPage.runtimeDefaultPill(OTHER_RUNTIME)).toBeVisible();
    await expect(settingsPage.runtimeDefaultPills).toHaveCount(1);

    // Put it back the same way a person would, which is also the other half of
    // the assertion: the choice moves both ways.
    await settingsPage.runtimeMakeDefault(DEFAULT_RUNTIME).click();
    await expect(settingsPage.runtimeDefaultPill(DEFAULT_RUNTIME)).toBeVisible();
    await expect(settingsPage.runtimeDefaultPill(OTHER_RUNTIME)).toBeHidden();
  });

  test('sets the model of a runtime that new conversations do not start on', async ({
    basePage,
    page,
    request,
    settingsPage,
  }) => {
    // Readiness is a fact about this machine, not about the build — see the file
    // header. Read it from the same endpoint the tab reads rather than inferring
    // it from the DOM, so a skip says something true about the server.
    const requirements = (await (await request.get('/api/system/requirements')).json()) as {
      runtimes: Record<string, { state?: string }>;
    };
    test.skip(
      requirements.runtimes[OTHER_RUNTIME]?.state !== 'ready',
      `${OTHER_RUNTIME} is not connected on this machine, and a runtime's settings rows only exist once it is. This is the one step of the flow that needs a second connected runtime.`
    );

    // The capability hole, precisely: Codex is not the default here, and before
    // this redesign that made its model unreachable.
    await expect(settingsPage.runtimeDefaultPill(OTHER_RUNTIME)).toBeHidden();

    await settingsPage.runtimeCardToggle(OTHER_RUNTIME).click();
    const modelSelect = settingsPage.runtimeModelSelect(OTHER_RUNTIME);
    await expect(modelSelect).toBeVisible();

    // Whatever the pinned catalog offers, not a hardcoded model id: the first
    // option is "Runtime's choice", so the second is the first real model, and
    // the run reads its name instead of assuming it. Radix portals the list out
    // of the dialog, so it is located on the page.
    await modelSelect.click();
    const firstModel = page.getByRole('option').nth(1);
    const modelName = ((await firstModel.textContent()) ?? '').trim();
    expect(modelName.length).toBeGreaterThan(0);
    await firstModel.click();

    await expect(modelSelect).toHaveText(modelName);
    // The write happened on a card that is still not the default — the thing
    // that was impossible.
    await expect(settingsPage.runtimeDefaultPill(OTHER_RUNTIME)).toBeHidden();

    // Collapsed, the card says what it now starts on; reloaded, it still does.
    await basePage.goto();
    await basePage.waitForAppReady();
    await settingsPage.open();
    await settingsPage.switchTab('Runtimes');
    await expect(settingsPage.runtimeCardSummary(OTHER_RUNTIME)).toContainText(modelName);

    // Back to the runtime's own choice, through the UI that set it.
    await settingsPage.runtimeCardToggle(OTHER_RUNTIME).click();
    await settingsPage.runtimeModelSelect(OTHER_RUNTIME).click();
    await page.getByRole('option').first().click();
    await expect(settingsPage.runtimeModelSelect(OTHER_RUNTIME)).not.toHaveText(modelName);
  });
});
