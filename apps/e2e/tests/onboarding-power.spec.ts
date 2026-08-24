import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';

/**
 * The onboarding power stage (spec `full-power-defaults` D3, task 3.1) — new
 * users meet the full-power consent door once, as a dedicated stage between the
 * requirements screen and the DorkBot conversation. It hosts the SAME
 * {@link FullPowerDoor} the moments rail shows existing users, so this asserts on
 * CONFIG/API state (the writes the door owns) plus the stage rendering, not on
 * layout.
 *
 * Covers:
 *   1. the stage RENDERS the door in the onboarding frame (the `beforeEach` gate);
 *   2. ACCEPT ("Unlock full power") lands full power atomically and PERSISTS
 *      across a reload — the server config gains `defaultTrustStop: 'autonomy'`
 *      with a recorded `autonomyAcknowledgedAt` and `fullPowerChoice: 'full'`,
 *      and the mesh opens; a reload does not undo any of it;
 *   3. DECLINE ("Keep asking me first") records `fullPowerChoice: 'supervised'`,
 *      touches nothing consent-gated, and PERSISTS across a reload.
 *
 * ## It RUNS in CI (no skip gate), and how it stays out of other specs' way
 *
 * This must actually execute in the sharded suite — never a `test.skip` on a
 * CI-unset env var, which `scripts/assert-browser-tests-executed.sh` fails as
 * "collected but every one of their tests was skipped".
 *
 * The onboarding overlay renders INSTEAD of the app shell whenever onboarding is
 * un-settled, so leaving it un-settled would ambush every other spec's
 * `waitForAppReady`. Two things keep that from happening. This suite runs
 * `workers: 1` in CI (specs are serial per shard), and — belt and braces for a
 * local parallel run — the `beforeEach` RE-SETTLES onboarding the moment the door
 * is on screen: the overlay is latched open for THIS page
 * (`useOnboardingOverlayVisible`), so it survives the re-settle, while any other
 * page that loads now reads settled config and gets the app shell. The window in
 * which onboarding is globally un-settled is thus about one page load, not a whole
 * test. `afterEach` restores the suite's safe steady state (a settled
 * "supervised" decision, mesh closed) so nothing this spec turns on leaks past it.
 */

/** The consent-relevant slice of `GET /api/config` this spec asserts on. */
interface PowerConfigView {
  defaultTrustStop: string | null;
  autonomyAcknowledgedAt: string | null;
  fullPowerDecidedAt: string | null;
  fullPowerChoice: string | null;
  standingGrants: boolean;
}

/**
 * Read the consent-relevant config fields through the leg's proxy.
 *
 * `GET /api/config` is a DERIVED view: the global trust stop is surfaced as
 * `executionDefaults.trustStop` (what the dial renders from), NOT the stored
 * `runtimes.defaultTrustStop`. Reading the stored path returns undefined and
 * silently fails the autonomy assertion even though the write landed.
 *
 * @param request - A request context bound to the leg's base URL.
 */
async function readPowerConfig(request: APIRequestContext): Promise<PowerConfigView> {
  const response = await request.get('/api/config');
  expect(response.ok()).toBe(true);
  const config = (await response.json()) as {
    ui?: {
      autonomyAcknowledgedAt?: string | null;
      fullPowerDecidedAt?: string | null;
      fullPowerChoice?: string | null;
    };
    executionDefaults?: { trustStop?: string | null };
    approvals?: { standingGrants?: boolean };
  };
  return {
    defaultTrustStop: config.executionDefaults?.trustStop ?? null,
    autonomyAcknowledgedAt: config.ui?.autonomyAcknowledgedAt ?? null,
    fullPowerDecidedAt: config.ui?.fullPowerDecidedAt ?? null,
    fullPowerChoice: config.ui?.fullPowerChoice ?? null,
    standingGrants: config.approvals?.standingGrants ?? false,
  };
}

/** Whether the mesh is open (`* -> * allow`). */
async function readMeshOpen(request: APIRequestContext): Promise<boolean> {
  const response = await request.get('/api/mesh/topology');
  expect(response.ok()).toBe(true);
  const topology = (await response.json()) as { openMesh?: boolean };
  return topology.openMesh === true;
}

/** Un-settle onboarding AND the power decision so the overlay renders the stage. */
async function unsettleOnboardingAndPower(request: APIRequestContext): Promise<void> {
  const config = await request.patch('/api/config', {
    data: {
      onboarding: {
        completedAt: null,
        dismissedAt: null,
        startedAt: null,
        completedSteps: [],
        skippedSteps: [],
      },
      ui: { fullPowerDecidedAt: null, fullPowerChoice: null, autonomyAcknowledgedAt: null },
      runtimes: { defaultTrustStop: null },
    },
  });
  expect(config.ok()).toBe(true);
  const mesh = await request.put('/api/mesh/topology/access', {
    data: { sourceNamespace: '*', targetNamespace: '*', action: 'deny' },
  });
  expect(mesh.ok()).toBe(true);
  // The stage's whole eligibility hinges on this being null — fail HERE with a
  // clear cause if a write was dropped, not later as "the door never rendered".
  expect((await readPowerConfig(request)).fullPowerDecidedAt).toBeNull();
}

