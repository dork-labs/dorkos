import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { PHONE } from '../rooms/room-sheet-helpers';

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
 * Every leaf element whose text is wider than the box drawn for it, while
 * nothing clips that box — one printable line each, so a failure names the
 * component to fix rather than only the route it happened on.
 *
 * Leaves only, and never a positioned one: a parent is wide because its child
 * is, and an out-of-flow decoration is allowed to sit past its parent's edge.
 *
 * @param page - The page to inspect.
 * @returns Up to five descriptions of text that escaped its container.
 */
async function escapedText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length > 0) continue;
      const text = (el.textContent ?? '').trim();
      if (!text) continue;
      const style = getComputedStyle(el);
      // `hidden`/`auto`/`scroll`/`clip` all contain their content on purpose —
      // truncation and scrollers live there.
      if (style.overflowX !== 'visible') continue;
      if (style.position === 'absolute' || style.position === 'fixed') continue;
      const overshoot = el.scrollWidth - el.clientWidth;
      if (overshoot <= 1) continue;
      const classes = el.getAttribute('class')?.slice(0, 70) ?? '';
      out.push(
        `+${overshoot}px <${el.tagName.toLowerCase()} class="${classes}"> "${text.slice(0, 50)}"`
      );
      if (out.length === 5) break;
    }
    return out;
  });
}

test.describe('Responsive — nothing escapes its container at 390px @smoke', () => {
  test.use({ viewport: PHONE });

  for (const route of ROUTES) {
    test(`${route} contains its own content`, async ({ page, basePage }) => {
      await basePage.goto(route);
      await basePage.waitForAppReady();

      const worst = await worstHorizontalOverflow(page);
      const escaped = await escapedText(page);

      expect(escaped, `${route} paints text outside its container`).toEqual([]);
      expect(worst, `${route} scrolled ${worst}px past ${PHONE.width}px`).toBe(0);
    });
  }
});
