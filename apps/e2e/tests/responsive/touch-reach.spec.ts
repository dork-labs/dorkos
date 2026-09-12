import type { Locator } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { openInCanvasBrowser, startDevServer } from '../../pages/canvas-dev-server';
import { borderHeight, touchHeight } from '../../pages/touch-reach';
import type { Server } from 'node:http';

/**
 * Invisible touch reach, on the three surfaces that shipped it broken (DOR-1816).
 *
 * Batch 07 of the UI/UX audit (DOR-1753, PR #1530) grew the hit area of three
 * controls that a thumb could not reliably land on, and every one of the three
 * defects it found was a defect **a class-string assertion could not see**:
 *
 * - the terminal and canvas tab close buttons carried `after:-inset-y-2` and
 *   nothing else, and an absolutely positioned empty `::after` with only
 *   `top`/`bottom` set shrink-wraps to **zero width** — so the reach existed in
 *   the class list, passed every unit test that read the class list, and caught
 *   nothing at all. `after:inset-x-0` is what made it real;
 * - the background-task bar's expand chevron was documented in three comments
 *   and two tests as "the touch path" to the desktop-only hover tooltips, and
 *   had no reach whatsoever — 15px of border box, and 15px to a finger.
 *
 * That PR's own review asked for exactly this file and its author deferred it
 * (nit N4, "adding permanent Playwright specs … is meaningfully more work than
 * this review-response pass"). So the unit suites still assert
 * `className).toContain('after:-inset-y-2')`, which is true of the broken
 * version too.
 *
 * **Every number here is measured, and every assertion is stated twice.** A
 * floor on the measured height alone would pass a control whose reach died but
 * whose box grew; a floor on the reach alone would pass a control that shrank
 * to nothing and grew a large `::after` around it. So each control is asserted
 * against both: how tall it is to a finger, and how much of that its own box
 * did not already provide. The second is the one that goes red against the
 * pre-#1530 code, because that is precisely what those bugs cost — zero.
 *
 * Chrome only, phone viewport, no turns: these reaches are all `md:after:hidden`
 * (a mouse does not need them), so a desktop-width run would measure a control
 * that is *supposed* to be its own box and report a failure nothing is wrong
 * with.
 */

/** iPhone 14/15 in portrait — the width every reach in this file is cut for. */
const PHONE = { width: 390, height: 844 } as const;

/**
 * The reach a tab close button must actually deliver, in CSS pixels.
 *
 * `after:-inset-y-2` is 8px on each side, so the intended growth over the
 * button's own box is 16px, and 16px is what a healthy build measures
 * (24.99px of box → 40.99px to a finger, Chromium at 390×844). Fourteen is
 * that, less two pixels of probe and sub-pixel slack — deliberately far above
 * the number the defect produced, which was **zero**.
 */
const TAB_CLOSE_MIN_REACH_PX = 14;

/**
 * How tall a tab close button must be to a finger.
 *
 * Below the 44px ideal on purpose, and the constraint is the tab strip rather
 * than an oversight: the button is pinned inside the tab's own `pr-7` gutter
 * and may not reach sideways at all (a sideways reach would eat the tab's own
 * label, so a tap meant to SELECT the tab would close it). What it has is the
 * 8px of vertical slack each side that `py-3` opened for it, which is 41px in
 * total. This floor pins that, so a future change that takes `py-3` back off
 * the tab fails here instead of silently shrinking the target.
 */
const TAB_CLOSE_MIN_TOUCH_PX = 36;

/**
 * The reach the background bar's expand chevron must deliver.
 *
 * `after:-inset-y-2.5` asks for 10px each side. It does not always get all
 * twenty: the bar is `overflow-hidden` with a 44px collapsed cap, and its row
 * is only as tall as its tallest child — 36px with an `AgentRunner` figure in
 * it, less without one — so on a bash-only bar the last ~2px of reach is
 * clipped by the bar itself (measured: 17.6px of growth rather than 20). That
 * is the design working, not a defect, so the floor sits under the clipped
 * case and far, far above the 0px the chevron shipped with.
 */
const CHEVRON_MIN_REACH_PX = 15;

/**
 * How tall the expand chevron must be to a finger.
 *
 * The chevron's own box is 15px (a `size-3.5` icon beside a `text-3xs` count),
 * which is what the audit measured and called unhittable. Thirty is double
 * that and under the clipped 32.6px worst case above.
 */
const CHEVRON_MIN_TOUCH_PX = 30;

/**
 * Measure one control and say, in words that survive being printed alone, what
 * it must be and what it was.
 *
 * The two assertions are separate expects rather than one combined check
 * because they fail for different reasons and a reader needs to know which:
 * a short box is a layout change, a dead reach is the DOR-1753 bug returning.
 *
 * @param control - The control to measure. Must already be on screen —
 *   `elementFromPoint` reads viewport coordinates, so an off-screen control
 *   measures whatever pixel happens to sit at its coordinates.
 * @param name - What to call it in a failure.
 * @param floors - The two numbers it must clear.
 */
