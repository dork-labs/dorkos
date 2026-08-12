/**
 * Bring an item inside a horizontal scroller into view.
 *
 * Lives beside {@link useScrollOverflow} rather than in `shared/lib`, where a
 * taxonomy of "pure functions" would otherwise put it: the two are one concern —
 * a strip that holds more than it shows — and every surface that draws the cue
 * needs the reveal for the same reason. Splitting them across two barrels would
 * mean finding one and not the other.
 *
 * @module shared/model/scroll/reveal-in-scroller
 */

/** Breathing room left beside an item that had to be scrolled into view. */
const REVEAL_MARGIN_PX = 8;

/**
 * Scroll the least distance that puts `target` fully inside `scroller`.
 *
 * **Why anything hand-written instead of `scrollIntoView`.** The margin: an item
 * flush against the edge of a strip that scrolls reads as cut off, which is the
 * appearance this exists to prevent. The native call also scrolls every
 * scrollable ancestor, and these strips sit inside app shells that must not
 * move.
 *
 * Nothing happens when the item already fits, so this is safe to call on every
 * layout change. When the item is WIDER than the strip, its start is the half
 * worth showing — that is where the label is.
 *
 * @param scroller - The element carrying `overflow-x: auto`.
 * @param target - The item to reveal, a descendant of `scroller`.
 */
export function revealInScroller(scroller: HTMLElement, target: HTMLElement): void {
  const box = scroller.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const pastEnd = rect.right - box.right;
  const pastStart = box.left - rect.left;
  if (pastStart > 0) scroller.scrollLeft -= pastStart + REVEAL_MARGIN_PX;
  else if (pastEnd > 0) scroller.scrollLeft += pastEnd + REVEAL_MARGIN_PX;
}
