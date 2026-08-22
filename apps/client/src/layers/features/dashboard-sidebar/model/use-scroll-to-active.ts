/**
 * When you switch conversations, the anchor comes to you (BC-36).
 *
 * @module features/dashboard-sidebar/model/use-scroll-to-active
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useReducedMotion } from 'motion/react';

/**
 * The row the panel currently marks as open.
 *
 * `aria-current="page"` rather than a test attribute, because it is the same
 * fact: `SidebarRow` sets it from `isActive`, so the thing a screen reader is
 * told is open and the thing that gets scrolled to cannot drift apart.
 */
const ACTIVE_ROW_SELECTOR = '[aria-current="page"]';

/**
 * Scroll the open conversation into view — on a conversation switch, and on
 * nothing else.
 *
 * **The guardrails are the feature.** Scrolling is an interruption, so it
 * happens only when the operator has just changed what they are looking at:
 *
 * - **Never on activity, unread, or a model rebuild.** The effect's only
 *   dependency is the anchor's key. A verb starting, a badge clearing or the
 *   whole model being rebuilt changes nothing here, so nothing runs.
 * - **Never on boot.** The key is latched at the first SETTLED model, not at
 *   mount (spec `sidebar-simplification` D6). Latching at mount was not the
 *   same promise: on `/channels` the room list arrives after the panel does, so
 *   the anchor went `null → room`, which reads exactly like a switch — and the
 *   panel smooth-scrolled itself while the operator was doing nothing. The
 *   boot's own positioning is a layout effect with `behavior: 'auto'`, so the
 *   open row is simply already in view in the first painted frame.
 * - **Never outside Today.** The search is scoped to the container this hook
 *   is given, so a collapsed Library section is never opened to reach a copy of
 *   the same conversation inside it (BC-33 leaves that copy to take the active
 *   tint if it happens to be visible).
 * - **Instant under `prefers-reduced-motion`.** `behavior: 'auto'` — the row
 *   still comes into view, it just does not travel there.
 *
 * `block: 'nearest'` for the same reason: a row already on screen is left
 * exactly where it is.
 *
 * @param containerRef - The Today zone's own element.
 * @param anchorKey - The open conversation's row key, or `null` when nothing
 *   conversational is open.
 * @param settled - Whether the panel's boot gate has opened. Until it has,
 *   there is no "before" to compare an anchor against.
 */
export function useScrollToActive(
  containerRef: RefObject<HTMLElement | null>,
  anchorKey: string | null,
  settled: boolean
): void {
  const reducedMotion = useReducedMotion();
  // `null` until the first settled model, which is what makes the difference
  // between "the panel finished loading" and "you opened something else".
  const latched = useRef<{ key: string | null } | null>(null);

  // A LAYOUT effect, so the boot's positioning happens before the browser
  // paints: the open row is in view in the first frame the operator sees rather
  // than arriving there a frame later.
  useLayoutEffect(() => {
    if (!settled) return;
    const first = latched.current === null;
    const before = latched.current?.key ?? null;
    latched.current = { key: anchorKey };
    if (!first && (before === anchorKey || anchorKey === null)) return;
    if (anchorKey === null) return;
    const row = containerRef.current?.querySelector(ACTIVE_ROW_SELECTOR);
    if (!(row instanceof HTMLElement)) return;
    // The boot never travels. Only a switch the operator made does.
    const smooth = !first && reducedMotion !== true;
    row.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
    // `reducedMotion` is deliberately not a dependency: it decides HOW a scroll
    // travels, and a person turning the preference on mid-session must not be
    // scrolled anywhere for having done so.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey, containerRef, settled]);
}
