import { test, expect } from '../../fixtures';
import type { Locator, Page } from '@playwright/test';

/**
 * The composer status line never scrolls and never wraps (spec
 * composer-status-redesign §6.1) — which only leaves one honest failure mode, and
 * for a while it was the dishonest one: the right cluster could not shrink inside
 * an `overflow-hidden` row, so any item wider than the slot budget predicted was
 * clipped away where nobody could reach it. At 375px the bar needed 387px of a
 * 341px row; at 330px it needed 387px of 296px (DOR-452).
 *
 * ## Why this file measures overlap and not `scrollWidth`
 *
 * It used to assert `scrollWidth <= clientWidth` on the row, which cannot fail:
 * the row is `overflow-hidden`, its clusters are `min-w-0` and shrinkable, and
 * its values `truncate`, so the row's scroll width is pinned to its client width
 * whether the content fit or was absorbed. That green check sat over a live
 * defect for a release — two items rendering ~20px and ~40px outside their own
 * boxes and painting on top of their neighbours (DOR-461).
 *
 * So the invariant asserted here is the one a person actually sees: **no item
 * paints over the item beside it**. Each item's painted extent is the union of
 * its own box and every visible descendant's, which is where spilled content
 * really lands — an item's own `getBoundingClientRect()` reports the box it was
 * given, not the pixels it drew outside it. Adjacent extents must not intersect,
 * and no item may paint over the trailing `⋯`.
 */

/** The widths in the bug report, plus a desktop width for the non-degraded case. */
const WIDTHS = [900, 520, 375, 330] as const;

/** Sub-pixel layout rounding is not an overlap. */
const OVERLAP_SLACK_PX = 0.5;

/**
 * The tier floors the playground draws its rows at, widest first — kept in step
 * with `TIER_WIDTHS` in `dev/showcases/status-line-showcase-data`.
 *
 * Asserted rather than assumed: widening a showcase box would otherwise leave
 * this file green while it quietly stopped measuring the floors, which are the
 * only widths where an over-promising budget shows up at all.
 */
const TIER_FLOOR_WIDTHS = [640, 440, 340, 320] as const;

/** The demo box draws a 1px border either side of the row it is sizing. */
const ROW_WIDTH_SLACK_PX = 2;

/** The tier floor a measured row was drawn at, or `null` if it is not at one. */
function tierFloorOf(rowWidth: number): number | null {
  return TIER_FLOOR_WIDTHS.find((w) => Math.abs(w - rowWidth) <= ROW_WIDTH_SLACK_PX) ?? null;
}

/** Longer than `StatusLine`'s 200ms item transition, so a reading lands after it. */
const ITEM_SETTLE_MS = 250;

/** How many settle attempts before calling the line unmeasurable. */
const SETTLE_ATTEMPTS = 12;

/** One measured status item: the box it was given and the pixels it drew. */
interface MeasuredItem {
  /** `status-item-<key>`, or `status-reveal` for the trailing anchor. */
  testid: string;
  /** Which of the row's clusters holds it — items only sit beside their own. */
  cluster: number;
  /** Left edge of the item's own border box. */
  boxLeft: number;
  /** Right edge of the item's own border box. */
  boxRight: number;
  /** Leftmost pixel the item or any visible descendant occupies. */
  paintedLeft: number;
  /** Rightmost pixel the item or any visible descendant occupies. */
  paintedRight: number;
}

/** One measured status line: the items it drew, left to right. */
interface MeasuredLine {
  /** Zero-based index of the line on the page (a playground page has several). */
  index: number;
  /** The row's own measured width — which tier floor this reading was taken at. */
  rowWidth: number;
  /** Every settled item plus the trailing anchor, ordered by cluster then position. */
  items: MeasuredItem[];
}

