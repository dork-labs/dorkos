import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';

/**
 * The full-power consent door (spec `full-power-defaults` D3, DOR-1431) — the
 * A1-critical guard, asserted on CONFIG/API state rather than layout.
 *
 * Covers the two answers that matter:
 *   1. ACCEPT ("Unlock full power") lands full power atomically — the server
 *      config gains `runtimes.defaultTrustStop: 'autonomy'` WITH a recorded
 *      `ui.autonomyAcknowledgedAt` (the ack the 428 gate demands, in the same
 *      write) and `ui.fullPowerChoice: 'full'`, and the mesh opens
 *      (`openMesh: true`). With Require login off — this leg's default — standing
 *      grants stay off, because the server refuses that login-gated path; the
 *      door omits it rather than 403 the whole write. The door does not return on
 *      reload.
 *   2. DECLINE ("Keep asking me first") records `ui.fullPowerChoice: 'supervised'`
 *      and touches NOTHING consent-gated: no autonomy stop, no ack, no standing
 *      grants, no open mesh. It does not return on reload.
 *
 * ## It RUNS in CI (no skip gate), and why it is `serial` + warm-boot
 *
 * This is the guard for the headline consent surface, so it must actually execute
 * in the sharded suite — never a `test.skip` on a CI-unset env var, which
 * `scripts/assert-browser-tests-executed.sh` fails as "collected but every one of
 * their tests was skipped". Two properties of the moments rail (spec
 * `full-power-defaults` D3, task 1.2) shape how it does that.
 *
 * **It must not ambush other specs.** The door is a launch MODAL that focus-traps
 * and sets `pointer-events: none`, eligible whenever onboarding is settled and
 * `ui.fullPowerDecidedAt` is null. `global-setup.ts` settles a "supervised"
 * decision on every leg, so the suite's steady state never shows it. This spec
 * un-settles it only inside its own `beforeEach` and restores it in `afterAll`;
 * combined with CI's `workers: 1` (specs run serially per shard) and the
 * `isFetchedAfterMount` gate below (a normal load by another spec never opens the
 * door), nothing else on the leg is ambushed.
 *
 * **A moment opens only after a server-confirmed config fetch completes AFTER
 * `MomentHost` mounts** (`MomentHost`'s `isFetchedAfterMount` gate, which exists
 * so a moment never opens off an unconfirmed warm-boot cache). A cold automated
 * page that loads once and idles never produces that post-mount fetch — config is
 * fetched once and stays fresh inside its 30s `staleTime` — so the door never
 * opens for it, however correct the config is. A real returning user hits it via
 * the warm boot: the persister restores a now-stale config and `refetchOnMount`
 * fires the confirming refetch. The `beforeEach` reproduces exactly that — load
 * to prime the persister, let the config go stale, reload — with the boot cache
 * LEFT ON (the suite's default `storageState` disables it), which is why it waits
 * out the stale window and each test runs on a raised timeout.
 */

/** Config staleTime is 30s; wait past it so the warm reload refetches. */
const STALE_WINDOW_MS = 31_000;
/** Room for the two loads plus the stale window and the assertions. */
const TEST_TIMEOUT_MS = 120_000;
/** The confirming refetch can lag the shell under a dual-leg boot. */
const DOOR_TIMEOUT_MS = 20_000;

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
 * `GET /api/config` is a DERIVED view, not the stored `config.json`: `runtimes`
 * comes back as the list of available runtime names, and the global trust stop is
 * surfaced as `executionDefaults.trustStop` (what the dial renders from) — NOT
 * `runtimes.defaultTrustStop`, which does not exist in this shape. Reading the
 * stored path here returns undefined and silently fails the autonomy assertion
 * even though the write landed (verified against the on-disk config).
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

