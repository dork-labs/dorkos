import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * Nothing escapes its container on a phone or a tablet (DOR-1747, DOR-1816).
 *
 * The rule this pins is one line long: no content may leave its container or
 * make the page scroll sideways. It is broken by one thing over and over — a
 * long unbroken string (a filesystem path, a URL, a session id, a branch name)
 * rendered with nothing to contain it. The Workspaces empty state shipped
 * exactly that: it interpolated the workspaces folder into a sentence, and
 * since a path has no spaces the browser had nowhere to wrap, so the string ran
 * out of the card and across the screen.
 *
 * **Two assertions, because the obvious one alone would have missed it.**
 * Measured on the real defect: the document did NOT scroll sideways, because an
 * ancestor route panel clips its own overflow — the text simply painted over
 * whatever was beside it and was cut off at the window edge. So the page-level
 * check is kept (it is the rule as written, and it catches a genuinely too-wide
 * layout), and beside it sits the check that actually fires on this defect: a
 * leaf element whose text is wider than its own box while nothing clips it.
 *
 * That second check is quiet by construction. Truncation sets `overflow:hidden`
 * to earn its ellipsis, a scroller sets `auto`, and both are skipped — only
 * text painting outside a box that does not clip is reported. Across the
 * sixteen route×width cells it reports one escape today (see
 * {@link EXPECTED_ESCAPES}), and it reports the Workspaces line the moment the
 * path goes back into the sentence.
 *
 * **Every route is judged at two widths, and the second is not a formality**
 * (DOR-1816). See {@link WIDTHS}: DOR-1747's own review found a real escape
 * that only exists at 768px, and this file could not have caught it. The
 * tablet pass found another one on its first run — see {@link EXPECTED_ESCAPES}
 * — which is the answer to whether it was worth adding.
 *
 * **What it costs, measured rather than estimated.** Back-to-back on one
 * machine at `--workers=2`: the eight phone cases sum to 38.1s of test time
 * and finish in 33.3s of wall clock; all sixteen sum to 72.8s and finish in
 * 49.5s. So the sum went up 1.9× and nothing else did — the cost is in the
 * cases, not in some per-run overhead that would have made this a bad trade.
 * CI runs one worker per shard, where the sum IS the wall clock: about 35
 * extra seconds on a shard that already takes ~16 minutes. Nothing is sampled
 * or sharded away to pay for it: a guard that quietly checked half its routes
 * would be worse than one that honestly checked one width.
 *
 * **Only a laid-out page can catch any of this.** jsdom reports every element
 * as 0×0 and has no viewport, so a unit test can assert that a `truncate` class
 * is present and nothing more. It can never see the pixel that escaped. Both
 * assertions are deliberately about the DOCUMENT rather than about any one
 * component: the next instance of this defect will be in a component nobody has
 * written yet, and a document-level check finds it without being told where to
 * look.
 *
 * Chrome only, no turns, no seeded state: this is layout, so it is `@smoke`.
 */

/**
 * The two widths every route is judged at. Defined locally rather than
 * imported from the rooms suite's helper — a shared viewport constant would be
 * a fine addition later, but this responsive suite has no reason to depend on
 * an unrelated suite's module for two numbers.
 *
 * **The tablet width is not an extrapolation of the phone one** (DOR-1816).
 * DOR-1747's own review found a real, previously-invisible escape by measuring
 * at exactly 768×1024 — the marketplace card's author/source row had a
 * `min-w-[6.5rem]` floor that painted past the card's edge on 306 of 306 cards
 * — and it found it at that width and not at 390, because 768 is where the
 * sidebar docks and the page's usable width stops being the window's. That
 * review asked for this sweep and it was deferred as its own pass, because it
 * doubles the route×width matrix.
 *
 * 768 exactly, not 767 or 800: it is Tailwind's `md` breakpoint, so it is the
 * first width at which every `md:` rule in the app is live. A defect at the
 * boundary is a defect in the rule that just turned on.
 */
const WIDTHS = [
  { name: 'phone', viewport: { width: 390, height: 844 } },
  { name: 'tablet', viewport: { width: 768, height: 1024 } },
] as const;

/** Every destination in the sidebar, plus the ones the home tab bar owns. */
const ROUTES = [
  '/',
  '/activity',
  '/tasks',
  '/workspaces',
  '/team',
  '/channels',
  '/connections',
  '/marketplace',
] as const;