/**
 * Measure every status line on the page, item by item, left to right.
 *
 * Runs in the page because the union of a subtree's client rects is not
 * something Playwright's `boundingBox()` can express: it reports the element's
 * own box, which is exactly the box an overflowing item lies about.
 *
 * Two things it deliberately does not trust. **DOM order** — `AnimatePresence`
 * keeps an exiting item at its old index, so the document order of the right
 * cluster is not its visual order while the promoted set changes; items are
 * ordered by cluster and then by measured position instead. **Items on their way
 * out** — `mode="popLayout"` takes them out of flow (`position: absolute`) and
 * fades them, so they legitimately sit on top of the item that replaced them.
 *
 * @param page - The page holding one or more status lines.
 */
async function measureStatusLines(page: Page): Promise<MeasuredLine[]> {
  return page.evaluate(() => {
    /** Union of the element's box and every visible descendant's. */
    function paintedExtent(root: Element): { left: number; right: number } {
      let left = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      const visit = (el: Element) => {
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          left = Math.min(left, rect.left);
          right = Math.max(right, rect.right);
        }
        for (const child of el.children) visit(child);
      };
      visit(root);
      return { left, right };
    }

    /** Which of the row's children (left cluster, right cluster, `⋯`) holds this item. */
    function clusterIndexOf(line: Element, el: Element): number {
      return [...line.children].findIndex((child) => child === el || child.contains(el));
    }

    return [...document.querySelectorAll('[data-testid="status-line"]')].map((line, index) => ({
      index,
      rowWidth: Math.round(line.getBoundingClientRect().width),
      items: [
        ...line.querySelectorAll<HTMLElement>(
          '[data-testid^="status-item-"], [data-testid="status-reveal"]'
        ),
      ]
        .filter((el) => {
          const style = getComputedStyle(el);
          return style.position === 'static' && Number(style.opacity) > 0.99;
        })
        .map((el) => {
          const box = el.getBoundingClientRect();
          const painted = paintedExtent(el);
          return {
            testid: el.getAttribute('data-testid')!,
            cluster: clusterIndexOf(line, el),
            boxLeft: box.left,
            boxRight: box.right,
            paintedLeft: painted.left,
            paintedRight: painted.right,
          };
        })
        .sort((a, b) => a.cluster - b.cluster || a.boxLeft - b.boxLeft),
    }));
  });
}

/**
 * Measure once the line has stopped moving.
 *
 * Items animate in and out over {@link ITEM_SETTLE_MS}, and `layout="position"`
 * slides the survivors into their new places, so a single reading taken the
 * moment an item becomes visible can catch two of them mid-swap. Two identical
 * readings in a row means the layout is at rest and the numbers mean something.
 *
 * @param page - The page holding one or more status lines.
 */
async function measureSettledStatusLines(page: Page): Promise<MeasuredLine[]> {
  let previous = '';
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    const lines = await measureStatusLines(page);
    const reading = JSON.stringify(lines);
    if (reading === previous) return lines;
    previous = reading;
    await page.waitForTimeout(ITEM_SETTLE_MS);
  }
  throw new Error('the status line never stopped moving, so it could not be measured');
}

/**
 * Assert that every number in the line is drawn whole.
 *
 * Overlap and truncation are different failures and only one of them is
 * geometric: an item marked `data-rigid` renders a number, and a number the row
 * has cut is not a smaller number, it is a wrong one. `12` squeezed to its floor
 * rendered `1` — with the ellipsis clipped too, so it did not even look cut — and
 * every geometric check on this page stayed green through it (DOR-461 review).
 *
 * @param page - The page holding one or more status lines.
 */
async function expectNoTruncatedNumbers(page: Page) {
  const cut = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="status-line"] [data-rigid="true"]')].flatMap(
      (item) =>
        [...item.querySelectorAll('span')]
          .filter((span) => span.children.length === 0 && span.scrollWidth > span.clientWidth + 1)
          .map(
            (span) =>
              `${item.getAttribute('data-testid')}: "${span.textContent?.trim()}" needs ` +
              `${span.scrollWidth}px in ${span.clientWidth}px`
          )
    )
  );
  expect(cut, `a number the row cut is a wrong number:\n${cut.join('\n')}`).toEqual([]);
}

