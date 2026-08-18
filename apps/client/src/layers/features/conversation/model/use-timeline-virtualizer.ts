/**
 * The timeline's virtualizer, and the four options that are decisions.
 *
 * Split out of `Conversation.Timeline` because none of this is about drawing a
 * conversation: it is the measurement contract with TanStack Virtual, and every
 * line of it was paid for by a bug — a key space that had to match React's, a
 * measurement that must not trust a zero, and the anchoring that replaced the
 * room's hand-written follow.
 *
 * @module features/conversation/model/use-timeline-virtualizer
 */
import { useCallback, type RefObject } from 'react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import type { ConversationRow } from '../lib/row-kinds';

/**
 * Build the virtualizer the timeline scrolls.
 *
 * @param rows - The rows being drawn, oldest first.
 * @param scrollerRef - The scrolling element, once it exists.
 * @returns The virtualizer.
 */
export function useTimelineVirtualizer(
  rows: readonly ConversationRow[],
  scrollerRef: RefObject<HTMLDivElement | null>
): Virtualizer<HTMLDivElement, Element> {
  // Stable per key-space, NOT per render. `getMeasurementOptions` lists
  // `getItemKey` among its memo deps and virtual-core's `memo` compares by
  // reference, so a fresh arrow every render invalidates it every render —
  // which clears `pendingMin` and forces `getMeasurements` to rebuild every row
  // from index 0 on every scroll event and every streamed token.
  //
  // The dep MUST be `rows`, not a ref: identity has to change exactly when the
  // key space can. `setOptions` detects reorders by comparing the PREVIOUS
  // options' `getItemKey` against the next one at the `anchorTo: 'end'` edges;
  // a ref-reading callback would answer with today's keys on both sides of that
  // comparison and silently kill reorder detection.
  const getItemKey = useCallback((index: number) => rows[index]?.id ?? index, [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => 80,
    overscan: 5,
    // The virtualizer's key space MUST match the key React reconciles rows by
    // (`rows[index].id` in the render below). Two things break on virtual-core's
    // index default: the zero-guard in `measureElement` looks a row's last real
    // height up in `itemSizeCache` BY KEY, so after any row shift — a day divider
    // appearing, the unread rule moving — it would answer with a neighbour's
    // height; and `elementsCache` is keyed the same way, so a row that merely
    // changed position would stop being re-observed and never measure again.
    getItemKey,
    // Live measurement with a zero-guard cache fallback. Rows measure their
    // real DOM height (the ResizeObserver entry when present, else the rect) —
    // EXCEPT when the measurement comes back 0: a hidden scroll container
    // (`display: none`, e.g. an Obsidian sidebar tab switched away) measures
    // every row at 0, and letting those zeros poison the size cache collapses
    // the total height and loses the scroll position. Answering with the last
    // cached real height instead keeps the layout intact while hidden; live
    // measurement resumes naturally on re-show. (Do NOT replace this with
    // `useCachedMeasurements: true`: that flag makes the default measurer
    // *always* answer from the cache, and since nothing ever seeds the cache,
    // every row would freeze at the estimate.)
    measureElement: (element, entry, instance) => {
      const box = entry?.borderBoxSize?.[0];
      const size = box ? Math.round(box.blockSize) : element.getBoundingClientRect().height;
      if (size > 0) return size;
      const index = instance.indexFromElement(element);
      const key = instance.options.getItemKey(index);
      return instance.itemSizeCache.get(key) ?? instance.options.estimateSize(index);
    },
    // Anchor the list to its end: when rows above change height the view stays
    // put relative to the last item, and when a new row is appended while the
    // reader is pinned near the bottom the list follows it. Together with the
    // growing-last-item clamp in virtual-core 3.17, this keeps the conversation
    // pinned to the newest tokens during streaming while leaving a reader who
    // has scrolled up undisturbed. It is also what replaced the room's
    // hand-written follow, which is why `use-timeline-scroll` no longer writes
    // `scrollTop` on an arrival.
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: 64,
  });

  return virtualizer;
}
