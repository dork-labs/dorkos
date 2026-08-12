import { createRequire } from 'node:module';
import type { AxeResults, Result } from 'axe-core';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

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
 * - `first-run` — Getting started occupies Heads up's slot, and Today is **absent**
 *   because nothing has happened yet. BC-1 and BC-4 in one row.
 * - `quiet` — no Heads up zone AT ALL. The calm signal is the absence of a box, not
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
 * How many attention rows each journey's Heads up zone holds, and whether it
 * overflows.
 *
 * **`busy` does not overflow, and that is the point of having both.** It raises
 * exactly three signals, so it fills the cap without exceeding it; `power`
 * raises seven, so three are shown and `+ 4 more` carries the rest (BC-7). A
 * test that only ever looked at an overflowing fixture could not tell a cap from
 * a coincidence. (The task brief said both fixtures overflow; the model says
 * otherwise, and the model is what this asserts.)
 */
const EXPECTED_NOW: Record<string, { attention: number; overflow: string | null } | null> = {
  // No Heads up zone at all — the row exists so that adding a fifth journey without
  // an entry here throws rather than being silently skipped, which is what
  // `Object.entries` over a partial table used to do.
  'first-run': null,
  quiet: null,
  busy: { attention: 3, overflow: null },
  power: { attention: 3, overflow: '+ 4 more' },
};

/** Every fixture the page draws, in the order it draws them. */
const FIXTURES = ['first-run', 'quiet', 'busy', 'power'] as const;

/**
 * The dimmed rows whose labels do not meet 4.5:1, quarantined by the MECHANISM
 * that breaks them rather than by a marker this page paints on.
 *
 * `SidebarRow` dims a `muted` row with `opacity-60` (`shared/ui/sidebar-row.tsx`)
 * over a label that is already only 5.9:1, so the name measures **2.6:1 in light
 * and 3.6:1 in dark**. No opacity clears 4.5:1 from that start, so it is a design
 * decision and not a tuning one: muted has to mean fewer signals rather than
 * less legibility. Tracked as **DOR-1098**.
 *
 * **Two rows, and only one of them is inherited.** One is fixture-driven —
 * `busy` mutes `#noise`, so any honest drawing of that journey has it. The other
 * is the `archive` row this page's own unread-tier showcase adds to demonstrate
 * that mute kills bold and badge (§18). That one is this branch's, and it stays:
 * removing it would hide a rule the page exists to show, and it fails for
 * exactly the same reason DOR-1098 fixes.
 *
 * **Matched on computed opacity, deliberately.** Asking "does an ancestor of the
 * failing text have `opacity < 1`?" names the defect itself, so the quarantine
 * cannot be widened by relabelling a row, and it collapses to zero the moment
 * the dim goes. The count is an **equality** assertion, not a filter: a new
 * failure anywhere reds the clean-set assertion, and fixing DOR-1098 reds this
 * one, which is the instruction to delete it.
 */
const QUARANTINED_DIMMED_ROWS = 2;

/**
 * How long the first navigation to `/dev` may take, cold.
 *
 * A **ceiling, not a delay**: against a warm dev server the panels resolve in
 * milliseconds and this costs nothing. What it pays for is the first
 * navigation of a run, when Vite faults in the Dev Playground's whole module
 * graph — every showcase on every page — on demand. Measured cold on a machine
 * running several agents: 32–39 seconds, with six workers all asking at once.
 * The suite's 5s locator default and its 30s per-test default were both under
 * that, so a cold run failed all six tests on a page that renders correctly.
 */
const PLAYGROUND_COLD_START_MS = 90_000;

/**
 * Open the showcase and wait until all four panels are on screen.
 *
 * @param page - The page under test.
 */
