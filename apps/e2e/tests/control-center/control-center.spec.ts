import { test, expect } from '../../fixtures';
import type { APIRequestContext } from '@playwright/test';

/**
 * The Control Center flyout (spec `full-power-defaults`, D7) — the three things
 * a real browser proves that no unit test can:
 *
 * 1. the ⚡ glyph opens the flyout and focus lands somewhere sane, not trapped
 *    mid-open on a toggle switch (this repo has a recorded Radix focus race,
 *    DOR-953, where a popover's own open would blur-cancel what it just opened);
 * 2. a power switch's write travels the whole round trip — click → `PATCH
 *    /api/config` → the value on disk changes;
 * 3. an overrides-ledger row deep-links to the surface that owns it, asserted on
 *    the navigation TARGET rather than any layout (the DOR-953 lesson: never
 *    depend on ambient chrome or pixel geometry).
 *
 * SERIAL, and it has to be: the switch test moves a config key global to the
 * server the whole suite shares. The `afterEach` restores it however the test
 * ended, reading first so a red run is only a red run (DOR-1223).
 *
 * No moment ambushes this: `global-setup` seeds `telemetry.userHasDecided: true`
 * (and onboarding dismissed), which is the only moment registered on the rail, so
 * the cockpit settles straight to the shell.
 */
test.describe.configure({ mode: 'serial' });

/** The curated config this file reads — the same block the warm-agents switch renders from. */
interface ConfigView {
  claudeCode?: { persistentSession?: boolean };
  tunnel?: { tokenConfigured?: boolean };
}

/** Read the one config value the switch test moves. */
async function readConfig(request: APIRequestContext): Promise<ConfigView> {
  const response = await request.get('/api/config');
  expect(response.ok()).toBe(true);
  return (await response.json()) as ConfigView;
}

test.describe('Control Center @smoke', () => {
  // Captured before anything moves, so the restore puts back what this machine
  // HAD rather than a schema constant (DOR-1223).
  let priorPersistent: boolean;

  test.beforeAll(async ({ request }) => {
    priorPersistent = (await readConfig(request)).claudeCode?.persistentSession ?? true;
  });

  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  // Put back warm agents if a test moved it, and only if it actually differs.
  test.afterEach(async ({ request }) => {
    const config = await readConfig(request);
    if ((config.claudeCode?.persistentSession ?? true) === priorPersistent) return;
    const restored = await request.patch('/api/config', {
      data: { runtimes: { claudeCode: { persistentSession: priorPersistent } } },
    });
    expect(restored.ok()).toBe(true);
  });

  test('the ⚡ glyph opens the flyout with sane focus', async ({ controlCenter, page }) => {
    await controlCenter.open();

    // Still open a beat later — the focus race would have blur-cancelled it.
    await expect(controlCenter.body).toBeVisible();

    // Focus is NOT trapped on a toggle switch mid-open: arrowing or a stray
    // space must not silently flip a power setting the moment the flyout appears.
    await expect(page.locator('[role="switch"]:focus')).toHaveCount(0);

    // It landed on the dial's selected stop — the first control in the flyout,
    // inside the modal's focus scope, exactly where a keyboard user should
    // resume. (The trigger is aria-hidden while the modal is open, which is the
    // flip side of the same fact: focus is in the panel, not behind it.)
    await expect(page.getByRole('radio', { name: 'Ask first' })).toBeFocused();
  });

  test('a power switch writes its config patch', async ({ controlCenter, page, request }) => {
    const before = (await readConfig(request)).claudeCode?.persistentSession ?? true;

    await controlCenter.open();

    // Assert the WRITE, not a repaint: a switch that only flipped its cache would
    // look identical here.
    const patched = page.waitForResponse(
      (response) =>
        response.url().includes('/api/config') && response.request().method() === 'PATCH'
    );
    await controlCenter.warmAgentsSwitch.click();
    expect((await patched).ok()).toBe(true);

    // The value on disk moved, which is the whole round trip through Express and
    // config.json — not just the optimistic cache.
    await expect
      .poll(async () => (await readConfig(request)).claudeCode?.persistentSession)
      .toBe(!before);
  });

  test('the Remote-access row hands off to its dialog, through the modal lock', async ({
    controlCenter,
    page,
    request,
  }) => {
    // With no ngrok token the row's switch does not flip — it opens the Remote
    // Access dialog for the one-time setup (DOR-1743). Every leg boots on a
    // throwaway DORK_HOME, so that is the state here; if a token leaked in from
    // the environment the row would try to START a tunnel, which is not
    // something a browser test should do.
    const tokenConfigured = (await readConfig(request)).tunnel?.tokenConfigured ?? false;
    test.skip(tokenConfigured, 'an ngrok token is configured; the row would start a real tunnel');

    await controlCenter.open();
    await expect(controlCenter.remoteAccessSwitch).toBeVisible();

    await controlCenter.remoteAccessSwitch.click();

    // The dialog is actually THERE, and it is the one it promised.
    const dialog = page.getByRole('dialog').filter({ hasText: 'Remote Access' });
    await expect(dialog).toBeVisible();

    // The flyout closed on the way. Both are modal popovers, so leaving the
    // first open would stack two `pointer-events: none` locks and hand the
    // person a dialog they cannot type into — the hazard `createModalHandoff`
    // exists for, and the reason the overrides ledger below asserts the same
    // thing on its own path.
    await expect(controlCenter.body).toBeHidden();

    // Focus is inside the dialog, not stranded on the flyout that closed under
    // it — the DOR-953 focus race, one surface over.
    await expect(dialog).toContainText('Remote Access');
    const focusInDialog = await dialog.evaluate((node) => node.contains(document.activeElement));
    expect(focusInDialog).toBe(true);
  });

  test('an overrides row deep-links to its owning surface', async ({
    controlCenter,
    basePage,
    page,
    tasksApi,
  }) => {
    // Seed exactly one exception the ledger can resolve from the client's own
    // capability map: a scheduled task. Created with no permission mode, it takes
    // the operator's default — `acceptEdits` on a fresh leg — whose stop (Act)
    // differs from the global Ask, so it lands in the ledger as a divergent row.
    // (The `never-fires` cron means it renders without ever spawning an agent.)
    await tasksApi.createTask('cc-ledger-probe');
    await basePage.goto();
    await basePage.waitForAppReady();

    await controlCenter.open();
    const row = controlCenter.overrideRow('task');
    await expect(row).toBeVisible();
    await row.click();

    // The row opens the Tasks surface — asserted on the navigation target, the
    // one thing that is true regardless of chrome or geometry.
    await expect(page).toHaveURL(/\/tasks/);

    // And the flyout closed on the way out, so the destination is actually
    // reachable. The flyout is a MODAL popover: left open, it would hold the page
    // behind `body { pointer-events: none }` and land us on an inert screen — the
    // whole point of the ledger is to REACH the surface, not to look at it.
    await expect(controlCenter.body).toBeHidden();

    // `/tasks` is a route (a page, not a modal), so the modal lock must be gone.
    const bodyPointerEvents = await page.evaluate(
      () => getComputedStyle(document.body).pointerEvents
    );
    expect(bodyPointerEvents).not.toBe('none');

    // Proof the page is genuinely interactive, using chrome we own: the glyph
    // takes a real click and reopens the flyout. A stale flyout overlay left on
    // top would obscure the glyph and this click would time out.
    await controlCenter.trigger.click();
    await expect(controlCenter.body).toBeVisible();
  });
});
