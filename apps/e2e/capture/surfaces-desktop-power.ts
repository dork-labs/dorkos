import type { Browser, Page } from '@playwright/test';
import { DESKTOP_VIEWPORT, DEVICE_SCALE_FACTOR, type Theme } from './config.js';
import type { RunRecorder } from './library.js';
import {
  attempt,
  isShotSkipped,
  newCaptureContext,
  patch,
  seedThemeOnContext,
  shoot,
  url,
  waitForAppShell,
  WAIT_MS,
} from './lib.js';

/**
 * The power-surface drives: the Control Center flyout, the Settings → Room limits
 * dials behind one of its switches, and the one-time trust notice. Split out
 * of `surfaces-desktop` (which was over the 500-line limit) because these three
 * are one cohesive group — every one of them frames how much agents may do on
 * their own.
 *
 * The two still drives here are called from `captureLightStills`, on its shared
 * themed page; the notice owns its own context, because it needs a cold load.
 *
 * @module capture/surfaces-desktop-power
 */

/**
 * Capture the Control Center flyout open over the cockpit: the global Trust
 * Dial and the power switches.
 *
 * The flyout is opened the way a person opens it — the ⚡ glyph in the top-bar
 * cluster, the anchor present on every route — not by setting the store flag or
 * by mounting `ControlCenterBody` bare.
 *
 * ## The frame is the panel's top, and that is the only frame there is
 *
 * `ResponsivePopoverContent` caps the flyout at `min(70vh, 600px)` and scrolls
 * the rest, while the panel's content runs to roughly 770px. So the whole panel
 * does not fit at ANY viewport height — this is the surface as it exists, not a
 * capture-viewport artifact — and the choice is only which end of it to frame.
 * The top is the right end: the "Power" dial is what the panel is FOR, and the
 * switches under it are what the release notes describe — Remote access first
 * since DOR-1743. The Exceptions ledger sits below the fold, reachable by
 * scroll.
 *
 * **That ledger would read as its calm empty state anyway, deliberately.** Two
 * of its four row sources cannot fire in a capture at all: the task and binding
 * branches resolve their modes against the `claude-code` capability profile
 * (`UNATTENDED_RUNTIME` in `use-overrides-ledger.ts`), and a capture stack boots
 * the test-mode runtimes instead, so no descriptor resolves and every such row
 * is skipped by design. That leaves a per-runtime override or a session parked
 * at a divergent stop — state nothing in the seeded world produces, which a
 * drive would have to manufacture purely for the camera and then unwind, for a
 * row this frame could not show. Shoot a real exception the day a
 * capture-reachable one exists; do not invent one.
 */
export async function shootControlCenter(
  page: Page,
  theme: Theme,
  rec: RunRecorder
): Promise<void> {
  await page.goto(url('/'));
  await waitForAppShell(page);
  await page.getByTestId('control-center-trigger').click({ timeout: WAIT_MS });
  await page.getByTestId('control-center-body').waitFor({ timeout: WAIT_MS });
  // The ledger is the LAST thing in the panel to settle, and it holds a quiet
  // loading line until the config AND the runtime-capability queries have both
  // landed — those two alone, not the sessions/tasks/bindings queries it also
  // reads (`isResolving` in `use-overrides-ledger.ts`). So either terminal
  // state (the calm empty line, or a real row) is the signal that the two
  // queries the dial and the config-backed switches read have resolved. It sits
  // below the fold, so this is a readiness check, not a claim about the frame.
  //
  // One control IN frame is not covered by it. `OpenMeshSwitch` renders
  // `checked={topology?.openMesh ?? false}` with no loading state, off a
  // topology query nothing in this chain touches. Nothing in `seed.ts` turns
  // open mesh on, so the unresolved and resolved paints are identical today and
  // the frame is honest either way — but a seed that ever sets `openMesh: true`
  // could publish that switch in the wrong position with nothing failing. Wait
  // on the topology query the day that changes. (The "Limit automatic replies"
  // switch guards itself: it renders disabled until its limits land. So does
  // the Remote-access row, which holds its switch until the config read has
  // actually answered — the same config this wait already covers.)
  await page
    .locator('[data-testid="overrides-ledger-empty"], [data-testid^="override-row-"]')
    .first()
    .waitFor({ timeout: WAIT_MS });
  await shoot(page, 'control-center', theme, rec);
  // No explicit close: `controlCenterOpen` lives in the app store and is not
  // persisted, so the next surface's `page.goto` reloads the SPA and takes the
  // flyout — and its modal `pointer-events: none` lock — down with it.
}

