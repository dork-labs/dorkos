import { test, expect } from '../../fixtures';
import { ChatPage } from '../../pages/ChatPage.js';
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

/**
 * Sub-pixel layout rounding is not a clip, for the offer's own bounds check.
 *
 * Wider than {@link OVERLAP_SLACK_PX}: that constant covers ONE level of flex
 * (siblings in the status line's own row), and this check crosses three
 * (`make-default-slot` → the offer `<p>` → its action `<span>`), each of which
 * can round a fractional width independently. Measured on the fixed component,
 * a real reading came in 1.02–1.52px "past" its own row with nothing painting
 * over anything and nothing unclickable — the row carries no `overflow`
 * class, so a sub-pixel spill here is invisible and irrelevant, unlike the bug
 * this file exists to catch (29–80px, behind a real `overflow-hidden`).
 */
const ROW_FIT_SLACK_PX = 2;

/**
 * One measured action button: its label (for failure messages) and box.
 */
interface MeasuredAction {
  /** What to call it in a failure message. */
  label: string;
  /** The button's own border box, or `null` if it could not be measured. */
  box: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Assert that every action in {@link actions} stays inside `rowBox` and the
 * `width`-px viewport — the property `MakeDefaultStopLine` owes regardless of
 * which of its two homes (the popover's inline row, or the composer's
 * floating overlay) is drawing it.
 *
 * @param actions - The buttons to check, each already located and measured.
 * @param rowBox - The offer's own row — the immediate ancestor the actions
 *   must never spill past.
 * @param width - The viewport width this reading was taken at.
 */
function expectActionsInBounds(
  actions: readonly MeasuredAction[],
  rowBox: { x: number; width: number } | null,
  width: number
) {
  expect(rowBox, 'the offer must be laid out to measure it').not.toBeNull();
  for (const { label, box } of actions) {
    expect(box, `${label} must be laid out to measure it`).not.toBeNull();
    const right = box!.x + box!.width;
    expect(
      right,
      `${label} must stay inside the offer's own row at ${width}px`
    ).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + ROW_FIT_SLACK_PX);
    expect(
      box!.x,
      `${label} must not start left of the ${width}px viewport`
    ).toBeGreaterThanOrEqual(-ROW_FIT_SLACK_PX);
    expect(right, `${label} must stay inside the ${width}px viewport`).toBeLessThanOrEqual(
      width + ROW_FIT_SLACK_PX
    );
  }
}

/**
 * The "start every new session here?" offer never clips its own actions
 * (DOR-1270).
 *
 * `MakeDefaultStopLine` used to share one `truncate` element between its
 * sentence and its two actions, so the longest stop label — "Full autonomy" —
 * pushed `Make default` and `Dismiss` past the clipped edge. The buttons were
 * still laid out there, just not painted or hit-tested, so a real click landed
 * on the ancestor instead of the button: `test-results/chat-self-test/
 * 20260816-155308.md` finding 3 measured `Make default` 29px past its own row
 * at 1440px, and both a normal and a forced click failed for 42s.
 *
 * **Reproduces on the INLINE instance, not the overlay.** The offer has two
 * homes (`MakeDefaultStopLineProps.placement`): floating full-width over the
 * composer once the picker's popover has closed, or inline inside that
 * popover's fixed `w-80` (≈296px) content while it is open. The full-width
 * overlay has room to spare at every width this file checks — measured at
 * 1110px available at 1440px, 570px at 900px — so it never reproduces the
 * finding. The 296px popover does not have that room: measured pre-fix, the
 * actions ran to x≈1453 in a 1440px window (viewport) and x≈949 in a 900px
 * one, both well past their own row. The self-test's own report is consistent
 * with this — reopening the picker to re-check the dial is exactly the extra
 * step that would have put the offer inline where the finding's numbers land.
 * So each width below drives BOTH placements, and the property must hold in
 * either.
 */