async function openShowcase(page: Page): Promise<Locator> {
  await page.goto(SHOWCASE_PATH);
  const panels = page.locator('[data-slot="sidebar-model-panel"]');
  await expect(panels).toHaveCount(FIXTURES.length, { timeout: PLAYGROUND_COLD_START_MS });
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

/**
 * Assert the page fits inside the viewport, before axe is asked anything.
 *
 * **This is the coverage guarantee, and it replaced a number that could not be
 * one.** axe-core's `color-contrast` builds a spatial grid bounded by the
 * viewport and does not evaluate text whose rect falls outside it — not a
 * violation, not a pass, not even an `incomplete`. The gate here used to be
 * `evaluated > 200`, which the page clears comfortably while still dropping its
 * bottom half: measured at 1600×2400 it evaluated 260 nodes and missed two
 * injected 1.91:1 labels, and at 1600×4000 it evaluated 322 and missed the same
 * two. An absolute floor is not coverage, because it does not move when the page
 * does.
 *
 * This does. Measured: the page's scroller overflows by 2420px at 1600×2400 and
 * by 820px at 1600×4000 — the two viewports where the old floor passed while
 * both canaries went unevaluated — and by 0 at the viewport this suite uses.
 * When a new showcase pushes the column past the viewport, this reds with the
 * actual reason, and the fix is to raise the viewport (or split the page), not
 * to loosen a threshold.
 *
 * @param page - The page under test.
 */
async function expectPageFitsViewport(page: Page): Promise<void> {
  const fit = await page.evaluate((context) => {
    const content = document.querySelector(context);
    // The SCROLLER's extent, not the content box's own height. The page
    // container is `h-full` (`PageContainer scroll={false}`), so its bounding
    // rect is clamped to the viewport and its children overflow it visibly —
    // measuring that box reported "fits" at every viewport, including the ones
    // where axe was demonstrably missing a third of the page. The nearest
    // scrolling ancestor is the only thing that knows how tall the page is.
    let scroller = content?.parentElement ?? null;
    while (
      scroller !== null &&
      !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)
    ) {
      scroller = scroller.parentElement;
    }
    const box = scroller ?? document.documentElement;
    return { overflow: box.scrollHeight - box.clientHeight, height: box.scrollHeight };
  }, AXE_CONTEXT);

  expect(
    fit.overflow,
    `the showcase page is ${fit.height}px and does not fit the viewport, so axe stopped evaluating partway down — raise the viewport in test.use() (or split the page); never lower a threshold to make this pass`
  ).toBe(0);
}

/**
 * Assert axe actually evaluated every reason chip on the page.
 *
 * The second half of the coverage guarantee, and the one that tracks content
 * rather than geometry. There is exactly one chip per zone, per section and per
 * row, they carry text, and they run top to bottom of the page — so "axe saw all
 * of them" is the strongest statement available about whether it saw the page.
 * Add a showcase and the denominator grows on its own; no constant to bump.
 *
 * @param page - The page under test.
 * @param results - What the axe run returned.
 */
async function expectEveryReasonChipEvaluated(page: Page, results: AxeResults): Promise<void> {
  const evaluated = [...results.passes, ...results.violations, ...results.incomplete]
    .filter((rule) => rule.id === 'color-contrast')
    .flatMap((rule) => rule.nodes.map((node) => node.target.join(' ')));

  const missed = await page.evaluate((targets) => {
    const seen = new Set<Element>();
    for (const target of targets) {
      const element = document.querySelector(target);
      if (element) seen.add(element);
    }
    return [...document.querySelectorAll('[data-slot="sidebar-model-reason"]')]
      .filter((chip) => !seen.has(chip))
      .map((chip) => chip.getAttribute('data-reason') ?? '(no reason)');
  }, evaluated);

  expect(
    missed.slice(0, 8),
    `axe did not evaluate ${missed.length} of the page's reason chips — it stopped looking before the page ended, so a contrast failure down there would not be reported`
  ).toEqual([]);
}

/**
 * How many of these failing nodes sit under something that dims them.
 *
 * Walks to the document root looking for a computed `opacity` below 1, which is
 * the defect DOR-1098 removes. Naming the mechanism rather than a marker
 * attribute is what stops the quarantine being widened by relabelling a row.
 *
 * @param page - The page under test.
 * @param targets - The failing nodes' selectors, as axe reported them.
 */
