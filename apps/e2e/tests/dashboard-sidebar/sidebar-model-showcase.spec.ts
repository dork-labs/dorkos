import { createRequire } from 'node:module';
import type { AxeResults, Result } from 'axe-core';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';

declare global {
  interface Window {
    /** Injected by {@link runAxe} via `addScriptTag`; absent until then. */
    axe: { run: (context: string, options: Record<string, unknown>) => Promise<AxeResults> };
  }
}

/**
 * The Dev Playground page this spec drives.
 *
 * It renders `buildSidebarModel` over the four journey fixtures with no server
 * behind it, which is what lets this whole file be a `@smoke` test: it seeds
 * nothing, registers no agent, and cleans nothing up.
 */
const SHOWCASE_PATH = '/dev/sidebar-model';

/**
 * axe-core's own bundle, resolved from this package's dependency rather than
 * fetched.
 *
 * `@axe-core/playwright` would be the usual choice; the bare engine is used
 * because it was already in the lockfile (`eslint-plugin-jsx-a11y` depends on
 * it) and injecting one script is the whole of what the wrapper does here.
 */
const AXE_BUNDLE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/** What axe is pointed at: the page's content box, and none of the playground's chrome. */
const AXE_CONTEXT = '[data-slot="page-container"]';

/**
 * The zones each journey is expected to draw, in order.
 *
 * Hard-coded rather than derived from the page, because a test that reads its
 * expectation off the thing it is testing cannot fail. These are the four
 * journeys' answers as `buildSidebarModel` computes them:
 *
 * - `first-run` — Getting started occupies Now's slot, and Today is **absent**
 *   because nothing has happened yet. BC-1 and BC-4 in one row.
 * - `quiet` — no Now zone AT ALL. The calm signal is the absence of a box, not
 *   an empty one.
 * - `busy` / `power` — the full three.
 */
const EXPECTED_ZONES: Record<string, string[]> = {
  'first-run': ['getting-started', 'library'],
  quiet: ['today', 'library'],
  busy: ['now', 'today', 'library'],
  power: ['now', 'today', 'library'],
};

/**
 * How many attention rows each journey's Now zone holds, and whether it
 * overflows.
 *
 * **`busy` does not overflow, and that is the point of having both.** It raises
 * exactly three signals, so it fills the cap without exceeding it; `power`
 * raises seven, so three are shown and `+ 4 more` carries the rest (BC-7). A
 * test that only ever looked at an overflowing fixture could not tell a cap from
 * a coincidence. (The task brief said both fixtures overflow; the model says
 * otherwise, and the model is what this asserts.)
 */
const EXPECTED_NOW: Record<string, { attention: number; overflow: string | null }> = {
  busy: { attention: 3, overflow: null },
  power: { attention: 3, overflow: '+ 4 more' },
};

/** Every fixture the page draws, in the order it draws them. */
const FIXTURES = ['first-run', 'quiet', 'busy', 'power'] as const;

/**
 * The one contrast failure on this page that is not this page's to fix, named
 * so it cannot spread.
 *
 * `SidebarRow` dims a muted row with `opacity-60` (`shared/ui/sidebar-row.tsx`),
 * and the label under it is already only 5.9:1 — so a muted row's name measures
 * **2.6:1 in light and 3.6:1 in dark**. It is a real WCAG AA failure in the
 * shared primitive, in the app as much as here, and it cannot be fixed by
 * picking a different opacity: any dimming of a 5.9:1 label lands under 4.5.
 * Resolving it is a design decision about what "muted" may look like, which is
 * why this branch reports it rather than changing another task's file.
 *
 * The quarantine is an **equality** assertion, not a filter, so it retires
 * itself: a new failure anywhere fails the test because it is not in this list,
 * and fixing the muted treatment fails the test because the list no longer
 * matches.
 */
const QUARANTINED_MUTED_ROWS = 2;

/**
 * Open the showcase and wait until all four panels are on screen.
 *
 * The ceiling is the suite's shared {@link SERVER_ROUND_TRIP_MS}, not the 5s
 * default, and it is a **ceiling rather than a delay** — on a warm dev server
 * the panels resolve in milliseconds. What it buys is the cold case: the six
 * tests in this file run on concurrent workers that all fault in the Dev
 * Playground's module graph at once, and the first run measured ~17s per test
 * against a 5s default. One of the six lost that race for a reason that had
 * nothing to do with what it was asserting.
 *
 * @param page - The page under test.
 */
async function openShowcase(page: Page): Promise<Locator> {
  await page.goto(SHOWCASE_PATH);
  const panels = page.locator('[data-slot="sidebar-model-panel"]');
  await expect(panels).toHaveCount(FIXTURES.length, { timeout: SERVER_ROUND_TRIP_MS });
  return panels;
}

