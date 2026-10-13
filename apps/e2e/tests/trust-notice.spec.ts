import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';

/**
 * The one-time trust notice (spec `trusted-by-default-flip` §5.8, DOR-2739),
 * asserted on config and permission state rather than layout.
 *
 * Each test starts from the state the upgrade migration leaves an install it
 * moved to Trusted: `permissions.preset: 'trusted'` and `ui.trustNoticeSeenAt`
 * null. The retired door fields cannot be written any more, so "pre-flip" is
 * seeded as what the migration turns it into.
 *
 *   1. **Got it** stamps `ui.trustNoticeSeenAt`, leaves the install Trusted,
 *      and the notice does not return on reload.
 *   2. **Keep asking me** lands on Careful (whose Files & commands stop is Ask
 *      first), stamps the notice, and it does not return either.
 *
 * ## It runs in CI, serially
 *
 * The notice is a launch MODAL on the moments rail that focus-traps the app.
 * `global-setup.ts` stamps it seen on every leg so no other spec meets it; this
 * spec un-stamps it only inside its own `beforeEach` and puts the settled state
 * back in `afterAll`. With CI's one worker per shard, nothing else on the leg
 * is ambushed.
 *
 * ## Why one plain load is enough
 *
 * `MomentHost` opens a moment only off a config the server confirmed during
 * THIS launch (`dataUpdatedAt > LAUNCH_STARTED_AT`). The suite's default
 * `storageState` turns the boot cache off, so the first config fetch after a
 * cold load satisfies that outright; no stale-window reload is needed.
 */

/** The confirming fetch can lag the shell under a dual-leg boot. */
const NOTICE_TIMEOUT_MS = 20_000;

/** The slice of state this spec asserts on. */
interface TrustView {
  seenAt: string | null;
  trustStop: string | null;
  preset: string | null;
}

/**
 * Read the notice stamp, the global Files & commands stop and the preset.
 *
 * `GET /api/config` is a derived view: the global stop comes back as
 * `executionDefaults.trustStop`, not `runtimes.defaultTrustStop`.
 */
async function readTrust(request: APIRequestContext): Promise<TrustView> {
  const configRes = await request.get('/api/config');
  expect(configRes.ok()).toBe(true);
  const config = (await configRes.json()) as {
    ui?: { trustNoticeSeenAt?: string | null };
    executionDefaults?: { trustStop?: string | null };
  };
  const permissionsRes = await request.get('/api/permissions');
  expect(permissionsRes.ok()).toBe(true);
  const permissions = (await permissionsRes.json()) as { preset?: string | null };
  return {
    seenAt: config.ui?.trustNoticeSeenAt ?? null,
    trustStop: config.executionDefaults?.trustStop ?? null,
    preset: permissions.preset ?? null,
  };
}

/** Seed the state the migration leaves a Trusted install in: notice unseen. */
async function seedUpgradedInstall(request: APIRequestContext): Promise<void> {
  const preset = await request.put('/api/permissions/preset', {
    data: { preset: 'trusted', surface: 'api' },
  });
  expect(preset.ok()).toBe(true);
  const config = await request.patch('/api/config', {
    data: { ui: { trustNoticeSeenAt: null } },
  });
  expect(config.ok()).toBe(true);
  // The notice's eligibility hinges on these two. Fail HERE with a clear cause
  // if a write was dropped, not later as "the notice never came".
  const view = await readTrust(request);
  expect(view.seenAt).toBeNull();
  expect(view.preset).toBe('trusted');
}

test.describe('Trust notice @trust-notice', () => {
  test.describe.configure({ mode: 'serial' });

  /** The stop `global-setup.ts` left, put back afterwards. */
  let priorStop: string | null = null;

  test.beforeAll(async ({ playwright }, testInfo) => {
    const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    priorStop = (await readTrust(request)).trustStop;
    await request.dispose();
  });

  test.beforeEach(async ({ request, basePage }) => {
    await seedUpgradedInstall(request);
    await basePage.goto();
    await basePage.waitForAppReady();
    await expect(basePage.page.getByTestId('trust-notice')).toBeVisible({
      timeout: NOTICE_TIMEOUT_MS,
    });
  });

  test.afterAll(async ({ playwright }, testInfo) => {
    // Back to the settled state global-setup leaves: Trusted, notice seen,
    // and the stop it chose.
    const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    await request.put('/api/permissions/preset', {
      data: { preset: 'trusted', surface: 'api' },
    });
    await request.patch('/api/config', {
      data: {
        ui: { trustNoticeSeenAt: new Date().toISOString() },
        runtimes: { defaultTrustStop: priorStop },
      },
    });
    await request.dispose();
  });

  test('Got it marks the notice seen, keeps Trusted, and it does not return', async ({
    request,
    basePage,
  }) => {
    const { page } = basePage;

    await page.getByRole('button', { name: 'Got it' }).click();
    // The notice closes only after the write settles.
    await expect(page.getByTestId('trust-notice')).toBeHidden();

    const view = await readTrust(request);
    expect(view.seenAt).not.toBeNull();
    expect(view.preset).toBe('trusted');

    await basePage.goto();
    await basePage.waitForAppReady();
    await page.waitForTimeout(2000);
    await expect(page.getByTestId('trust-notice')).toHaveCount(0);
  });

  test('Keep asking me lands on Careful, and the notice does not return', async ({
    request,
    basePage,
  }) => {
    const { page } = basePage;

    await page.getByRole('button', { name: 'Keep asking me' }).click();
    await expect(page.getByTestId('trust-notice')).toBeHidden();

    const view = await readTrust(request);
    expect(view.preset).toBe('careful');
    // Careful sets Files & commands to Ask first.
    expect(view.trustStop).toBe('ask');
    expect(view.seenAt).not.toBeNull();

    await basePage.goto();
    await basePage.waitForAppReady();
    await page.waitForTimeout(2000);
    await expect(page.getByTestId('trust-notice')).toHaveCount(0);
  });
});