/**
 * Capture Settings → Room limits: the four reply-limit dials that sit behind the
 * Control Center's "Limit automatic replies" switch.
 *
 * Reached by the `?settings=rooms` deep link — the same URL param the Control
 * Center's own copy points a person at. The wait is on the LAST of the four
 * rows: the panel renders its frame before `useRoomTurnLimits` resolves, and the
 * fourth label is the only proof the whole list has drawn rather than a leading
 * slice of it.
 *
 * The click on the already-selected Room limits tab is not navigation — it is what
 * takes the ACCENT FOCUS RING off the dialog's expand control. Radix autofocuses
 * the first tabbable thing when the dialog opens, and a deep link arrives with
 * nothing else having been clicked, so that ring sits on an unrelated icon
 * button in the corner of the frame and reads as "this is selected". A mouse
 * click moves focus without satisfying `:focus-visible`, so the ring goes and no
 * other appears. The rest of the published set has no such ring for the same
 * reason — `shootCloudLink` happens to click its way in.
 */
export async function shootSettingsRooms(
  page: Page,
  theme: Theme,
  rec: RunRecorder
): Promise<void> {
  await page.goto(url('/team?settings=rooms'));
  const panel = page.getByRole('tabpanel', { name: 'Room limits' });
  await panel.getByText('Replies everywhere each hour', { exact: true }).waitFor({
    timeout: WAIT_MS,
  });
  await page.getByRole('tab', { name: 'Room limits' }).click({ timeout: WAIT_MS });
  await shoot(page, 'settings-rooms', theme, rec);
}

/**
 * The settled notice stamp the seed leaves behind (`settleTrustNotice` in
 * `seed.ts`), restated here because this drive is the one thing that un-settles
 * it and has to put it back byte-for-byte.
 */
const SETTLED_TRUST_NOTICE = {
  trustNoticeSeenAt: '2026-07-01T00:00:00.000Z',
} as const;

/**
 * Capture the one-time trust notice — the modal that says agents now work
 * without asking, shown once to a Trusted install.
 *
 * The seed deliberately marks it seen (`settleTrustNotice`) so it cannot
 * focus-trap itself over any other frame, so this drive is a flip-and-restore in
 * the shape of `captureAgentDiscovery`: mark it unseen, shoot it in its own
 * fresh context, and put the stamp back in a `finally` whatever happened.
 *
 * ## Why a plain cold load is enough here
 *
 * `MomentHost` opens a moment only when the config in hand is one the server
 * confirmed during THIS launch — `dataUpdatedAt > LAUNCH_STARTED_AT`, where the
 * launch stamp is sampled at module evaluation. A fresh `browser.newContext()`
 * carries no warm-boot persister, so its first config fetch resolves after the
 * bundle evaluates and satisfies the gate outright.
 *
 * The notice also needs onboarding SETTLED, which the seed's `dismissedAt`
 * already is, and the install on Trusted, which the capture stack is unless a
 * drive picked Careful (none does). It runs after `captureAgentDiscovery`
 * because a flip-and-restore drive belongs after everything that reads the
 * settled value it restores.
 */
export async function captureTrustNotice(browser: Browser, rec: RunRecorder): Promise<void> {
  // Skip when this shot is not ours — a human override supplies it, or it
  // belongs to another shard. Either way, don't un-settle this stack's notice.
  if (isShotSkipped('trust-notice')) {
    process.stdout.write('  ⤿ trust-notice skipped (captured elsewhere)\n');
    return;
  }
  const unsettleNotice = () => patch('/api/config', { ui: { trustNoticeSeenAt: null } });
  const settleNotice = () => patch('/api/config', { ui: SETTLED_TRUST_NOTICE });

  try {
    await attempt('trust-notice-light', async () => {
      await unsettleNotice();
      const ctx = await newCaptureContext(browser, {
        viewport: DESKTOP_VIEWPORT,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        reducedMotion: 'reduce',
      });
      await seedThemeOnContext(ctx, 'light');
      try {
        const page = await ctx.newPage();
        await page.goto(url('/'));
        // The title carries the anchor; the answer button after it is
        // belt-and-braces, since the dialog renders in one synchronous pass.
        await page.getByTestId('trust-notice').waitFor({ timeout: WAIT_MS });
        await page.getByRole('button', { name: 'Got it' }).waitFor({ timeout: WAIT_MS });
        await shoot(page, 'trust-notice', 'light', rec);
      } finally {
        await ctx.close();
      }
    });
  } finally {
    // Guarded, unlike `captureAgentDiscovery`'s equivalent restore. That one
    // shuts an onboarding wizard this drive would otherwise load `/` straight
    // into, so swallowing its failure would silently corrupt this shot — it has
    // a reader, and must stay loud. Here nothing reads what is being put back:
    // this is the last drive of the run, and the next run's
    // `prepareFilesystem()` wipes the capture home outright.
    // Unguarded, a restore that throws (a 403 from the `auth.enabled` class
    // `seed.ts` documents) would escape `driveCaptures` into `runSerialRecord`,
    // skipping `rec.finalize()` — and in a SHARDED run that failure deletes the
    // whole run dir, discarding every other shard's finished raws. Log the `✗`
    // and let the run land.
    await attempt('trust-notice restore', settleNotice);
  }
}