async function expectReach(
  control: Locator,
  name: string,
  floors: { minTouch: number; minReach: number }
): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  const box = await borderHeight(control);
  const touch = await touchHeight(control);
  const reach = touch - box;
  expect(
    touch,
    `${name}: a thumb finds ${touch.toFixed(1)}px of it, and it must find at least ` +
      `${floors.minTouch}px`
  ).toBeGreaterThanOrEqual(floors.minTouch);
  expect(
    reach,
    `${name}: its own box is ${box.toFixed(1)}px and a thumb finds ${touch.toFixed(1)}px, so its ` +
      `invisible reach adds ${reach.toFixed(1)}px — it must add at least ${floors.minReach}px. ` +
      `A reach of ~0 is the DOR-1753 defect: an ::after with no horizontal inset ` +
      `shrink-wraps to zero width and catches nothing`
  ).toBeGreaterThanOrEqual(floors.minReach);
}

test.describe('Touch reach — the surfaces batch 07 fixed @smoke', () => {
  test.use({ viewport: PHONE });

  /**
   * A dev server for the embedded browser to frame.
   *
   * The Browser tab's "Web Page" action is the cheapest way to put a real
   * document tab — and therefore a real close button — in a strip. Both strips
   * are the same component over different documents (ADR 260911-200304), so the
   * reach this measures is the one the Canvas tab ships too. The fixture is the
   * one `tests/workbench/dev-server-preview.spec.ts` already owns, so there is
   * one honest answer in the repo to "what does a dev server emit" rather than
   * two.
   */
  let devServer: Server;
  let devPort: number;

  test.beforeAll(async () => {
    const started = await startDevServer();
    devServer = started.server;
    devPort = started.port;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => devServer.close(() => resolve()));
  });

  test('a document tab can be closed by a thumb', async ({ page, rightPanel }) => {
    await openInCanvasBrowser(page, rightPanel, `http://localhost:${devPort}/`);

    // The outcome, not a settle time: the strip only exists once a document is
    // open, so waiting for the close button IS waiting for the document.
    const close = page
      .locator('[role="tablist"][aria-label="Open browser pages"] button[aria-label^="Close "]')
      .first();
    await expect(
      close,
      'opening a web page must put a closable tab in the Browser tab’s strip'
    ).toBeVisible({ timeout: 15_000 });

    await expectReach(close, 'the document tab close button', {
      minTouch: TAB_CLOSE_MIN_TOUCH_PX,
      minReach: TAB_CLOSE_MIN_REACH_PX,
    });
  });

  test('a terminal tab can be closed by a thumb', async ({ page, rightPanel }) => {
    await rightPanel.goto('/session');
    await rightPanel.ensureTabStripOpen();
    await rightPanel.header.getByRole('tab', { name: 'Terminal' }).click();

    // The panel spawns its first terminal on open, so the tab arriving is the
    // PTY having been created — an outcome to wait for rather than a guess at
    // how long the round trip takes.
    const close = page
      .locator('[role="tablist"][aria-label="Open terminals"] button[aria-label^="Close "]')
      .first();
    await expect(close, 'opening the Terminal tab must spawn a closable terminal').toBeVisible({
      timeout: 20_000,
    });

    await expectReach(close, 'the terminal tab close button', {
      minTouch: TAB_CLOSE_MIN_TOUCH_PX,
      minReach: TAB_CLOSE_MIN_REACH_PX,
    });
  });

  test('every background-task bar hands its chevron to a thumb', async ({ page }) => {
    // **The Dev Playground, and that is the faithful surface here rather than a
    // convenience.** A real background-task bar needs an agent turn that spawns
    // a subagent or a background bash command — a billable model call this
    // suite deliberately never makes. `BackgroundTaskShowcases` renders the
    // real `BackgroundTaskBar` with real tasks, including the
    // `overflow-hidden` + 44px `maxHeight` clip that is the whole reason the
    // chevron's reach had to be sized to the row rather than to 44px. The same
    // reasoning `tests/dashboard-sidebar/mobile-touch.spec.ts` gives for
    // measuring an unmodified `size="sm"` Button on `/dev/components`.
    await page.goto('/dev/conversation');

    const chevrons = page.getByRole('button', { name: /task details$/ });
    // The outcome, not a settle time: `count()` does not wait for anything, so
    // a census taken the moment `goto` resolves counts a page that has not
    // drawn its showcases yet and reports a clean zero.
    await expect(
      chevrons.first(),
      'the playground page must draw a populated BackgroundTaskBar before it can be measured'
    ).toBeVisible({ timeout: 15_000 });

    // Enumerated from the DOM rather than named one by one: a hand-written list
    // only ever checks the bars somebody remembered, and the shortest bar (no
    // agent figure, so the shortest row, so the most clipped reach) is exactly
    // the one a list would leave out.
    const count = await chevrons.count();
    expect(
      count,
      'the playground must render at least one populated BackgroundTaskBar for this to measure — ' +
        `it rendered ${count}`
    ).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      await expectReach(chevrons.nth(i), `background-task bar ${i + 1} of ${count}: the chevron`, {
        minTouch: CHEVRON_MIN_TOUCH_PX,
        minReach: CHEVRON_MIN_REACH_PX,
      });
    }
  });
});
