import { test, expect } from '../../fixtures';
import type { RightPanelPage } from '../../pages/RightPanelPage';

/**
 * The right panel's tab strip when six tabs do not fit.
 *
 * `/session` registers six contributions (Pulse, Profile, Session, Files,
 * Canvas, Terminal), which is wider than the strip at the 45% split this was filed
 * at — so the strip scrolls, and two things have to hold once it does: the
 * selected tab is on screen, and an edge with tabs behind it says so.
 *
 * Clicking a tab got the first one for free, because the browser scrolls what it
 * focuses — which is why nothing a person did by hand ever showed the bug.
 * Everything else did: a tab selected by a server `ui_command` (the agent opening
 * the canvas), or by a restored per-agent layout, was left cut off at the strip's
 * edge with its label half-drawn (DOR-471). So the selection here is made the way
 * the app's own code makes it — a synthetic `click()`, which fires the handler
 * without focusing — and the reveal has to do the work on its own.
 *
 * Every reading is taken inside a poll that first re-opens the panel and re-selects
 * the tab. That is not the assertion going soft: the panel restores its own
 * per-agent layout as soon as the agent query settles, and on a cold cache that
 * restore lands a second late, closing the panel and resetting the selection. The
 * poll absorbs that; it still fails — and did fail — when the reveal never runs.
 */

/** The split the product bug was filed at — 45% of the window to the right panel. */
const RIGHT_PANEL_PCT = 45;

/** The capture pipeline's viewport, which is where the bug was found. */
const WINDOW = { width: 1280, height: 800 } as const;

/** A window wide enough that the same split fits all six tabs. */
const ROOMY_WINDOW_WIDTH = 1800;

/** The tab at the far end of the strip — the one a 45% split cannot show at rest. */
const FAR_TAB_ID = 'terminal';

/** Sub-pixel layout rounding is not a clipped tab. */
const SLACK_PX = 1;

/** Long enough for the panel, the selection, and the reveal; short enough to fail. */
const SETTLE_TIMEOUT_MS = 10_000;

/** One reading of the strip, taken with the panel open and the far tab selected. */
interface FarTabReading {
  /** How far the selected tab falls outside the strip, on whichever side it does. */
  overhang: number;
  /** Whether each edge fade agrees with the scroll position read alongside it. */
  fades: string;
  /** How far the strip is scrolled. */
  scrollLeft: number;
}

/**
 * Open the strip, select the far tab, and measure — all in one pass.
 *
 * The geometry and the fades come from a single page evaluation, so there is no
 * window between "where the strip is scrolled" and "which fades are drawn" for the
 * two to disagree in.
 */
async function readFarTab(rightPanel: RightPanelPage): Promise<FarTabReading> {
  await rightPanel.ensureTabStripOpen();
  const before = await rightPanel.measureTabStrip();
  if (before.selectedId !== FAR_TAB_ID) await rightPanel.activateTabWithoutFocus(FAR_TAB_ID);

  const strip = await rightPanel.measureTabStrip();
  const start = strip.fadeStart === strip.scrollLeft > SLACK_PX ? 'ok' : 'wrong';
  const end = strip.fadeEnd === strip.scrollLeft < strip.deficit - SLACK_PX ? 'ok' : 'wrong';
  return {
    overhang:
      strip.selectedId === FAR_TAB_ID
        ? Math.round(Math.max(strip.selectedPastStart, strip.selectedPastEnd))
        : Number.POSITIVE_INFINITY,
    fades: `start:${start} end:${end}`,
    scrollLeft: strip.scrollLeft,
  };
}

test.describe('Right panel — a tab strip that never hides the tab you are on @smoke', () => {
  test.use({ viewport: WINDOW });

  test('brings a tab selected without a click into view, and fades the edges hiding tabs', async ({
    rightPanel,
  }) => {
    await rightPanel.seedSplit(RIGHT_PANEL_PCT);
    await rightPanel.goto('/session');
    await rightPanel.ensureTabStripOpen();
    await expect(rightPanel.header.getByRole('tab')).toHaveCount(6);

    // Precondition, not decoration: with room for every tab nothing below could
    // fail, and the test would be passing on an empty claim.
    const atRest = await rightPanel.measureTabStrip();
    expect(
      atRest.deficit,
      `six tabs must not fit a ${RIGHT_PANEL_PCT}% panel at ${WINDOW.width}px`
    ).toBeGreaterThan(0);

    // Before the fix this never converged: the strip stayed where it was and the
    // selected tab sat ~190px past its end for as long as you cared to wait.
    let reading: FarTabReading | undefined;
    await expect
      .poll(
        async () => {
          reading = await readFarTab(rightPanel);
          return reading.overhang;
        },
        {
          message: `the ${FAR_TAB_ID} tab must be selected and fully in view`,
          timeout: SETTLE_TIMEOUT_MS,
        }
      )
      .toBeLessThanOrEqual(SLACK_PX);

    // Revealing the last tab means scrolling past the first ones, so the start edge
    // has tabs behind it and must say so — and each fade has to agree with the
    // scroll position it was read with (ADR 260725-004456: a fade over nothing is
    // worse than no fade at all).
    expect(reading!.scrollLeft, 'the reveal must have scrolled the strip').toBeGreaterThan(
      SLACK_PX
    );
    expect(reading!.fades).toBe('start:ok end:ok');
  });

  test('advertises nothing when every tab fits', async ({ rightPanel, page }) => {
    // The same split on a wide window, so the six tabs have room to spare: no
    // scroll, and therefore no fade on either edge.
    await page.setViewportSize({ width: ROOMY_WINDOW_WIDTH, height: WINDOW.height });
    await rightPanel.seedSplit(RIGHT_PANEL_PCT);
    await rightPanel.goto('/session');
    await rightPanel.ensureTabStripOpen();
    await expect(rightPanel.header.getByRole('tab')).toHaveCount(6);

    let fades = '';
    await expect
      .poll(
        async () => {
          await rightPanel.ensureTabStripOpen();
          const strip = await rightPanel.measureTabStrip();
          fades = `${strip.fadeStart} ${strip.fadeEnd}`;
          return strip.deficit;
        },
        { message: 'a wide panel must fit every tab', timeout: SETTLE_TIMEOUT_MS }
      )
      .toBeLessThanOrEqual(SLACK_PX);
    expect(fades, 'neither edge hides a tab, so neither may be faded').toBe('false false');
  });
});