/** How long each route is watched before it is judged. */
const SAMPLE_WINDOW_MS = 2500;

/** How often it is measured inside that window. */
const SAMPLE_EVERY_MS = 250;

/**
 * The widest the document has ever been past its own viewport, in CSS pixels.
 *
 * Sampled across {@link SAMPLE_WINDOW_MS} rather than read once: every route
 * fills in as data lands, and the offending string usually arrives with it, so
 * a single measurement taken the moment the shell mounts would pass on an
 * empty page and prove nothing.
 *
 * @param page - The page to watch.
 * @returns 0 when the page never scrolled sideways; the worst overshoot otherwise.
 */
async function worstHorizontalOverflow(page: Page): Promise<number> {
  const measure = () =>
    page.evaluate(() => {
      const root = document.documentElement;
      return Math.max(
        root.scrollWidth - root.clientWidth,
        document.body.scrollWidth - root.clientWidth
      );
    });

  let worst = await measure();
  const deadline = Date.now() + SAMPLE_WINDOW_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(SAMPLE_EVERY_MS);
    worst = Math.max(worst, await measure());
  }
  return worst;
}

/**
 * Every element whose own painted box reaches past its immediate parent's
 * box, on a parent that is not managing its overflow on purpose — plus a
 * census of how much of the page was actually there to look at.
 *
 * The first cut of this probe only looked at leaves (no element children)
 * whose own `overflow-x` was `visible`, and compared `scrollWidth` to
 * `clientWidth`. Both restrictions had a blind spot big enough to drive a
 * defect through:
 *
 * - **Leaves-only** misses a wrapper that is too wide for a reason that has
 *   nothing to do with its own content — a `min-width` floor on a flex child,
 *   for instance (DOR-1747). The wrapper has element children, so the old
 *   probe never looked at it, even though the wrapper's own box is exactly
 *   what painted past the card.
 * - **`scrollWidth`/`clientWidth`** report `0`/`0` for an element whose
 *   layout box is inline — the most common way this app renders a path — so
 *   the subtraction is always `0` and the element can never fail no matter
 *   how far it overshoots.
 *
 * This version walks every element and asks a narrower, more literal
 * question: does this element's painted box reach past its own parent's box?
 * `getClientRects()` is used instead of a single bounding box so a
 * multi-line inline element is judged one line at a time — the union of a
 * three-line wrap is wider than any one line, and would falsely accuse an
 * element that never actually painted past anything. A parent whose own
 * `overflow-x` is not `visible` (`hidden`, `clip`, `auto`, `scroll`) is
 * managing wider content on purpose — truncation and scrollers live there —
 * so a child that is nominally wider than that parent is excluded; nothing
 * paints outside it. Positioned elements (`absolute`/`fixed`) are excluded
 * the same way: an out-of-flow decoration is allowed to sit past its
 * in-flow parent's edge. So is an element with a negative right margin — a
 * sticky section header bleeding edge-to-edge with `-mx-4` is the same
 * technique on purpose, canceling exactly the padding its own parent adds,
 * and it never reaches past the *viewport*, which `worstHorizontalOverflow`
 * below still watches for.
 *
 * @param page - The page to inspect.
 * @returns Up to five descriptions of boxes that escaped their parent, plus
 *   `textLeaves`, the number of elements found to directly own rendered text
 *   — the census a caller uses to tell "the route had nothing to say" apart
 *   from "the route said a lot and none of it escaped".
 */
async function escapedText(page: Page): Promise<{ escapes: string[]; textLeaves: number }> {
  return page.evaluate(() => {
    const escapes: string[] = [];
    let textLeaves = 0;

    for (const el of document.querySelectorAll('body *')) {
      // Census: how much of the route actually rendered, independent of
      // whether any of it escapes — a route that found five of these found
      // nothing, and the caller asserts a floor on that.
      const ownsText = Array.from(el.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0
      );
      if (ownsText) textLeaves++;

      const parent = el.parentElement;
      if (!parent) continue;
      const style = getComputedStyle(el);
      if (style.position === 'absolute' || style.position === 'fixed') continue;
      if (parseFloat(style.marginRight) < 0) continue; // deliberate bleed, e.g. `-mx-4`
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.overflowX !== 'visible') continue;

      const rects = el.getClientRects();
      if (rects.length === 0) continue; // display:none / display:contents — no box to escape with
      const parentBox = parent.getBoundingClientRect();
      let worst = 0;
      for (const rect of rects) {
        worst = Math.max(worst, rect.right - parentBox.right);
      }
      const overshoot = Math.round(worst);
      if (overshoot <= 1) continue;

      const classes = el.getAttribute('class')?.slice(0, 70) ?? '';
      const text = (el.textContent ?? '').trim().slice(0, 50);
      escapes.push(`+${overshoot}px <${el.tagName.toLowerCase()} class="${classes}"> "${text}"`);
      if (escapes.length === 5) break;
    }

    return { escapes, textLeaves };
  });
}

