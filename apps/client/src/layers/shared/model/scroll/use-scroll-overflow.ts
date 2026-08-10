/**
 * Whether a vertical scroller still has content past either edge.
 *
 * @module shared/model/scroll/use-scroll-overflow
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';

/**
 * How much scroll range counts as none, in pixels.
 *
 * Fractional layout heights leave a sub-pixel remainder at rest, which would
 * otherwise pin a cue on permanently at the end of a fully-scrolled list.
 */
const EDGE_SLACK_PX = 1;

/** What {@link useScrollOverflow} hands back. */
export interface ScrollOverflow {
  /** Wire to the scroller's `onScroll`. */
  onScroll: () => void;
  /** True when content is hidden above the top edge. */
  above: boolean;
  /** True when content is hidden below the bottom edge. */
  below: boolean;
}

/**
 * Watch a scroller and report which edges still have content behind them.
 *
 * The answer a scroll cue is drawn from: a list clipped at a height cap looks
 * exactly like a list that ended, and macOS shows no scrollbar until you have
 * already scrolled — so without this the last row is simply cut in half and
 * nothing says why (DOR-1043).
 *
 * Report only what is really behind the edge. A cue over content that cannot be
 * reached is worse than no cue at all (the rule ADR 260725-004456 set when the
 * status line's old fade advertised items that were not there), so both flags
 * are false the moment the content fits.
 *
 * **Three things move the answer, and each needs its own listener.** Scrolling
 * is the obvious one. The scroller being resized — a window, a panel drag, a
 * phone rotating — is the `ResizeObserver`. And the content growing inside a
 * capped box fires neither: an approval arriving over the event stream makes the
 * list longer while the box stays exactly the size it was and nobody touched the
 * scroll position. That is why the effect below runs on every commit rather than
 * on a dependency list: a re-render is the one signal that content changed, and
 * the measurement is two DOM reads that bail out when nothing moved.
 *
 * The scroller's ref is taken rather than handed back, so what comes out of here
 * is two plain booleans. A hook that returns a ref alongside them makes every
 * read of those booleans in JSX look like a ref read during render — which
 * `react-hooks/refs` is right to refuse, and which suppressing per call site
 * would teach the wrong lesson.
 *
 * @param ref - The element carrying `overflow-y: auto`.
 */
export function useScrollOverflow(ref: RefObject<HTMLElement | null>): ScrollOverflow {
  const [edges, setEdges] = useState({ above: false, below: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const next = {
      above: el.scrollTop > EDGE_SLACK_PX,
      below: el.scrollTop < max - EDGE_SLACK_PX,
    };
    // Bail out on an unchanged reading, so the commit-scoped effect below
    // settles after one pass instead of re-rendering forever.
    setEdges((prev) => (prev.above === next.above && prev.below === next.below ? prev : next));
  }, [ref]);

  // No dependency array on purpose — see the note above the hook.
  useEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return;

    const el = ref.current;
    if (!el) return;
    // The scroller gives `clientHeight`; its children are what `scrollHeight`
    // measures, and they resize on their own — a late web font, a card growing
    // a second line — with the scroll box exactly the size it was.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  });

  return { onScroll: measure, above: edges.above, below: edges.below };
}
