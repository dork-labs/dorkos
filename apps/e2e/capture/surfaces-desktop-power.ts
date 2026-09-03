import type { Browser, Page } from '@playwright/test';
import { DESKTOP_VIEWPORT, DEVICE_SCALE_FACTOR, type Theme } from './config.js';
import type { RunRecorder } from './library.js';
import {
  attempt,
  isShotSkipped,
  patch,
  seedThemeOnContext,
  shoot,
  url,
  waitForAppShell,
  WAIT_MS,
} from './lib.js';

/**
 * The power-surface drives: the Control Center flyout, the Settings → Rooms
 * dials behind one of its switches, and the one-time full-power consent door.
 * Split out of `surfaces-desktop` (which was over the 500-line limit) because
 * these three are one cohesive group — every one of them frames a power
 * control, and the door drive un-answers and restores the very decision the
 * Control Center's dial displays.
 *
 * The two still drives here are called from `captureLightStills`, on its shared
 * themed page; the door owns its own context, because it needs a cold load.
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
 * four switches under it are what the release notes describe. The Exceptions
 * ledger sits below the fold, reachable by scroll.
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
  // switch guards itself: it renders disabled until its limits land.)
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
 * Capture Settings → Rooms: the four reply-limit dials that sit behind the
 * Control Center's "Limit automatic replies" switch.
 *
 * Reached by the `?settings=rooms` deep link — the same URL param the Control
 * Center's own copy points a person at. The wait is on the LAST of the four
 * rows: the panel renders its frame before `useRoomTurnLimits` resolves, and the
 * fourth label is the only proof the whole list has drawn rather than a leading
 * slice of it.
 *
 * The click on the already-selected Rooms tab is not navigation — it is what
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
  const panel = page.getByRole('tabpanel', { name: 'Rooms' });
  await panel.getByText('Replies everywhere each hour', { exact: true }).waitFor({
    timeout: WAIT_MS,
  });
  await page.getByRole('tab', { name: 'Rooms' }).click({ timeout: WAIT_MS });
  await shoot(page, 'settings-rooms', theme, rec);
}

/**
 * The settled power decision the seed leaves behind (`settleFullPowerDoor` in
 * `seed.ts`), restated here because this drive is the one thing that un-settles
 * it and has to put it back byte-for-byte.
 */
const SETTLED_POWER_DECISION = {
  fullPowerDecidedAt: '2026-07-01T00:00:00.000Z',
  fullPowerChoice: 'supervised',
} as const;

/**
 * Capture the one-time full-power consent door — the modal that asks the power
 * question once and never again.
 *
 * The seed deliberately pre-answers it (`settleFullPowerDoor`) so it cannot
 * focus-trap itself over any other frame, so this drive is a flip-and-restore in
 * the shape of `captureAgentDiscovery`: un-answer the decision, shoot the door
 * in its own fresh context, and put the settled answer back in a `finally`
 * whatever happened.
 *
 * ## Why a plain cold load is enough here
 *
 * `MomentHost` opens a moment only when the config in hand is one the server
 * confirmed during THIS launch — `dataUpdatedAt > LAUNCH_STARTED_AT`, where the
 * launch stamp is sampled at module evaluation. A fresh `browser.newContext()`
 * carries no warm-boot persister, so its first config fetch resolves after the
 * bundle evaluates and satisfies the gate outright. That is why this drive does
 * NOT need the two-load, wait-out-the-30s-stale-window dance in
 * `tests/full-power-door.spec.ts`: that spec runs with the boot cache left ON to
 * reproduce a returning user, and the stale window is the price of the warm
 * restore it is deliberately exercising. (Its docblock still describes the older
 * `isFetchedAfterMount` gate, which a cold load genuinely could not satisfy; the
 * timestamp gate that replaced it can.)
 *
 * The door also needs onboarding SETTLED, which the seed's `dismissedAt` already
 * is — and it runs after `captureAgentDiscovery` because a flip-and-restore
 * drive belongs after everything that reads the settled value it restores.
 */
export async function captureFullPowerDoor(browser: Browser, rec: RunRecorder): Promise<void> {
  // Skip when this shot is not ours — a human override supplies it, or it
  // belongs to another shard. Either way, don't un-answer this stack's decision.
  if (isShotSkipped('full-power-door')) {
    process.stdout.write('  ⤿ full-power-door skipped (captured elsewhere)\n');
    return;
  }
  const unanswerPowerDecision = () =>
    patch('/api/config', { ui: { fullPowerDecidedAt: null, fullPowerChoice: null } });
  const settlePowerDecision = () => patch('/api/config', { ui: SETTLED_POWER_DECISION });

  try {
    await attempt('full-power-door-light', async () => {
      await unanswerPowerDecision();
      const ctx = await browser.newContext({
        viewport: DESKTOP_VIEWPORT,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        reducedMotion: 'reduce',
      });
      await seedThemeOnContext(ctx, 'light');
      try {
        const page = await ctx.newPage();
        await page.goto(url('/'));
        // `full-power-door` is the right anchor because it sits ONLY on the
        // question branch's title, never on the "Full power is on / one thing
        // didn't finish" variant — so it cannot resolve on the error shape.
        // The decision button after it is belt-and-braces: the dialog renders
        // in one synchronous pass (no Suspense, no progressive mount), so it
        // proves nothing the first wait didn't.
        await page.getByTestId('full-power-door').waitFor({ timeout: WAIT_MS });
        await page.getByRole('button', { name: 'Unlock full power' }).waitFor({ timeout: WAIT_MS });
        await shoot(page, 'full-power-door', 'light', rec);
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
    await attempt('full-power-door restore', settlePowerDecision);
  }
}