/**
 * The fewest text-owning elements a real, data-loaded route renders on this
 * suite's eight routes. Measured against a server that never answered — an
 * all-skeleton run — every route stayed under 15; a real run starts at 16
 * and climbs into four figures. The floor sits between the two so a route
 * that quietly rendered nothing fails loudly instead of reporting a clean
 * `escapes: []` for a page with nothing on it to escape from.
 */
const MIN_TEXT_LEAVES = 16;

/** One escape this guard already knows about — see {@link EXPECTED_ESCAPES}. */
interface ExpectedEscape {
  /**
   * Enough of the escape's own description to name the box it is about.
   *
   * The tag and its class list, which identifies WHICH element escaped. The
   * size deliberately lives in {@link maxOvershootPx} instead of here: matching
   * on `+4px` too would make a one-pixel change of layout rounding read as "the
   * escape was fixed", and this file would then fail for a reason nobody did
   * anything about.
   */
  fragment: string;
  /** The most it may escape by, in CSS pixels, before this stops being excused. */
  maxOvershootPx: number;
}

/**
 * How far one escape reported by {@link escapedText} actually escaped.
 *
 * Parsed back out of the description rather than returned alongside it: the
 * probe's answer is what a failure prints, so the number a reader sees and the
 * number this asserts on are the same number by construction.
 *
 * @param escape - One entry from `escapes`.
 * @returns The overshoot in CSS pixels, or `Infinity` when the description does
 *   not start with one — which fails every ceiling rather than passing it.
 */
function overshootOf(escape: string): number {
  const match = /^\+(\d+)px /.exec(escape);
  return match === null ? Number.POSITIVE_INFINITY : Number(match[1]);
}

/**
 * Escapes this guard has already found, reported, and deliberately not fixed
 * here — keyed `route@width`, valued with a fragment of the escape's own
 * description.
 *
 * **An entry is a promise in three directions, and that is what stops this from
 * being a mute button.** An escape naming one of these is not reported, and
 * every other escape on the same page still is. An entry that stops matching
 * fails the test, so the moment somebody fixes the bar this guard goes red and
 * asks for the entry to be deleted — which is the only reliable way an
 * allowance like this ever gets removed. And an entry excuses a SIZE as well as
 * a shape: `fragment` names the box, `maxOvershootPx` says how far it is
 * allowed to escape, so the same box escaping ten times as far is a failure
 * rather than a fact this file already knew.
 *
 * ── `/` at 768px — Home's bar overflows its own row by ~4px (DOR-1816) ──
 *
 * Measured: the cross-fade wrapper that holds the route's bar gets 293px of the
 * header, and its children want 297.3px. Nothing in the row will yield the
 * difference, and each refusal is deliberate: `BarTabStrip` is already at the
 * `min-w-28` floor DOR-1748 gave it, the chips zone is `shrink-0`, and
 * `RoomRunState` reserves ~70px whether or not anything is running (its own
 * "reserved-space mechanism (I3)" — an agent picking work up must not move the
 * row). So the health dot, last in the row, paints 4.3px past the wrapper.
 *
 * 768px is the first width at which this can happen at all, which is why no
 * earlier guard saw it: `RoomRunState` draws nothing below the mobile
 * breakpoint by design, so the ~70px it reserves appears for the first time at
 * exactly the width this sweep added.
 *
 * **Not fixed here on purpose.** It is invisible today — the 4.3px lands in the
 * header's own 8px gap and overlaps nothing — and every candidate fix is a
 * product decision about which chip yields on Home's bar, which does not belong
 * in a coverage PR. Recorded in `plans/ui-ux-audit-202609/01-findings.md` and
 * filed under UI/UX Audit 2026-09 instead.
 */
