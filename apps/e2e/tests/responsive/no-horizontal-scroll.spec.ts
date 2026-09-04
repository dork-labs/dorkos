import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * Nothing escapes its container on a phone (DOR-1747).
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
 * text painting outside a box that does not clip is reported. Across all eight
 * routes it reports nothing today, and reports the Workspaces line the moment
 * the path goes back into the sentence.
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
 * The narrowest phone viewport this suite watches. Defined locally rather
 * than imported from the rooms suite's helper — a shared viewport constant
 * would be a fine addition later, but this responsive suite has no reason to
 * depend on an unrelated suite's module for one number.
 */
const PHONE = { width: 390, height: 844 } as const;

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

test.describe('Responsive — nothing escapes its container at 390px @smoke', () => {
  test.use({ viewport: PHONE });

  for (const route of ROUTES) {
    test(`${route} contains its own content`, async ({ page, basePage }) => {
      await basePage.goto(route);
      await basePage.waitForAppReady();
      // The shell mounting is not the route having anything in it — an API
      // that never answers still passes `app-shell`. Settle network first so
      // the sample below looks at real content rather than a skeleton.
      await page.waitForLoadState('networkidle');

      const worst = await worstHorizontalOverflow(page);
      const { escapes, textLeaves } = await escapedText(page);

      expect(
        textLeaves,
        `${route} rendered only ${textLeaves} text-bearing elements — ` +
          `too few to trust this sample (floor ${MIN_TEXT_LEAVES}); the route ` +
          `likely never loaded its data`
      ).toBeGreaterThanOrEqual(MIN_TEXT_LEAVES);
      expect(escapes, `${route} paints content outside its container`).toEqual([]);
      expect(worst, `${route} scrolled ${worst}px past ${PHONE.width}px`).toBe(0);
    });
  }
});
