/**
 * One scroller, for every conversation the cockpit draws.
 *
 * The merge of two hooks that solved halves of the same problem: the room's
 * `use-stick-to-bottom` (follow the newest message unless the reader has
 * scrolled away, and put them back when the scroller re-attaches) and the
 * session's `use-scroll-overlay` (when to offer the jump-to-latest button and
 * the new-messages pill). Both are gone; this is what replaces them.
 *
 * **The room's contract won, and so did its numbers.** Where the two disagreed
 * on a threshold, the room's is the one kept — see {@link AT_BOTTOM_SLACK_PX}.
 * Nothing was "improved" while being merged.
 *
 * **What this hook does NOT do: follow the tail.** `Conversation.Timeline` is
 * virtualized, and TanStack Virtual's `anchorTo: 'end'` + `followOnAppend` are
 * what keep a pinned reader pinned while messages land and stream — writing
 * `scrollTop` from here as well would fight it, one frame apart, on every
 * token. So this owns the two things the virtualizer cannot answer: where the
 * reader is, and whether anything arrived while they were away.
 *
 * **Nor does it put a returning reader back.** That needs a ROW rather than an
 * offset, and therefore the list's own row model — see `timeline-position.ts`,
 * which says what a remembered pixel cost when it was tried here.
 *
 * @module features/conversation/model/use-timeline-scroll
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How far from the bottom still counts as being at it.
 *
 * The room's number (64px), kept verbatim where the session's list said 70:
 * merging two hooks is not an occasion to retune either of them, and the room's
 * is the one with the measured history behind it. A few pixels of rounding — a
 * fractional device pixel, a half-rendered row — must not read as "scrolled
 * up"; a screenful must.
 */
const AT_BOTTOM_SLACK_PX = 64;

/** What {@link useTimelineScroll} needs to know about the list it is scrolling. */
export interface TimelineScrollInput {
  /**
   * The conversation on screen — a session id or a room id — or `null` when
   * there is none. Switching it is what resets the reader to the bottom.
   */
  conversationId: string | null;
  /**
   * How many rows the timeline holds, including anything drawn under the feed.
   *
   * Only ever compared with its own previous value: a growth while the reader
   * is scrolled away is what raises the new-messages pill.
   */
  rowCount: number;
}

/** What the timeline gets back. */
export interface TimelineScroll {
  /**
   * Attach to the scrolling element.
   *
   * A callback ref rather than a ref object, and that is load-bearing: the
   * scroller can unmount and come back while the conversation has not changed,
   * and only a callback ref is TOLD when that happens.
   */
  scrollRef: (el: HTMLDivElement | null) => void;
  /** Attach to that element's `onScroll`. */
  onScroll: () => void;
  /** True while the reader is within {@link AT_BOTTOM_SLACK_PX} of the end. */
  isAtBottom: boolean;
  /** True when rows arrived while the reader was scrolled away. */
  hasNewRows: boolean;
  /**
   * Whether the reader is at the bottom, readable at any moment.
   *
   * The same answer as {@link TimelineScroll.isAtBottom}, for the one caller
   * that must read it from an unmount cleanup: state there is whatever the last
   * render closed over, and the last render is not the moment the reader left.
   */
  atBottomRef: { readonly current: boolean };
  /** Take the reader to the newest row and clear the pill. */
  scrollToBottom: (opts?: { behavior?: ScrollBehavior }) => void;
}

/**
 * Track where a reader is in a conversation, and put them back when it returns.
 *
 * Two answers, and each has a consumer that cannot get it anywhere else:
 *
 * - `isAtBottom` draws the jump-to-latest affordance, and is why this is state
 *   and not only a ref. The room's hook kept it in a ref because nothing
 *   rendered from it; the merged timeline renders two controls from it, so it
 *   is state — set only when the answer FLIPS, so a wheel tick inside the band
 *   still costs no render.
 * - `hasNewRows` draws the new-messages pill, which is what a reader gets
 *   instead of being yanked to the bottom by somebody else's message.
 *
 * @param input - The conversation on screen and how many rows it holds.
 * @returns The scroller's bindings and what is true of it.
 */
export function useTimelineScroll(input: TimelineScrollInput): TimelineScroll {
  const { conversationId, rowCount } = input;

  const elRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewRows, setHasNewRows] = useState(false);

  // The conversation this hook is currently tracking. Initialised to the one it
  // mounted with, so the effect below can tell a genuine SWITCH from the first
  // render — a switch forgets, a first render restores.
  const trackedRef = useRef(conversationId);

  const onScroll = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK_PX;
    atBottomRef.current = atBottom;
    // Only on the flip. A wheel tick that stays inside the band renders nothing.
    setIsAtBottom((current) => (current === atBottom ? current : atBottom));
    if (atBottom) setHasNewRows(false);
  }, []);

  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
  }, []);

  // A conversation SWITCH — never the first render, and never a remount of the
  // same conversation. Both of those are what the memory exists for; a switch is
  // the case where the reader has asked for somewhere else and belongs at its
  // newest message, which is what every chat surface does and what the room's
  // hook did before this one.
  useEffect(() => {
    if (trackedRef.current === conversationId) return;
    trackedRef.current = conversationId;
    atBottomRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a switch is an event: the reader asked for somewhere else, and this is the only place that hears it
    setIsAtBottom(true);
    setHasNewRows(false);
    const el = elRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationId]);

  // Something arrived while the reader was reading back through history. The
  // pill is what they get instead of the view being taken from them.
  const lastRowCountRef = useRef(rowCount);
  useEffect(() => {
    const previous = lastRowCountRef.current;
    lastRowCountRef.current = rowCount;
    if (rowCount > previous && !atBottomRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- an arrival is an event, and the row count is the only signal of one
      setHasNewRows(true);
    }
  }, [rowCount]);

  const scrollToBottom = useCallback((opts?: { behavior?: ScrollBehavior }) => {
    const el = elRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: opts?.behavior ?? 'auto' });
    atBottomRef.current = true;
    setIsAtBottom(true);
    setHasNewRows(false);
  }, []);

  return { scrollRef, onScroll, isAtBottom, hasNewRows, atBottomRef, scrollToBottom };
}