/** Re-settle onboarding so other pages get the app shell; the overlay is latched here. */
async function settleOnboardingOnly(request: APIRequestContext): Promise<void> {
  const res = await request.patch('/api/config', {
    data: { onboarding: { dismissedAt: new Date().toISOString() } },
  });
  expect(res.ok()).toBe(true);
}

/** Restore the suite's safe steady state (a settled "supervised" decision, mesh closed). */
async function healToSafeState(request: APIRequestContext): Promise<void> {
  await request.patch('/api/config', {
    data: {
      onboarding: { dismissedAt: new Date().toISOString() },
      ui: {
        fullPowerDecidedAt: new Date().toISOString(),
        fullPowerChoice: 'supervised',
        autonomyAcknowledgedAt: null,
      },
      runtimes: { defaultTrustStop: null },
    },
  });
  await request.put('/api/mesh/topology/access', {
    data: { sourceNamespace: '*', targetNamespace: '*', action: 'deny' },
  });
}

/** The door within the onboarding overlay. */
function door(page: Page) {
  return page.getByTestId('full-power-door');
}

test.describe('Onboarding power stage @full-power', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ request, basePage }) => {
    await unsettleOnboardingAndPower(request);
    // Land directly on the power stage — the param is URL-synced and refresh-safe.
    await basePage.goto('/?onboarding=power');
    // The overlay renders INSTEAD of the app shell, so wait on the door itself,
    // not `waitForAppReady`. The onboarding voice heading proves it is the stage
    // host (the modal host uses "DorkOS runs at full power").
    await expect(door(basePage.page)).toBeVisible({ timeout: 20_000 });
    await expect(basePage.page.getByText('Choose your power level')).toBeVisible();
    // Now that this page's overlay is latched open, re-settle onboarding so a
    // parallel page load elsewhere is not ambushed.
    await settleOnboardingOnly(request);
  });

  test.afterEach(async ({ request }) => {
    await healToSafeState(request);
  });

  test('ACCEPT lands full power atomically and persists across a reload', async ({
    request,
    basePage,
  }) => {
    const { page } = basePage;

    await page.getByRole('button', { name: 'Unlock full power' }).click();
    // Answering advances into the conversation, so the door leaves the screen
    // once both writes settle.
    await expect(door(page)).toBeHidden();

    const config = await readPowerConfig(request);
    expect(config.defaultTrustStop).toBe('autonomy');
    expect(config.autonomyAcknowledgedAt).not.toBeNull();
    expect(config.fullPowerChoice).toBe('full');
    // Login off on this leg → standing grants (a login-gated path) stays off.
    expect(config.standingGrants).toBe(false);
    expect(await readMeshOpen(request)).toBe(true);

    // The choice survives a reload: nothing is undone and the decision sticks.
    await page.reload();
    await basePage.waitForAppReady();
    const afterReload = await readPowerConfig(request);
    expect(afterReload.fullPowerChoice).toBe('full');
    expect(afterReload.defaultTrustStop).toBe('autonomy');
    expect(afterReload.fullPowerDecidedAt).not.toBeNull();
  });

  test('DECLINE records supervised, touches nothing consent-gated, and persists across a reload', async ({
    request,
    basePage,
  }) => {
    const { page } = basePage;

    await page.getByRole('button', { name: 'Keep asking me first' }).click();
    await expect(door(page)).toBeHidden();

    const config = await readPowerConfig(request);
    expect(config.fullPowerChoice).toBe('supervised');
    expect(config.fullPowerDecidedAt).not.toBeNull();
    expect(config.defaultTrustStop).toBeNull();
    expect(config.autonomyAcknowledgedAt).toBeNull();
    expect(config.standingGrants).toBe(false);
    expect(await readMeshOpen(request)).toBe(false);

    await page.reload();
    await basePage.waitForAppReady();
    const afterReload = await readPowerConfig(request);
    expect(afterReload.fullPowerChoice).toBe('supervised');
    expect(afterReload.defaultTrustStop).toBeNull();
    expect(afterReload.fullPowerDecidedAt).not.toBeNull();
  });

  test('DECIDE LATER writes no consent field and advances', async ({ request, basePage }) => {
    const { page } = basePage;

    await page.getByTestId('onboarding-power-decide-later').click();
    // Deciding later advances into the conversation, so the door leaves the screen.
    await expect(door(page)).toBeHidden();

    // The authoritative "answered" signal stays null — a skip records flow
    // progress (`onboarding.skippedSteps`), never a consent field.
    const config = await readPowerConfig(request);
    expect(config.fullPowerDecidedAt).toBeNull();
    expect(config.fullPowerChoice).toBeNull();
    expect(config.defaultTrustStop).toBeNull();
    expect(config.autonomyAcknowledgedAt).toBeNull();
    expect(await readMeshOpen(request)).toBe(false);
  });
});