const EXPECTED_ESCAPES: Readonly<Record<string, ExpectedEscape>> = {
  '/@768': {
    fragment: '<div class="flex shrink-0 items-center gap-2">',
    // Measured at 4px. Five is that plus a pixel of rounding — deliberately
    // NOT open-ended: an excuse with no ceiling would go on excusing this
    // escape at 40px and at 400px, which is precisely the regression F1's own
    // recommendation predicts (the overshoot grows the moment the chips do).
    maxOvershootPx: 5,
  },
};

for (const { name, viewport } of WIDTHS) {
  test.describe(`Responsive — nothing escapes its container at ${viewport.width}px @smoke`, () => {
    test.use({ viewport });

    for (const route of ROUTES) {
      test(`${route} contains its own content on a ${name}`, async ({ page, basePage }) => {
        await basePage.goto(route);
        await basePage.waitForAppReady();
        // The shell mounting is not the route having anything in it — an API
        // that never answers still passes `app-shell`. Settle network first so
        // the sample below looks at real content rather than a skeleton.
        await page.waitForLoadState('networkidle');

        // **The width the page BELIEVES it is, not the one Playwright asked
        // for.** Every `md:` rule in the app answers to this media query, and a
        // tablet sweep whose pages resolved it the phone way would be a second
        // phone sweep reporting itself as tablet coverage. It is not
        // hypothetical at exactly 768: a reserved scrollbar takes the viewport
        // below the breakpoint by the width of the scrollbar, and headless
        // Chromium's overlay scrollbars are the only reason it does not here.
        const isTablet = await page.evaluate(() => window.matchMedia('(min-width: 768px)').matches);
        expect(
          isTablet,
          `the ${name} case asked for ${viewport.width}px and the page resolves ` +
            `(min-width: 768px) as ${isTablet} — the layout under test is not the one this ` +
            `case is named for`
        ).toBe(viewport.width >= 768);

        const worst = await worstHorizontalOverflow(page);
        const { escapes, textLeaves } = await escapedText(page);

        // Every message names the width as well as the route: the same route
        // passes at one and fails at the other, so a failure that said only
        // "/marketplace paints content outside its container" would send the
        // reader to reproduce it at whichever width they happened to try.
        expect(
          textLeaves,
          `${route} at ${viewport.width}px rendered only ${textLeaves} text-bearing elements — ` +
            `too few to trust this sample (floor ${MIN_TEXT_LEAVES}); the route ` +
            `likely never loaded its data`
        ).toBeGreaterThanOrEqual(MIN_TEXT_LEAVES);

        const expected = EXPECTED_ESCAPES[`${route}@${viewport.width}`];
        const matched =
          expected === undefined ? [] : escapes.filter((one) => one.includes(expected.fragment));
        const unexpected =
          expected === undefined
            ? escapes
            : escapes.filter((one) => !one.includes(expected.fragment));
        expect(
          unexpected,
          `${route} paints content outside its container at ${viewport.width}px`
        ).toEqual([]);
        if (expected !== undefined) {
          // The second half of the promise EXPECTED_ESCAPES makes. Stated as a
          // count rather than a boolean so a failure prints which way it went:
          // 0 means the escape is gone and the entry is owed a deletion, and
          // anything above 1 means the fragment has stopped naming one thing.
          expect(
            matched.length,
            `${route} at ${viewport.width}px no longer paints the ONE escape ` +
              `EXPECTED_ESCAPES records for it (${expected.fragment}). If it was fixed, delete ` +
              `that entry — it is now hiding whatever escapes this route grows next`
          ).toBe(1);
          // The third half: excused, but not excused without limit. Without
          // this the entry above goes on covering the same box escaping by
          // 40px or 400px, which is the growth F1 itself predicts.
          const worstExcused = Math.max(...matched.map(overshootOf));
          expect(
            worstExcused,
            `${route} at ${viewport.width}px escapes by ${worstExcused}px, and ` +
              `EXPECTED_ESCAPES only excuses it up to ${expected.maxOvershootPx}px. The escape ` +
              `this file already knew about has got worse; it is not the one that was measured`
          ).toBeLessThanOrEqual(expected.maxOvershootPx);
        }

        expect(worst, `${route} scrolled ${worst}px past ${viewport.width}px`).toBe(0);
      });
    }
  });
}
