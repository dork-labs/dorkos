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
 * Readiness is a property of the machine: settings and Make default are only
 * offered after a runtime is connected. Every test waits for the real
 * requirements response and its corresponding card state, so it cannot click
 * an optimistic control that disappears when authentication checks finish.
 *
 * The card-state test always checks all three shipped runtimes against that
 * response, including Connect and the absence of Make default for disconnected
 * cards. The two write flows skip explicitly when the runtimes they need are
 * not connected. A CI runner without credentials still checks the settled UI;
 * a connected machine also checks the real PATCH, reload, and model writes.
 * No authentication or requirements responses are mocked.
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

/** The readiness facts returned by the same request that hydrates the cards. */
interface RuntimeRequirementsView {
  runtimes: Record<string, { state: 'ready' | 'connect' }>;
}

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

/** The two settings this file moves, as the server reports them. */
interface RuntimeDefaults {
  /** Which runtime new conversations start on. */
  runtime: string;
  /**
   * The non-default runtime's model, or `null` for "the runtime's choice".
   *
   * `null` is what the server reports for BOTH a stored `null` and a key that
   * was never written — `describeExecutionDefaults` fills the default in, and
   * this read cannot tell those apart. That is why the restore below writes only
   * what it sees CHANGED: a `PATCH` cannot express absence, so writing `null`
   * back over a never-stored key would leave the key behind. The only way this
   * file's restore writes `null` is when one of its own tests set a model, at
   * which point the key exists and `null` is the true prior value.
   *
   * `undefined` is different: the server did not report that runtime at all,
   * which is what a DISABLED runtime looks like from here. Its stored model is
   * untouched and invisible, so the restore leaves that key alone entirely.
   */
  otherModel: string | null | undefined;
}

/**
 * Read the two settings this file moves — before it moves them, and again after.
 *
 * @param request - Playwright's request fixture, based at the cockpit leg.
 */
async function readRuntimeDefaults(request: APIRequestContext): Promise<RuntimeDefaults> {
  const response = await request.get('/api/config');
  expect(response.ok()).toBe(true);
  const { executionDefaults } = (await response.json()) as ExecutionDefaultsView;
  const other = executionDefaults?.perRuntime?.find((entry) => entry.runtime === OTHER_RUNTIME);
  return {
    runtime: executionDefaults?.runtime ?? DEFAULT_RUNTIME,
    otherModel: other ? other.model : undefined,
  };
}

/** The `runtimes` block shape this file PATCHes — only the keys it changed. */
interface RuntimesPatch {
  /** Which runtime new conversations start on. */
  default?: string;
  /** A per-runtime settings section, keyed by runtime type. */
  [runtime: string]: { defaultModel: string | null } | string | undefined;
}