async function countUnderDimming(page: Page, targets: string[]): Promise<number> {
  return page.evaluate(
    (selectors) =>
      selectors.filter((selector) => {
        let node: Element | null = document.querySelector(selector);
        while (node !== null) {
          if (Number.parseFloat(getComputedStyle(node).opacity) < 1) return true;
          node = node.parentElement;
        }
        return false;
      }).length,
    targets
  );
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
 *
 * **P1 AC-6 asks for zero contrast violations and this page has two**, both
 * dimmed rows, both quarantined below. Half of that is inherited and half is
 * self-inflicted: `busy` mutes `#noise`, so any honest drawing of that journey
 * carries it, while the `archive` row in the unread-tier showcase is this
 * branch's own. Both fail for one reason — `SidebarRow` dims muted rows, which
 * no opacity value can make legible (DOR-1098) — so neither is fixable here,
 * and the second is kept because the rule it demonstrates is real. AC-6 is met
 * for everything the page controls, and the gap is named rather than hidden.
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
   *
   * It grows with the page, which is the point: `expectPageFitsViewport` reds
   * the moment a new showcase pushes the column past it, and the fix is this
   * number rather than a looser threshold. Raised for the Today states panel
   * (P2.3), which added four more 272px panels below Heads up's four.
   */
  // **The viewport is the page's height, not a round number.** axe reports
  // success for a page it never looked at, so this suite asserts coverage
  // before correctness (`expectPageFitsViewport`) — which means the viewport
  // has to grow with the page. It went from 8800 to 10400 when P4.2 added the
  // long-press-menu and Catch-up showcases; raising it is the fix the guard's
  // own failure message names, and lowering the threshold is the one it
  // forbids.
  test.use({ viewport: { width: 1600, height: 10400 } });

  // The per-test default is 30s, which is under the cold cost of the first
  // navigation to `/dev` — see PLAYGROUND_COLD_START_MS. A locator ceiling
  // longer than the test timeout it sits inside can never be reached, so the
  // two are raised together.
  test.describe.configure({ timeout: 150_000 });

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
      // disappears entirely rather than rendering an empty card (BC-1). Heads up and
      // the day-one zone also share one slot, so no journey may show both.
      if (!EXPECTED_ZONES[fixture].includes('now')) {
        await expect(panel.locator('[data-zone="now"]')).toHaveCount(0);
      }
      if (!EXPECTED_ZONES[fixture].includes('getting-started')) {
        await expect(panel.locator('[data-zone="getting-started"]')).toHaveCount(0);
      }
    }
  });

  test('caps Heads up at three, and overflows only when there is more than three', async ({
    page,
  }) => {
    await openShowcase(page);

    // Driven off FIXTURES, not off EXPECTED_NOW's own keys: a fifth journey with
    // a Heads up zone and no entry in the table must throw here rather than be
    // skipped by a loop that only ever visits what somebody remembered to write.
    for (const fixture of FIXTURES) {
      const expected = EXPECTED_NOW[fixture];
      expect(
        expected,
        `${fixture} has no EXPECTED_NOW entry — add one, using null if it draws no Heads up zone`
      ).not.toBeUndefined();

      const now = page.locator(
        `[data-slot="sidebar-model-panel"][data-fixture="${fixture}"] [data-zone="now"]`
      );
      if (expected === null) {
        await expect(now, `${fixture} drew a Heads up zone it has nothing for`).toHaveCount(0);
        continue;
      }

      // Attention rows are the ones whose reason names why they blocked —
      // `now:permission-prompt`, `now:question`, `now:error`, `now:idle-timeout`
      // — which is exactly the set the cap applies to. The working rollup and
      // the overflow row carry `rollup:` reasons and are deliberately not counted.
      //
      // Scoped to `li`, and that is load-bearing: the zone's headerless section
      // carries `now:body`, which the `now:` prefix also matches. Only rows are
      // wrapped in a list item, so this counts rows and nothing else. (Caught by
      // this test going 3→4 the moment headerless sections started drawing their
      // own reason chip.)
      await expect(
        now.locator('li [data-slot="sidebar-model-reason"][data-reason^="now:"]'),
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

  test('never lets Heads up scroll — five rows is its ceiling (BC-8)', async ({ page }) => {
    await openShowcase(page);

    // `power` is the worst case the fixtures hold: seven things waiting and six
    // sessions working, so Heads up draws its maximum — three attention rows, an
    // overflow row and the working rollup.
    const now = page.locator(
      '[data-slot="sidebar-model-panel"][data-fixture="power"] [data-zone="now"]'
    );
    await expect(now.locator('li')).toHaveCount(5);

    // The measurement only a browser can make. jsdom reports 0 for both
    // heights, so this assertion is vacuous there and is deliberately here
    // instead: a zone that had grown a scroller would report an overflow.
    const overflow = await now.evaluate((zone) => zone.scrollHeight - zone.clientHeight);
    expect(overflow, 'the Heads up zone grew a scroller — it must never scroll').toBe(0);

    // And the measurement is live: the same reading over a box that IS
    // scrollable comes back non-zero, so a zero above means "does not scroll"
    // rather than "was never measured".
    const proof = await now.evaluate((zone) => {
      const probe = document.createElement('div');
      probe.style.cssText = 'height:20px;overflow:auto';
      probe.innerHTML = '<div style="height:200px"></div>';
      zone.appendChild(probe);
      const reading = probe.scrollHeight - probe.clientHeight;
      probe.remove();
      return reading;
    });
    expect(proof).toBeGreaterThan(0);
  });

  test('draws Heads up’s four states, and the beat, on the same page', async ({ page }) => {
    await openShowcase(page);

    // The states a reviewer cannot catch in the running app: empty, one signal,
    // capped with an overflow, and the day-one zone (spec §13).
    const states = page.locator('[data-slot="sidebar-now-state"]');
    expect(await states.evaluateAll((nodes) => nodes.map((n) => n.dataset.stateName))).toEqual([
      'now-empty',
      'now-one',
      'now-capped',
      'getting-started',
    ]);

    // Empty means EMPTY: the panel is mounted and holds no zone at all.
    const empty = page.locator('[data-slot="sidebar-now-state"][data-state-name="now-empty"]');
    await expect(empty).toBeVisible();
    await expect(empty.locator('[data-slot="sidebar-model-zone"]')).toHaveCount(0);

    // While the panel beside it, drawn from the same component, does hold one.
    await expect(
      page.locator(
        '[data-slot="sidebar-now-state"][data-state-name="now-one"] [data-slot="sidebar-model-zone"]'
      )
    ).toHaveCount(1);

    await expect(page.getByText('All clear', { exact: true })).toBeVisible();
  });

  test('says why every row it drew is there', async ({ page }) => {
    await openShowcase(page);

    for (const fixture of FIXTURES) {
      const panel = page.locator(`[data-slot="sidebar-model-panel"][data-fixture="${fixture}"]`);
      const rows = await panel.locator('[data-slot="sidebar-model-row"]').count();
      expect(rows, `${fixture} drew no rows at all`).toBeGreaterThan(0);

      // Per row, not a total. `reasons.length > rows` was slack enough to be
      // decorative — power could have lost NINE chips and stayed green — and it
      // could not fail anyway, since the chip is emitted in the same expression
      // as the row. This asks the question that matters: does each row's own
      // list item carry a reason? Deleting the `expansion` prop reds it.
      const rowsWithoutReason = await panel.evaluate((root) =>
        [...root.querySelectorAll('[data-slot="sidebar-model-row"]')]
          .filter(
            (row) => row.closest('li')?.querySelector('[data-slot="sidebar-model-reason"]') == null
          )
          .map((row) => row.textContent?.trim().slice(0, 40) ?? '(empty row)')
      );
      expect(rowsWithoutReason, `${fixture} drew a row that does not say why`).toEqual([]);

      // Zones and sections carry one too, including the headerless bodies Heads up
      // and Today draw — those used to render no chip at all, so their reasons
      // were never format-checked by the loop below.
      const zones = await panel.locator('[data-slot="sidebar-model-zone"]').count();
      const sections = await panel.locator('[data-slot="sidebar-model-section"]').count();
      const reasons = await panel
        .locator('[data-slot="sidebar-model-reason"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-reason') ?? ''));
      expect(reasons.length, `${fixture} has a zone or section with no reason`).toBe(
        rows + zones + sections
      );
      for (const reason of reasons) {
        expect(reason, `${fixture} has a malformed reason`).toMatch(/^[a-z-]+:[a-z-]+$/);
      }
    }
  });

  test('a folded section keeps the signal folding it hid', async ({ page }) => {
    await openShowcase(page);

    // `power` folds Library → Channels with a rollup of `{ activity, working: 3 }`.
    // Both halves have to survive the fold (BC-31), and they survive in two
    // different places: the working count is a dot in the trailing slot, and the
    // `activity` tier is the label going bold — no badge, no dot, because a
    // third weight is exactly what the two-tier system refuses (§18). The page
    // showed only the dot until `SectionHeader` gained `emphasized`.
    const channels = page.locator(
      '[data-slot="sidebar-model-panel"][data-fixture="power"] [data-slot="sidebar-model-section"][data-section="channels"]'
    );
    const header = channels.getByRole('button', { name: 'Channels' });
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(header, 'a folded section holding unread activity reads as quiet').toHaveClass(
      /font-semibold/
    );
    await expect(channels.getByLabel('3 agents working')).toBeVisible();

    // And the tier really is `activity`, so the absence of a badge is the
    // decision rather than an oversight.
    await expect(channels.locator('[data-slot="sidebar-model-directed-badge"]')).toHaveCount(0);

    // Expanding gives the signal back to the rows, so the header stops carrying
    // it — the rollup is a stand-in for what folding hid, not a second badge.
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(header).not.toHaveClass(/font-semibold/);
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

      // ── Coverage, before correctness ──
      //
      // Asserted FIRST and page-relatively, because axe reports success for a
      // page it never looked at. Both checks below move with the page: they
      // cannot be satisfied by a page that outgrew the viewport, which an
      // absolute floor could be. See PAGE_MUST_FIT_VIEWPORT.
      await expectPageFitsViewport(page);
      const results = await runAxe(page);
      await expectEveryReasonChipEvaluated(page, results);

      const contrast = results.violations.filter((violation) => violation.id === 'color-contrast');
      const contrastNodes = contrast.flatMap((violation) => violation.nodes);
      const dimmed = await countUnderDimming(
        page,
        contrastNodes.map((node) => node.target.join(' '))
      );

      // Everything that is NOT the quarantined dimming must be clean.
      expect(
        contrastNodes.length - dimmed === 0 ? [] : contrast.map(describeViolation),
        `label-on-zone-tint must meet 4.5:1 in the ${theme} theme (design-system §Accessibility)`
      ).toEqual([]);
      expect(
        dimmed,
        'the dimmed-row contrast defect changed shape — either DOR-1098 landed, in which case delete QUARANTINED_DIMMED_ROWS and this assertion, or something new is dimming text'
      ).toBe(QUARANTINED_DIMMED_ROWS);

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
      //
      // **Matched on what makes it an unread badge, not on which component
      // drew it, and read off the node axe reported rather than off a selector
      // resolved again.** The allowance used to name the showcase's own
      // stand-in (`sidebar-model-directed-badge`) and look it up by
      // `querySelector` — which silently answers `null` for a target axe
      // reports as more than one selector, so the filter counted nothing and
      // the gate failed with no explanation. `node.html` is the element itself,
      // as axe saw it.
      const undecided = results.incomplete.flatMap((rule) => rule.nodes);
      // The one-digit counts axe declines to judge, enumerated. Each is a
      // DECISION recorded here rather than an exemption inherited: the panel's
      // directed-unread mark since P1, P4's mobile Home badge, and Catch up's
      // "how many" — the last of which only appeared once the Catch-up showcase
      // started drawing a real button instead of an empty box, which is what a
      // showcase is for.
      //
      // **The mobile badge was measured before it was pinned, and the measuring
      // changed it.** As drawn first — white on amber-500 — it was 2.15:1, a
      // serious failure that would have hidden inside this list precisely
      // because axe cannot judge two-character text. It is amber-950 on
      // amber-500 now: 6.97:1, in both themes, since the pill carries its own
      // background. Catch up's count went the same way: 3.24:1 at `/50`, and
      // `/70` once anyone looked. **Every count admitted here is measured
      // below** — one that is not is a colour nothing checks.
      //
      // **Matched on the node axe reported, not on a selector resolved again.**
      // `document.querySelector` silently answers `null` for a target axe
      // reports as more than one selector — which is most of them once this
      // page grew past its first fold — so a `closest()` filter counted nothing
      // and the gate failed naming elements it had in fact been handed.
      const isCountBadge = (text: string) =>
        /data-slot="sidebar-model-directed-badge"/.test(text) ||
        /aria-label="\d+ unread"/.test(text) ||
        /data-testid="mobile-tab-badge-/.test(text) ||
        /data-slot="catch-up-count"/.test(text);
      const badges = undecided.filter(
        (node) => isCountBadge(node.html) || isCountBadge(node.target.join(' '))
      ).length;
      expect(
        undecided.length - badges,
        `axe could not judge something new in the ${theme} theme: ${undecided
          .map((node) => `${node.target.join(' ')} :: ${node.html}`)
          .join(' | ')}`
      ).toBe(0);

      // **What the pin above costs, paid back.** Forgiving a badge from the
      // undecided list leaves its colours guarded by nothing — axe declines to
      // judge two-character text, so "not a violation" says nothing about it.
      // That is not hypothetical: the mobile badge shipped white-on-amber at
      // 2.15:1 and this list is where it hid.
      //
      // **Scoped to the badge this task pinned**, not to both families. The
      // panel's own directed badge is translucent (`bg-brand/15`), so judging it
      // means compositing it over whatever is behind it — a different and
      // larger job, and it is no less guarded than it was before P4 touched
      // this pin.
      //
      // **Colours are read as pixels, never parsed as text.** Tailwind v4 emits
      // `oklch()`, and a regex pulling the first three numbers out of
      // `oklch(0.769 0.188 70.08)` reads them as RGB — which scored
      // white-on-amber at 19.26:1 and made the first version of this check
      // incapable of failing. A 1×1 canvas makes the browser do the conversion.
      const badgeContrast = await page.evaluate((selector) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        const pixel = (value: string): [number, number, number, number] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return [r!, g!, b!, a! / 255];
        };
        const channel = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const luminance = ([r, g, b]: number[]) =>
          0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
        return [...document.querySelectorAll(selector)].map((node) => {
          const style = getComputedStyle(node);
          const fg = pixel(style.color);
          const bg = pixel(style.backgroundColor);
          const [a, b] = [luminance(fg), luminance(bg)];
          return {
            text: node.textContent ?? '',
            opaque: bg[3] === 1 && fg[3] === 1,
            ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
          };
        });
      }, '[data-testid^="mobile-tab-badge-"]');

      // Observable half first: there ARE badges on this page, so the bars below
      // cannot be cleared by a page that happens to draw none.
      expect(badgeContrast.length, 'no mobile count badges on the page to check').toBeGreaterThan(
        0
      );
      // …and each carries its own opaque background, which is what makes the
      // ratio above a complete answer rather than one missing a backdrop.
      expect(badgeContrast.filter((badge) => !badge.opaque)).toEqual([]);
      expect(
        badgeContrast.filter((badge) => badge.ratio < 4.5),
        `a count badge axe could not judge is below 4.5:1 in the ${theme} theme`
      ).toEqual([]);

      // **The same debt for the one count that is NOT on its own pill.** Catch
      // up's number is translucent text over whatever it sits on, so the
      // opaque-pair check above cannot judge it: it has to be composited first.
      // Admitting it to the pin without this would be the exact trade the
      // mobile badge nearly shipped behind.
      const countContrast = await page.evaluate((selector) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        const pixel = (value: string): [number, number, number, number] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return [r!, g!, b!, a! / 255];
        };
        const channel = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const luminance = ([r, g, b]: number[]) =>
          0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
        /** The first ancestor that actually paints something behind this one. */
        const backdrop = (node: Element): [number, number, number, number] => {
          for (let el: Element | null = node; el !== null; el = el.parentElement) {
            const painted = pixel(getComputedStyle(el).backgroundColor);
            if (painted[3] === 1) return painted;
          }
          return [255, 255, 255, 1];
        };
        return [...document.querySelectorAll(selector)].map((node) => {
          const fg = pixel(getComputedStyle(node).color);
          const bg = backdrop(node);
          // Source-over: the text's own alpha, laid on what is behind it.
          const composited = [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3]));
          const [a, b] = [luminance(composited), luminance(bg)];
          return {
            text: node.textContent ?? '',
            ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
          };
        });
      }, '[data-slot="catch-up-count"]');

      expect(countContrast.length, 'no Catch-up counts on the page to check').toBeGreaterThan(0);
      expect(
        countContrast.filter((count) => count.ratio < 4.5),
        `Catch up's count is below 4.5:1 in the ${theme} theme`
      ).toEqual([]);
    });
  }
});