/**
 * Assert that nothing in the line paints over anything else in it.
 *
 * Both readings are collected into one list so a failure reports the whole
 * picture: an item whose content leaves its own box is the defect, and two items
 * whose painted extents intersect is what a person sees because of it.
 *
 * @param lines - Every measured line that should hold the invariant.
 */
function expectNoOverlap(lines: MeasuredLine[]) {
  const violations: string[] = [];

  for (const line of lines) {
    for (const item of line.items) {
      const over = item.paintedRight - item.boxRight;
      if (over > OVERLAP_SLACK_PX) {
        violations.push(
          `line ${line.index}: ${item.testid} paints ${Math.round(over)}px past its own box`
        );
      }
    }
    for (let i = 1; i < line.items.length; i++) {
      const left = line.items[i - 1]!;
      const right = line.items[i]!;
      const into = left.paintedRight - right.paintedLeft;
      if (into > OVERLAP_SLACK_PX) {
        violations.push(
          `line ${line.index}: ${left.testid} paints ${Math.round(into)}px into ${right.testid}`
        );
      }
    }
  }

  expect(
    violations,
    `every item must stay inside its own box and off its neighbour:\n${violations.join('\n')}`
  ).toEqual([]);
}

/** The `⋯` — the anchor for everything the width budget dropped. */
function revealTrigger(page: Page): Locator {
  return page.locator('[data-testid="status-line"] [data-testid="status-reveal"]');
}

// Deliberately NOT `@integration`, which it used to carry. That tag means "needs
// a real model", and it is now what keeps a spec out of CI — so wearing it
// without needing it costs coverage for nothing. Nothing below sends a message,
// sets a scenario, or waits on a turn: the file opens the composer and measures
// where the status line paints. It passes with no credentials of any kind.
//
// Onboarding is NOT dismissed here, deliberately (DOR-1223). This file used to
// open with a `beforeAll` that PATCHed `onboarding.dismissedAt` to `now` on every
// run — an unconditional overwrite of a real timestamp, with no restore, against
// whatever `DORK_HOME` the leg happened to hold. `global-setup.ts` already does
// the same job once per run, for every API leg, and does it read-before-write so
// a home that was already onboarded is left exactly as it was. A second,
// unconditional copy of that write bought this file nothing and cost the
// operator a stomped field.
test.describe('Chat — status line fits its row', () => {
  for (const width of WIDTHS) {
    test.describe(`at ${width}px`, () => {
      // Touch emulation is what puts the `⋯` on its 44px coarse-pointer target, so
      // the width and the hit area are asserted under the same conditions a phone
      // actually reports.
      test.use({ viewport: { width, height: 780 }, hasTouch: true });

      test('never clips its items, and keeps the reveal anchor tappable', async ({ chatPage }) => {
        const statusLine = chatPage.page.locator('[data-testid="status-line"]');
        await expect(statusLine).toBeVisible();

        // The model item always promotes, so it is the signal that the line has
        // real content rather than an empty row that trivially fits.
        await expect(chatPage.page.locator('[data-testid="status-item-model"]')).toBeVisible();
        expectNoOverlap(await measureSettledStatusLines(chatPage.page));

        // The runtime item resolves from a second query; re-measure once it lands,
        // because two items side by side is exactly what overflowed before.
        await expect(chatPage.page.locator('[data-testid="status-item-runtime"]')).toBeVisible();
        expectNoOverlap(await measureSettledStatusLines(chatPage.page));

        const reveal = revealTrigger(chatPage.page);
        await expect(reveal).toBeVisible();
        const hitArea = await reveal.boundingBox();
        expect(hitArea).not.toBeNull();
        expect(hitArea!.width).toBeGreaterThanOrEqual(44);
        expect(hitArea!.height).toBeGreaterThanOrEqual(44);
      });
    });
  }

  test.describe('under content it was never budgeted for', () => {
    test.use({ viewport: { width: 375, height: 780 }, hasTouch: true });

    test('truncates with an ellipsis instead of clipping', async ({ chatPage }) => {
      // The budget counts slots, and a count is a prediction. This drives the row
      // past any prediction — six more items carrying absurd values — to prove the
      // failure mode is a visible ellipsis and not silently unreachable content.
      const statusLine = chatPage.page.locator('[data-testid="status-line"]');
      await expect(chatPage.page.locator('[data-testid="status-item-model"]')).toBeVisible();

      const overflowingValues = await statusLine.evaluate((line) => {
        const rightCluster = line.children[1];
        const template = rightCluster.querySelector('[data-testid="status-item-model"]');
        if (!template) throw new Error('no right-cluster item to clone');
        for (let i = 0; i < 6; i++) {
          const clone = template.cloneNode(true) as HTMLElement;
          clone.setAttribute('data-testid', `status-item-stress-${i}`);
          const value = clone.querySelector('span.truncate');
          if (value) value.textContent = `Absurdly Verbose Status Value ${i}`;
          rightCluster.appendChild(clone);
        }
        return [...rightCluster.querySelectorAll('span.truncate')].filter(
          (el) => el.scrollWidth > el.clientWidth
        ).length;
      });

      expect(
        overflowingValues,
        'values too wide for the row must show an ellipsis'
      ).toBeGreaterThan(0);
      await expect(revealTrigger(chatPage.page)).toBeVisible();
    });
  });
});