/** Clear the decision and everything consent-gated, and close the mesh. */
async function resetToUnanswered(request: APIRequestContext): Promise<void> {
  const config = await request.patch('/api/config', {
    data: {
      ui: { fullPowerDecidedAt: null, fullPowerChoice: null, autonomyAcknowledgedAt: null },
      runtimes: { defaultTrustStop: null },
    },
  });
  expect(config.ok()).toBe(true);
  const mesh = await request.put('/api/mesh/topology/access', {
    data: { sourceNamespace: '*', targetNamespace: '*', action: 'deny' },
  });
  expect(mesh.ok()).toBe(true);
  // The door's whole eligibility hinges on this being null — fail HERE with a
  // clear cause if a write was silently dropped, not later as "door never came".
  expect((await readPowerConfig(request)).fullPowerDecidedAt).toBeNull();
}

test.describe('Full-power consent door @full-power', () => {
  test.describe.configure({ mode: 'serial' });
  // Leave the boot cache ON so the warm reload can refetch — the suite's default
  // storageState disables it, and without the persister there is no restore to
  // trigger the confirming fetch the moment gate waits for.
  test.use({ storageState: { cookies: [], origins: [] } });

  // Bring the door up the way a returning user does: prime the persister, let
  // config go stale, then reload so `refetchOnMount` fires the server-confirmed
  // fetch that flips `isFetchedAfterMount` and opens the moment.
  test.beforeEach(async ({ request, basePage }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await resetToUnanswered(request);
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.page.waitForTimeout(STALE_WINDOW_MS);
    await basePage.page.reload();
    await basePage.waitForAppReady();
    await expect(basePage.page.getByTestId('full-power-door')).toBeVisible({
      timeout: DOOR_TIMEOUT_MS,
    });
  });

  test.afterAll(async ({ request }) => {
    // Self-heal to the settled, safe state global-setup leaves behind.
    await request.patch('/api/config', {
      data: {
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
  });

  test('ACCEPT lands full power atomically and the door does not return', async ({
    request,
    basePage,
  }) => {
    const { page } = basePage;

    await page.getByRole('button', { name: 'Unlock full power' }).click();
    // The door closes only after both writes settle, so its absence is the
    // signal the config + mesh calls are done.
    await expect(page.getByTestId('full-power-door')).toBeHidden();

    const config = await readPowerConfig(request);
    expect(config.defaultTrustStop).toBe('autonomy');
    expect(config.autonomyAcknowledgedAt).not.toBeNull();
    expect(config.fullPowerChoice).toBe('full');
    // Login off on this leg → standing grants (a login-gated path) is omitted,
    // never a 403 of the whole atomic write.
    expect(config.standingGrants).toBe(false);
    expect(await readMeshOpen(request)).toBe(true);

    // A plain reload (boot cache warm, config fresh) must NOT reopen it: the
    // decision is recorded, so the moment is ineligible.
    await basePage.goto();
    await basePage.waitForAppReady();
    await page.waitForTimeout(2000);
    await expect(page.getByTestId('full-power-door')).toHaveCount(0);
    expect((await readPowerConfig(request)).fullPowerDecidedAt).not.toBeNull();
  });

  test('DECLINE records supervised, touches nothing consent-gated, and does not return', async ({
    request,
    basePage,
  }) => {
    const { page } = basePage;

    await page.getByRole('button', { name: 'Keep asking me first' }).click();
    await expect(page.getByTestId('full-power-door')).toBeHidden();

    const config = await readPowerConfig(request);
    expect(config.fullPowerChoice).toBe('supervised');
    expect(config.fullPowerDecidedAt).not.toBeNull();
    expect(config.defaultTrustStop).toBeNull();
    expect(config.autonomyAcknowledgedAt).toBeNull();
    expect(config.standingGrants).toBe(false);
    expect(await readMeshOpen(request)).toBe(false);

    await basePage.goto();
    await basePage.waitForAppReady();
    await page.waitForTimeout(2000);
    await expect(page.getByTestId('full-power-door')).toHaveCount(0);
  });
});