test.describe('Chat — the make-default offer keeps its actions reachable (DOR-1270)', () => {
  // Every sub-test writes the same three server-global config leaves —
  // `ui.statusBar.pins` (to put a normally-quiet item in the row), and
  // `ui.autonomyAcknowledgedAt` / `runtimes.defaultTrustStop` (the offer's own
  // write). Serial for the same reason `sidebar-groups.spec.ts` is: fullyParallel
  // would otherwise let two of these three widths race the same config file.
  test.describe.configure({ mode: 'serial' });

  test.afterEach(async ({ request }) => {
    await request
      .patch('/api/config', {
        data: {
          ui: { statusBar: { pins: [] }, autonomyAcknowledgedAt: null },
          runtimes: { defaultTrustStop: null },
        },
      })
      .catch(() => {});
  });

  for (const width of [520, 900, 1440] as const) {
    test.describe(`at ${width}px`, () => {
      test.use({ viewport: { width, height: 900 } });

      test('both actions stay in the row, and Make default reaches the server', async ({
        page,
        request,
      }) => {
        // Permissions is quiet by default (spec `trust-dial` — the mode has not
        // been moved off "Default" yet) and this file's other tests never touch
        // it, so pin it the same way the Session panel's own pin toggle would:
        // every width below needs it in the row to reach the dial at all.
        const pinned = await request.patch('/api/config', {
          data: { ui: { statusBar: { pins: ['permission'] } } },
        });
        expect(pinned.ok()).toBe(true);

        const chatPage = new ChatPage(page);
        await chatPage.goto();

        const trigger = page.getByRole('button', { name: /^Permissions:/ });
        await expect(trigger).toBeVisible();
        await trigger.click();

        // The flow `/chat:self-test live` used: move the dial to Full
        // autonomy, the longest stop label and the one the finding reproduced.
        await page.getByRole('radio', { name: 'Full autonomy' }).click();
        // The session's own consent door (`AutonomyConfirmDialog`) — a mode
        // that never asks needs an acknowledgement before the write is even
        // attempted. Closing it is also what closes the picker's popover
        // (a modal dialog's focus grab), which is why the offer that follows
        // is the OVERLAY instance, not the inline one.
        await page.getByRole('button', { name: 'Turn on Full autonomy' }).click();

        const offer = page.getByTestId('make-default-offer');
        await expect(offer).toContainText('Start every new session in Full autonomy?');
        const overlay = page.getByTestId('make-default-slot-overlay');
        await expect(overlay).toBeVisible();

        const overlayBox = await overlay.boundingBox();
        const overlayConfirmBox = await page.getByTestId('make-default-confirm').boundingBox();
        const overlayDismissBox = await page.getByTestId('make-default-dismiss').boundingBox();
        expectActionsInBounds(
          [
            { label: 'the overlay Make default', box: overlayConfirmBox },
            { label: 'the overlay Dismiss', box: overlayDismissBox },
          ],
          overlayBox,
          width
        );

        // The offer's OTHER home: reopen the picker while the offer is still
        // live (it survives ~6s unanswered) so the SAME offer redraws inline,
        // inside the popover's fixed ≈296px content — the width that actually
        // starved `Make default` in the finding (see the block comment above).
        await trigger.click();
        const inlineSlot = page.getByTestId('make-default-slot');
        await expect(inlineSlot).toBeVisible();
        const inlineBox = await inlineSlot.boundingBox();
        const inlineConfirmBox = await page.getByTestId('make-default-confirm').boundingBox();
        const inlineDismissBox = await page.getByTestId('make-default-dismiss').boundingBox();
        expectActionsInBounds(
          [
            { label: 'the inline Make default', box: inlineConfirmBox },
            { label: 'the inline Dismiss', box: inlineDismissBox },
          ],
          inlineBox,
          width
        );

        // Not just laid out in bounds — really clickable, and the click really
        // reaches the server. This is the assertion DOR-1270's own report could
        // not make: a normal and a forced click both failed for 42s with no
        // `PATCH /api/config` ever issued. Clicked from the INLINE instance,
        // the one the finding's own numbers land in.
        const patchRequest = page.waitForRequest(
          (req) => req.method() === 'PATCH' && req.url().includes('/api/config')
        );
        await page.getByTestId('make-default-confirm').click();
        // Making Full autonomy the STANDING default asks a second time — the
        // session's own consent a moment ago was about one conversation, and
        // the server requires a durable acknowledgement for the wider claim
        // (see `useMakeDefaultStop`). Same button, second dialog.
        await page.getByRole('button', { name: 'Turn on Full autonomy' }).click();

        const req = await patchRequest;
        expect(req.postDataJSON()).toMatchObject({ runtimes: { defaultTrustStop: 'autonomy' } });
        await expect(offer).not.toBeVisible();
      });
    });
  }
});