test.describe('Settings — Runtimes tab @smoke', () => {
  /**
   * Captured once, before the first test moves anything, so the `afterEach`
   * below puts back what this machine HAD rather than what the schema says a
   * fresh install would have.
   *
   * To be clear about what this does and does not buy, because the difference
   * is easy to overstate: the tests below still ASSERT `DEFAULT_RUNTIME`, so on
   * an install that starts conversations on codex this file goes red either
   * way. What changed is what it leaves behind on the way to that red. The old
   * `afterEach` wrote the schema constants unconditionally, so a run against
   * somebody's install retyped their chosen default to `claude-code` and then
   * failed — the damage landed BEFORE the failure told anyone. Reading first
   * costs one GET and means a red run is only a red run (DOR-1223).
   */
  let prior: RuntimeDefaults;
  let requirements: RuntimeRequirementsView;

  test.beforeAll(async ({ request }) => {
    prior = await readRuntimeDefaults(request);
  });

  test.beforeEach(async ({ basePage, page, settingsPage }) => {
    const response = page.waitForResponse(
      (result) =>
        result.url().includes('/api/system/requirements') && result.request().method() === 'GET'
    );
    await basePage.goto();
    await basePage.waitForAppReady();
    await settingsPage.open();
    await settingsPage.switchTab('Runtimes');
    const settled = await response;
    expect(settled.ok()).toBe(true);
    requirements = (await settled.json()) as RuntimeRequirementsView;
    // Receiving the network response is not yet a React render. Wait for each
    // card's positive readiness marker before asserting an absent action.
    for (const type of SHIPPED_RUNTIMES) {
      expect(requirements.runtimes[type]?.state, `${type} readiness`).toMatch(/^(ready|connect)$/);
      if (requirements.runtimes[type].state === 'ready') {
        await expect(settingsPage.runtimeReady(type)).toBeVisible();
      } else {
        await expect(
          settingsPage.runtimeCard(type).getByTestId(`runtime-card-connect-${type}`)
        ).toBeVisible();
      }
    }
  });

  // Everything this file MOVED, put back — whether the test that moved it
  // passed, failed halfway, or timed out. Both keys are global to the server, so
  // a run that left either one moved would hand the next spec (or the next run
  // against a persistent DORK_HOME) a machine configured by a test.
  //
  // Differential on purpose: it reads the current values and writes only the
  // ones that actually differ from what it found, so a test that touched
  // nothing writes nothing. Anything else would make the cleanup itself a
  // config write — and for the model that write is not harmless, because
  // `defaultModel: null` is indistinguishable from the key never having existed
  // (see `RuntimeDefaults.otherModel`), so an unconditional restore would store
  // a key this file invented.
  test.afterEach(async ({ request }) => {
    const current = await readRuntimeDefaults(request);

    const patch: RuntimesPatch = {};
    if (current.runtime !== prior.runtime) patch.default = prior.runtime;
    if (prior.otherModel !== undefined && current.otherModel !== prior.otherModel) {
      patch[OTHER_RUNTIME] = { defaultModel: prior.otherModel };
    }
    if (Object.keys(patch).length === 0) return;

    const restored = await request.patch('/api/config', { data: { runtimes: patch } });
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

  test('settled cards offer setup or default selection according to real readiness', async ({
    settingsPage,
  }) => {
    let checked = 0;
    for (const type of SHIPPED_RUNTIMES) {
      const card = settingsPage.runtimeCard(type);
      await expect(card).toBeVisible();
      if (requirements.runtimes[type].state === 'connect') {
        await expect(card.getByTestId(`runtime-card-connect-${type}`)).toBeVisible();
        await expect(card.getByTestId(`runtime-card-locked-${type}`)).toBeVisible();
        await expect(settingsPage.runtimeReady(type)).toHaveCount(0);
        await expect(settingsPage.runtimeMakeDefault(type)).toHaveCount(0);
      } else {
        await expect(settingsPage.runtimeReady(type)).toBeVisible();
        await expect(card.getByTestId(`runtime-card-connect-${type}`)).toHaveCount(0);
        if (type === DEFAULT_RUNTIME) {
          await expect(settingsPage.runtimeMakeDefault(type)).toHaveCount(0);
        } else {
          await expect(settingsPage.runtimeMakeDefault(type)).toBeVisible();
        }
      }
      checked++;
    }
    expect(checked).toBe(3);
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
    page,
    settingsPage,
  }) => {
    const disconnected = [DEFAULT_RUNTIME, OTHER_RUNTIME].filter(
      (runtime) => requirements.runtimes[runtime].state !== 'ready'
    );
    test.skip(
      disconnected.length > 0,
      `Default persistence needs both runtimes connected; unavailable here: ${disconnected.join(', ')}. Disconnected cards are covered by the settled-card test.`
    );
    // This flow boots twice and waits for real writes; keep the existing
    // larger budget, but never use it to wait for a control readiness forbids.
    test.slow();

    /**
     * Click one card's `Make default` and wait for the write itself.
     *
     * The button fires a `PATCH /api/config` and the pill repaints from the
     * refetch that follows. This is a SYNCHRONISATION BARRIER, not a claim that
     * the default moved: `ok()` only says the server accepted the write, and a
     * write that stored the wrong thing returns 200 all the same (measured —
     * pointing the patch at a key that moves nothing still passes here, and the
     * red lands on the pill assertion below). What it buys is that everything
     * after it is reading state the server has already answered for, instead of
     * guessing how fast this machine repaints.
     */
    const makeDefault = async (runtime: string): Promise<void> => {
      const written = page.waitForResponse(
        (response) =>
          response.url().includes('/api/config') && response.request().method() === 'PATCH'
      );
      await settingsPage.runtimeMakeDefault(runtime).click();
      expect((await written).ok()).toBe(true);
    };

    await makeDefault(OTHER_RUNTIME);

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
    // Hydrated, not merely painted: the button below only exists on a card the
    // fresh page already knows is NOT the default, so waiting for it here is
    // what stops the click from racing the reloaded tab's first render — which
    // is exactly where the timeout landed.
    await expect(settingsPage.runtimeMakeDefault(DEFAULT_RUNTIME)).toBeVisible();

    // Put it back the same way a person would, which is also the other half of
    // the assertion: the choice moves both ways.
    await makeDefault(DEFAULT_RUNTIME);
    await expect(settingsPage.runtimeDefaultPill(DEFAULT_RUNTIME)).toBeVisible();
    await expect(settingsPage.runtimeDefaultPill(OTHER_RUNTIME)).toBeHidden();
  });

  test('sets the model of a runtime that new conversations do not start on', async ({
    basePage,
    page,
    settingsPage,
  }) => {
    test.skip(
      requirements.runtimes[OTHER_RUNTIME].state !== 'ready',
      `${OTHER_RUNTIME} is not connected on this machine, and model settings require a connected runtime.`
    );

    // The capability hole, precisely: Codex is not the default here, and before
    // this redesign that made its model unreachable.
    await expect(settingsPage.runtimeDefaultPill(OTHER_RUNTIME)).toBeHidden();

    await settingsPage.runtimeCardToggle(OTHER_RUNTIME).click();
    const modelSelect = settingsPage.runtimeModelSelect(OTHER_RUNTIME);
    await expect(modelSelect).toBeVisible();

    // Whatever the pinned catalog offers, not a hardcoded model id: the first
    // option is 'Automatic', so the second is the first real model, and
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
