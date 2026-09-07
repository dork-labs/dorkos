/**
 * The ruler every touch-target spec measures with.
 *
 * **It lives here rather than in one suite's helper file because three suites
 * now need it.** It was written for `tests/rooms/room-sheet-helpers.ts`, and
 * `tests/dashboard-sidebar/mobile-touch.spec.ts` already reached across into
 * the rooms suite to borrow it — the same cross-suite import the responsive
 * guard was told off for in DOR-1747's review and removed. A third borrower
 * (`tests/responsive/touch-reach.spec.ts`, DOR-1816) made that shape permanent,
 * so the ruler moved to `pages/`, where every suite may read from without
 * depending on another suite's module.
 *
 * @module pages/touch-reach
 */
import type { Locator } from '@playwright/test';

/** The smallest thing a thumb can reliably hit, in CSS pixels. */
export const TOUCH_TARGET_PX = 44;

/**
 * How tall a control really is to a finger, including any invisible reach it
 * gives itself.
 *
 * `boundingBox()` answers with the border box, which is the wrong number for
 * anything that widens its own hit area with a pseudo-element — the loudness
 * pill is 32px of visible pill plus 6px of `::after` each way, and a test
 * reading 32 would fail a control that is fine. So the page is *probed*: walk
 * a pixel at a time out from the border box and ask the browser what it would
 * hit, which is the same question a thumb asks.
 *
 * @param locator - The control to measure.
 * @returns Its hit height in CSS pixels.
 */
export async function touchHeight(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    // `contains` covers the element's own children; a pseudo-element hit-tests
    // as the element that owns it, so `::after` reach lands on `el` itself.
    const owns = (y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === el || el.contains(hit));
    };

    /**
     * The exact y where this control stops answering, found by halving.
     *
     * **Not a one-pixel-at-a-time walk, and the difference is the whole
     * measurement.** Stepping in integers loses the fraction at each end — a
     * band running 602.0 to 646.0 probed on whole pixels answers from 603 to
     * 644 and reports 41 for a control that is exactly 44. That looked like a
     * real miss of the 44px bar and was an artefact of the ruler.
     *
     * @param outward - -1 for up, 1 for down.
     */
    const edge = (outward: -1 | 1) => {
      let inside = box.top + box.height / 2;
      // 32px is past any reach the cockpit gives anything, so a control that
      // still answers there is a hit area that has swallowed its neighbours.
      let outside = inside + outward * 32;
      if (owns(outside)) return outside;
      for (let i = 0; i < 14; i += 1) {
        const mid = (inside + outside) / 2;
        if (owns(mid)) inside = mid;
        else outside = mid;
      }
      return outside;
    };

    return edge(1) - edge(-1);
  });
}

/**
 * How tall a control's own painted box is, with no reach counted.
 *
 * The other half of every "the reach is real" assertion: the defect DOR-1753
 * shipped and PR #1530 fixed was an `::after` that computed to zero width and
 * therefore caught nothing, so {@link touchHeight} came back equal to this
 * number. Comparing the two is what tells a control that grew its hit area
 * apart from one that only claims to.
 *
 * @param locator - The control to measure.
 * @returns Its border-box height in CSS pixels.
 */
export async function borderHeight(locator: Locator): Promise<number> {
  return locator.evaluate((el) => el.getBoundingClientRect().height);
}