/**
 * Switch the playground's theme and wait until the document actually wears it.
 *
 * The click and the class are two different events — the store writes on the
 * next commit — so asserting the class is what makes the screenshot and the axe
 * run below belong to the theme this says they do.
 *
 * @param page - The page under test.
 * @param theme - Which theme to put the document in.
 */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${theme} theme$`, 'i') }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(theme === 'dark');
}

/**
 * Run axe-core over the page's content box and hand back everything it found.
 *
 * @param page - The page under test.
 */
async function runAxe(page: Page): Promise<AxeResults> {
  await page.addScriptTag({ path: AXE_BUNDLE });
  return page.evaluate(async (context) => window.axe.run(context, {}), AXE_CONTEXT);
}

/** One violation, flattened into something an assertion failure can be read from. */
function describeViolation(violation: Result): string {
  return `${violation.id} (${violation.impact}): ${violation.nodes
    .map((node) => `${node.target.join(' ')} — ${node.failureSummary?.replace(/\s+/g, ' ')}`)
    .join(' | ')}`;
}

/**
 * The mandatory R1 gate, plus the model's zone contracts, read off a real
 * browser.
 *
 * The four journey fixtures drive the model's table tests, the Dev Playground's
 * showcases and this file, so what a reviewer looks at and what CI asserts are
 * the same states (spec `sidebar-now-today-library` §13). The unit suite proves
 * `buildSidebarModel` decides the right things; only a browser can prove the
 * decisions survive being drawn — and only a browser can measure contrast on a
 * tint composited from four translucent layers.
 *
 * A NEW file rather than an addition to `sidebar-groups.spec.ts`: that spec
 * seeds an agent and serializes on one shared `ui.sidebar`, and none of this
 * needs either.
 */
test.describe('Sidebar model showcase @smoke', () => {
  /**
   * **The viewport height is load-bearing, and this is the trap that ate an
   * afternoon.** axe-core builds a spatial grid bounded by the viewport, and
   * `color-contrast` silently declines to match any element whose text rect
   * falls outside it — no violation, no pass, no incomplete, just nothing. At
   * the default 720px this page returned ONE evaluated node out of ~320 and an
   * injected 1.7:1 label went undetected: a gate that could not fail. At 5200px
   * the whole page is inside the grid, 300+ nodes are evaluated, and the same
   * injected failure is caught. Do not shrink this below the page's own height.
   */
  test.use({ viewport: { width: 1600, height: 5200 } });

  test('renders all four journeys, and asks the server for nothing', async ({ page }) => {
    // Collected from before the navigation, so a call made during the initial
    // render is caught rather than missed (P1 AC-8: the playground renders all
    // four fixtures without a running server).
    const apiCalls: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url());
    });

    const panels = await openShowcase(page);
    expect(await panels.evaluateAll((nodes) => nodes.map((n) => n.dataset.fixture))).toEqual([
      ...FIXTURES,
    ]);

    // Let anything the page was going to fetch actually be fetched before the
    // list is read — an empty list read too early proves nothing.
    await page.waitForLoadState('networkidle');
    expect(apiCalls, 'the sidebar model showcase must render with no server behind it').toEqual([]);
  });

  test('draws the zones each journey earns, and never an empty box', async ({ page }) => {
    await openShowcase(page);

    for (const fixture of FIXTURES) {
      const panel = page.locator(`[data-slot="sidebar-model-panel"][data-fixture="${fixture}"]`);
      const zones = panel.locator('[data-slot="sidebar-model-zone"]');
      expect(
        await zones.evaluateAll((nodes) => nodes.map((n) => n.dataset.zone)),
        `${fixture} draws the wrong zones`
      ).toEqual(EXPECTED_ZONES[fixture]);

      // Named separately from the ordered list above, because "absent" is the
      // assertion this phase keeps having to defend: a zone with nothing in it
      // disappears entirely rather than rendering an empty card (BC-1). Now and
      // the day-one zone also share one slot, so no journey may show both.
      if (!EXPECTED_ZONES[fixture].includes('now')) {
        await expect(panel.locator('[data-zone="now"]')).toHaveCount(0);
      }
      if (!EXPECTED_ZONES[fixture].includes('getting-started')) {
        await expect(panel.locator('[data-zone="getting-started"]')).toHaveCount(0);
      }
    }
  });

  test('caps Now at three, and overflows only when there is more than three', async ({ page }) => {
    await openShowcase(page);

    for (const [fixture, expected] of Object.entries(EXPECTED_NOW)) {
      const now = page.locator(
        `[data-slot="sidebar-model-panel"][data-fixture="${fixture}"] [data-zone="now"]`
      );
      // Attention rows are the ones whose reason names why they blocked —
      // `now:permission-prompt`, `now:question`, `now:error`, `now:idle-timeout`
      // — which is exactly the set the cap applies to. The working rollup and
      // the overflow row carry `rollup:` reasons and are deliberately not counted.
      await expect(
        now.locator('[data-slot="sidebar-model-reason"][data-reason^="now:"]'),
        `${fixture} shows the wrong number of things needing you`
      ).toHaveCount(expected.attention);

      const overflow = now.locator('[data-reason="rollup:now-overflow"]');
      if (expected.overflow === null) {
        await expect(
          overflow,
          `${fixture} raised an overflow row it has nothing to fill`
        ).toHaveCount(0);
      } else {
        await expect(overflow).toHaveCount(1);
        await expect(now.getByText(expected.overflow, { exact: true })).toBeVisible();
      }
    }
  });

  test('says why every row it drew is there', async ({ page }) => {
    await openShowcase(page);

    for (const fixture of FIXTURES) {
      const panel = page.locator(`[data-slot="sidebar-model-panel"][data-fixture="${fixture}"]`);
      const rows = await panel.locator('[data-slot^="sidebar-model-row"]').count();
      const reasons = await panel
        .locator('[data-slot="sidebar-model-reason"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-reason') ?? ''));

      // A floor of zero is what lets a loop over nothing pass, so the count is
      // pinned to the rows actually on screen. Every zone and every section
      // carries a reason too, so there are always MORE reasons than rows —
      // fewer would mean a row drew without one.
      expect(rows, `${fixture} drew no rows at all`).toBeGreaterThan(0);
      expect(reasons.length, `${fixture} has a node with no reason`).toBeGreaterThan(rows);
      for (const reason of reasons) {
        expect(reason, `${fixture} has a malformed reason`).toMatch(/^[a-z-]+:[a-z-]+$/);
      }
    }
  });

  // The R1 gate. A `for` loop rather than two copies so neither theme can be
  // quietly dropped: removing one is removing a loop entry, which reads as a
  // deletion in a diff.
  for (const theme of ['light', 'dark'] as const) {
    test(`meets 4.5:1 on the zone tint in the ${theme} theme`, async ({ page }, testInfo) => {
      await openShowcase(page);
      await setTheme(page, theme);

      // The both-themes screenshot pair P1 AC-6 requires, attached to the run
      // rather than described in a PR comment — so a reviewer sees the same
      // pixels the contrast assertion below was computed from.
      await testInfo.attach(`sidebar-model-${theme}.png`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });

      const results = await runAxe(page);

      // The gate itself is only worth anything if axe actually looked at the
      // page: it evaluates ~320 nodes here, and a viewport that shrank would
      // drop that to one while still reporting zero violations.
      const evaluated = [...results.passes, ...results.violations, ...results.incomplete]
        .filter((rule) => rule.id === 'color-contrast')
        .reduce((total, rule) => total + rule.nodes.length, 0);
      expect(
        evaluated,
        'axe evaluated almost nothing — the viewport is smaller than the page and the contrast gate is vacuous'
      ).toBeGreaterThan(200);

      const contrast = results.violations.filter((violation) => violation.id === 'color-contrast');
      const contrastNodes = contrast.flatMap((violation) => violation.nodes);
      const muted = await page.evaluate(
        (targets) =>
          targets.filter((target) =>
            document.querySelector(target)?.closest('[data-slot="sidebar-model-row-muted"]')
          ).length,
        contrastNodes.map((node) => node.target.join(' '))
      );

      // Everything that is NOT the quarantined muted-row dimming must be clean.
      expect(
        contrastNodes.length - muted === 0 ? [] : contrast.map(describeViolation),
        `label-on-zone-tint must meet 4.5:1 in the ${theme} theme (design-system §Accessibility)`
      ).toEqual([]);
      expect(
        muted,
        'the muted-row contrast defect changed shape — re-read QUARANTINED_MUTED_ROWS and either widen it deliberately or delete it because it is fixed'
      ).toBe(QUARANTINED_MUTED_ROWS);

      // Every other rule, held to the same bar. The zone landmarks, the heading
      // order and the list semantics are as much a part of what this page shows
      // as its colours are.
      const others = results.violations.filter((violation) => violation.id !== 'color-contrast');
      expect(others.map(describeViolation), `axe found a11y defects in the ${theme} theme`).toEqual(
        []
      );

      // What axe declined to judge, pinned. Every one of these is a one-digit
      // unread badge tripping axe's "content is too short to be text" heuristic;
      // anything else appearing here is a hole in the gate that somebody has to
      // decide about rather than inherit.
      const undecided = results.incomplete.flatMap((rule) => rule.nodes);
      const badges = await page.evaluate(
        (targets) =>
          targets.filter((target) =>
            document.querySelector(target)?.closest('[data-slot="sidebar-model-directed-badge"]')
          ).length,
        undecided.map((node) => node.target.join(' '))
      );
      expect(
        undecided.length - badges,
        `axe could not judge something new in the ${theme} theme: ${undecided
          .map((node) => node.target.join(' '))
          .join(', ')}`
      ).toBe(0);
    });
  }
});