/**
 * The tier floors, under a session where every promotion rule has fired at once.
 *
 * A live cockpit session is healthy: two or three items promote and any budget
 * fits them, so the real chat above can only prove the invariant holds for the
 * calm case. The Dev Playground runs the same pipeline
 * (`buildStatusItemNodes` → `selectPromotedItems` → `resolveStatusBudget` →
 * `applyStatusBudget` → `StatusLine`) over a degraded session at each tier's
 * floor — the narrowest bar a tier may draw its widest content in, which is
 * where DOR-461's overlap lived and the only place it is reproducible on demand.
 */
test.describe('Status line — the tier floors, under a degraded session', () => {
  test.use({ viewport: { width: 1400, height: 1000 } });

  /** Rows the status-line sections of the playground's chat page render. */
  const MIN_ROWS = 9;

  test('no item paints over its neighbour at any tier floor', async ({ page }) => {
    await page.goto('/dev/chat', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="status-line"]').first().waitFor({ timeout: 30_000 });
    // The rows mount progressively as the playground's sections render, and the
    // items animate in. Settle on a stable count before measuring, so a run can
    // never pass by measuring two rows that happened to be laid out already.
    await expect
      .poll(() => page.locator('[data-testid="status-line"]').count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(MIN_ROWS);
    await expect(page.locator('[data-testid="status-item-context"]').first()).toBeVisible();

    const lines = await measureSettledStatusLines(page);
    // A vacuous pass is the failure mode this whole file exists to remove, and
    // there are three ways to get one. Too few rows; rows that are not crowded;
    // and rows measured at some width that is not a tier floor, which is the one
    // width where a budget can be caught over-promising. All three fail loudly.
    expect(lines.length).toBeGreaterThanOrEqual(MIN_ROWS);
    expect(
      Math.max(...lines.map((line) => line.items.length)),
      'the degraded rows must carry a crowded line'
    ).toBeGreaterThanOrEqual(7);
    const floors = lines.map((line) => tierFloorOf(line.rowWidth));
    expect(
      lines.filter((line, i) => floors[i] === null).map((line) => line.rowWidth),
      'every row must be drawn at a tier floor'
    ).toEqual([]);
    expect(
      [...new Set(floors)].sort((a, b) => b! - a!),
      'every tier floor must be among the rows measured'
    ).toEqual([...TIER_FLOOR_WIDTHS]);
    // The `⋯` is measured too: it is the one thing the line may never drop, so an
    // item painting over it is exactly as bad as an item painting over an item.
    expect(
      lines.every((line) => line.items.some((i) => i.testid === 'status-reveal')),
      'the reveal anchor must be in every measured row'
    ).toBe(true);

    expectNoOverlap(lines);
    await expectNoTruncatedNumbers(page);
  });
});
