/**
 * Whether a scroller still has content past either edge, on either axis.
 *
 * @module shared/model/scroll/use-scroll-overflow
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';

/**
 * How much scroll range counts as none, in pixels.
 *
 * Fractional layout sizes leave a sub-pixel remainder at rest, which would
 * otherwise pin a cue on permanently at the end of a fully-scrolled list.
 */
const EDGE_SLACK_PX = 1;

/** Which axis a scroller scrolls on. */
export type ScrollAxis = 'vertical' | 'horizontal';

/** What {@link useScrollOverflow} hands back. */
export interface ScrollOverflow {
  /** Wire to the scroller's `onScroll`. */
  onScroll: () => void;
  /**
   * True when content is hidden behind the edge the scroller starts at — the
   * top of a vertical list, the left of a horizontal one.
   */
  start: boolean;
  /** True when content is hidden behind the far edge — the bottom, or the right. */
  end: boolean;
}

/**
 * Watch a scroller and report which edges still have content behind them.
 *
 * The answer a scroll cue is drawn from: a list clipped at a height cap looks
 * exactly like a list that ended, a strip of tabs clipped at a phone's width
 * looks exactly like a word somebody mis-typed, and macOS shows no scrollbar
 * until you have already scrolled — so without this the last row is simply cut
 * in half and nothing says why (DOR-1043, DOR-1180).
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
 * @param ref - The element carrying `overflow-y: auto` or `overflow-x: auto`.
 * @param axis - Which way it scrolls. Vertical by default.
 */
export function useScrollOverflow(
  ref: RefObject<HTMLElement | null>,
  axis: ScrollAxis = 'vertical'
): ScrollOverflow {
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // The same three numbers on either axis, which is the whole of the axis
    // difference — everything below is about WHEN to read them, not which.
    const offset = axis === 'vertical' ? el.scrollTop : el.scrollLeft;
    const visible = axis === 'vertical' ? el.clientHeight : el.clientWidth;
    const total = axis === 'vertical' ? el.scrollHeight : el.scrollWidth;
    const next = {
      start: offset > EDGE_SLACK_PX,
      end: offset < total - visible - EDGE_SLACK_PX,
    };
    // Bail out on an unchanged reading, so the commit-scoped effect below
    // settles after one pass instead of re-rendering forever.
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [axis, ref]);

  // No dependency array on purpose — see the note above the hook.
  useEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return;

    const el = ref.current;
    if (!el) return;
    // The scroller gives the visible size; its children are what the total
    // measures, and they resize on their own — a late web font, a card growing
    // a second line — with the scroll box exactly the size it was.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  });

  return { onScroll: measure, start: edges.start, end: edges.end };
}
