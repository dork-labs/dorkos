/**
 * Page Down at the edge of the rendered window.
 *
 * Only a few rows either side of the viewport exist in the DOM, so without this
 * a reader crossing a long conversation stops dead at whatever the window
 * happens to end on — message 9 of 30 — with the key swallowed and nothing to
 * show for it. The feed hands the edge back, this scrolls the next article into
 * existence, and lands the focus on it once it has rendered.
 *
 * Split out of `Conversation.Timeline` because it is one behaviour in two
 * halves — a scroll and, a commit later, a focus — held together by a ref that
 * has no other reader.
 *
 * **It only works where the HOST numbers its articles.** The edge hand-back is
 * driven by `aria-posinset`, and so is "message 12 of 30" being read out at all.
 * A session numbers its rows; a room deliberately does not (pinned by
 * `RoomFlow.test.tsx`), because a room's page is a window into a history whose
 * total nobody on the client knows, and "message 12 of 30" over the middle of
 * one would be a promise the count cannot keep. On a room this never fires and
 * the browser's own focus scroll carries a keyboard reader instead, which was
 * measured: 46 Page Downs from the top reached the last message and stopped
 * there.
 *
 * @module features/conversation/model/use-feed-edge-focus
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import { FEED_ARTICLE_ATTR } from '@/layers/shared/model';
import type { ConversationRow } from '../lib/row-kinds';

/**
 * Scroll the article past the edge into existence, then focus it.
 *
 * Articles are the MESSAGE rows and nothing else — the day rule and the unread
 * rule are separators between articles, and a host numbers over its messages
 * for exactly that reason — so `aria-posinset` counts them in order.
 *
 * @param rows - The rows being drawn, oldest first.
 * @param virtualizer - The list's virtualizer, which is what moves.
 * @param scrollerRef - The scrolling element, for finding the article again.
 * @returns The feed's `onBeyondRendered` handler.
 */
export function useFeedEdgeFocus(
  rows: readonly ConversationRow[],
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  scrollerRef: RefObject<HTMLDivElement | null>
): (direction: 'next' | 'previous', edge: HTMLElement) => void {
  const pendingFocusRef = useRef<number | null>(null);

  const handleBeyondRendered = useCallback(
    (direction: 'next' | 'previous', edge: HTMLElement) => {
      const position = Number(edge.getAttribute('aria-posinset'));
      const wanted = direction === 'next' ? position + 1 : position - 1;
      if (!Number.isFinite(wanted) || wanted < 1) return;
      let seen = 0;
      const rowIndex = rows.findIndex((row) => row.kind === 'message' && ++seen === wanted);
      if (rowIndex === -1) return;
      pendingFocusRef.current = wanted;
      virtualizer.scrollToIndex(rowIndex, { align: direction === 'next' ? 'end' : 'start' });
    },
    [rows, virtualizer]
  );

  // Focus what the scroll above went to fetch, on the first render that has it.
  // Runs every render rather than on a dep, because the render that finally
  // holds the row is caused by the virtualizer's own measurement rather than by
  // anything in the timeline's props.
  useEffect(() => {
    const wanted = pendingFocusRef.current;
    if (wanted === null) return;
    const article = scrollerRef.current?.querySelector<HTMLElement>(
      `[${FEED_ARTICLE_ATTR}][aria-posinset="${wanted}"]`
    );
    if (article === null || article === undefined) return;
    pendingFocusRef.current = null;
    article.focus();
  });

  return handleBeyondRendered;
}
