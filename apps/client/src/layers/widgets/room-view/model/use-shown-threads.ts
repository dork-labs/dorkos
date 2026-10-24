/**
 * Which threads the Threads page draws: a page at a time, and never one taken
 * away from under the reader.
 *
 * @module widgets/room-view/model/use-shown-threads
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadSummary } from '@dorkos/shared/room-schemas';

/**
 * How many cards the page draws before "Show more", and how many each press
 * adds.
 *
 * **Each card reads its room and that room's history**, so a page that drew
 * all fifty threads the list can hold would fire about a hundred requests the
 * moment it opened. Twelve fills a tall screen; the rest are a press away.
 */
export const THREADS_PAGE_SIZE = 12;

/** What {@link useShownThreads} hands the page. */
export interface ShownThreads {
  /** The threads to draw, in the server's order. */
  visible: readonly ThreadSummary[];
  /** Whether "Show more" has anything left to show. */
  hasMore: boolean;
  /** Draw the next page. */
  showMore: () => void;
  /**
   * The thread whose card should take focus, or `null`. Set by the press that
   * shows the last page, because that press takes its own button away and
   * focus would otherwise fall to the page.
   */
  focusId: string | null;
  /** Clear {@link ShownThreads.focusId} once the card has it. */
  focused: () => void;
}

/**
 * The first `limit` threads, plus every thread already on screen.
 *
 * **A card stays once it is drawn.** The list is ordered by newest reply, so a
 * reply landing in a thread lower down moves it above the cutoff and pushes the
 * last drawn card below it — which unmounted that card, composer and half-typed
 * reply included. Keeping every thread that has been drawn makes the list
 * grow by one instead.
 *
 * @param threads - The thread list, newest reply first.
 */
export function useShownThreads(threads: readonly ThreadSummary[]): ShownThreads {
  const [limit, setLimit] = useState(THREADS_PAGE_SIZE);
  const [focusId, setFocusId] = useState<string | null>(null);
  const drawn = useRef(new Set<string>());

  const visible = useMemo(
    () => threads.filter((thread, index) => index < limit || drawn.current.has(thread.rootEntryId)),
    [threads, limit]
  );
  useEffect(() => {
    for (const thread of visible) drawn.current.add(thread.rootEntryId);
  }, [visible]);

  const hasMore = threads.length > visible.length;
  const showMore = useCallback(() => {
    const shownIds = new Set(visible.map((thread) => thread.rootEntryId));
    const next = threads.filter((thread) => !shownIds.has(thread.rootEntryId));
    // The last page: its button goes, so its first card takes focus.
    if (next.length <= THREADS_PAGE_SIZE && next[0] !== undefined) {
      setFocusId(next[0].rootEntryId);
    }
    setLimit((count) => count + THREADS_PAGE_SIZE);
  }, [threads, visible]);
  const focused = useCallback(() => setFocusId(null), []);

  return { visible, hasMore, showMore, focusId, focused };
}
