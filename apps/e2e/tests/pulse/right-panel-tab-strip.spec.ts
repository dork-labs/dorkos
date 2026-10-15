import { test, expect } from '../../fixtures';
import type { RightPanelPage } from '../../pages/RightPanelPage';

/** Relevant defaults remain compact; added views retain the overflow reveal contract. */
async function addOptionalViews(rightPanel: RightPanelPage) {
  for (const name of ['Pulse', 'Chat', 'Canvas', 'Browser', 'Terminal']) {
    await rightPanel.selectView(name);
  }
  // Terminal is a concrete PTY view once its creation settles.
  await expect(rightPanel.header.getByRole('tab', { name: /^Shell 1$/ })).toHaveAttribute(
    'id',
    /^right-panel-tab-resource\/terminal\/[0-9a-f-]{36}$/
  );
  return (await rightPanel.header
    .getByRole('tab', { name: /^Shell 1$/ })
    .getAttribute('id'))!.replace('right-panel-tab-', '');
}

/** The split the product bug was filed at — 45% of the window to the right panel. */
const RIGHT_PANEL_PCT = 45;

/** The capture pipeline's viewport, which is where the bug was found. */
const WINDOW = { width: 1280, height: 800 } as const;

/**
 * A window wide enough that the same split fits all seven tabs.
 *
 * Re-measured when the Browser tab arrived (ADR 260911-200304), because a
 * seventh tab changes the arithmetic under BOTH halves of this file: a width
 * that only ever fit six would fail here for a reason that is not the bug this
 * was filed for. Seven tabs are ~530px of content and the strip gets roughly
 * `0.45 × window − 200` px, so the overflow ends near 1620px and this width
 * leaves the strip ~610px — about 80px of slack. Deliberately not the narrowest
 * width that fits: the assertion below is "no fade when nothing is hidden", and
 * a value sitting on the boundary would go red on a pixel of rounding.
 */
const ROOMY_WINDOW_WIDTH = 1800;

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
async function readFarTab(rightPanel: RightPanelPage, farTabId: string): Promise<FarTabReading> {
  await rightPanel.ensureTabStripOpen();
  const before = await rightPanel.measureTabStrip();
  if (before.selectedId !== farTabId) await rightPanel.activateTabWithoutFocus(farTabId);

  const strip = await rightPanel.measureTabStrip();
  const start = strip.fadeStart === strip.scrollLeft > SLACK_PX ? 'ok' : 'wrong';
  const end = strip.fadeEnd === strip.scrollLeft < strip.deficit - SLACK_PX ? 'ok' : 'wrong';
  return {
    overhang:
      strip.selectedId === farTabId
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
    await expect(rightPanel.header.getByRole('tab')).toHaveCount(2);
    const farTabId = await addOptionalViews(rightPanel);
    await expect(rightPanel.header.getByRole('tab')).toHaveCount(7);

    // Precondition, not decoration: with room for every tab nothing below could
    // fail, and the test would be passing on an empty claim.
    const atRest = await rightPanel.measureTabStrip();
    expect(
      atRest.deficit,
      `seven tabs must not fit a ${RIGHT_PANEL_PCT}% panel at ${WINDOW.width}px`
    ).toBeGreaterThan(0);

    // Before the fix this never converged: the strip stayed where it was and the
    // selected tab sat ~190px past its end for as long as you cared to wait.
    //
    // The poll's own stop condition has to include the fades, not just the
    // overhang: `scrollLeft` moves the instant the scroll happens, but the fade
    // elements are toggled by the app's own scroll-event handler, which lags
    // behind under load (DOR-1414). Stopping on overhang alone let the poll exit
    // a beat before the fades caught up, so the one-shot assertion below caught
    // it mid-lag ~50% of the time under machine load.
    // Summarized rather than a bare boolean: a poll timeout only ever prints
    // its LAST returned value, and "false" says nothing about which half —
    // the overhang or the fades — was still unsettled when it gave up.
    let reading: FarTabReading | undefined;
    await expect
      .poll(
        async () => {
          reading = await readFarTab(rightPanel, farTabId);
          const overhang = reading.overhang <= SLACK_PX ? 'ok' : reading.overhang;
          return `overhang:${overhang} ${reading.fades}`;
        },
        {
          message: `the ${farTabId} tab must be selected, fully in view, and its fades settled`,
          timeout: SETTLE_TIMEOUT_MS,
        }
      )
      .toBe('overhang:ok start:ok end:ok');

    // Revealing the last tab means scrolling past the first ones, so the start edge
    // has tabs behind it and must say so — and each fade has to agree with the
    // scroll position it was read with (ADR 260725-004456: a fade over nothing is
    // worse than no fade at all). The fades themselves are already proven by the
    // poll above; this checks the one thing it does not — that they were earned
    // by an actual scroll, not just a coincidental read.
    expect(reading!.scrollLeft, 'the reveal must have scrolled the strip').toBeGreaterThan(
      SLACK_PX
    );
  });

  test('advertises nothing when every tab fits', async ({ rightPanel, page }) => {
    // The same split on a wide window, so the seven tabs have room to spare: no
    // scroll, and therefore no fade on either edge.
    await page.setViewportSize({ width: ROOMY_WINDOW_WIDTH, height: WINDOW.height });
    await rightPanel.seedSplit(RIGHT_PANEL_PCT);
    await rightPanel.goto('/session');
    await rightPanel.ensureTabStripOpen();
    await addOptionalViews(rightPanel);
    await expect(rightPanel.header.getByRole('tab')).toHaveCount(7);

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
