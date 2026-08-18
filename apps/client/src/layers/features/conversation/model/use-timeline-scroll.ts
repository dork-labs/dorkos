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
 * token. So this owns the three things the virtualizer cannot answer: where the
 * reader is, whether anything arrived while they were away, and where they were
 * standing the last time this scroller existed.
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

/**
 * How many frames a freshly attached scroller is given to finish laying out.
 *
 * A conversation mounts with its history already in the cache, but the ELEMENT
 * can be inserted before it has a height — the phone's thread push lays out its
 * enclosing surface over the following frames. Measured coming back from a
 * thread: the scroller attached at `scrollHeight` 538 against a `clientHeight`
 * of 680, so there was nothing to scroll and the restore was a no-op, and only
 * later did the content settle to 1317. Ten frames is about 160ms — long enough
 * for that, short enough that a reader cannot meaningfully scroll inside it.
 */
const SETTLE_FRAMES = 10;

/**
 * Where each conversation was left, so a scroller that comes back can go there.
 *
 * **Module-level rather than a ref, because the component holding the ref is
 * exactly what disappears.** On a phone the thread panel is a full-screen push:
 * opening one UNMOUNTS the room column, timeline and all, and coming back
 * mounts a brand new element at `scrollTop` 0. Measured on a 390x844 viewport
 * before the room's hook existed: 1148px before opening a thread, 0px after
 * closing it — the room silently jumped to its oldest message. The old hook
 * survived that because it lived in the page above; this one lives in the
 * timeline, so the memory has to outlive the timeline instead.
 *
 * Bounded, because it is keyed by conversation and a long session opens many:
 * see {@link rememberTop}.
 */
const rememberedTops = new Map<string, number>();

/** How many conversations' positions are worth keeping. */
const REMEMBERED_LIMIT = 32;

/**
 * Record where one conversation was left, evicting the oldest when full.
 *
 * @param conversationId - The conversation on screen.
 * @param top - Its scroller's `scrollTop`.
 */
function rememberTop(conversationId: string, top: number): void {
  // Delete-then-set so the Map's insertion order is a genuine recency order —
  // re-recording an existing key would otherwise leave it where it first landed
  // and evict something the reader is actively using.
  rememberedTops.delete(conversationId);
  rememberedTops.set(conversationId, top);
  if (rememberedTops.size <= REMEMBERED_LIMIT) return;
  const oldest = rememberedTops.keys().next();
  if (!oldest.done) rememberedTops.delete(oldest.value);
}

/**
 * Forget a conversation's position.
 *
 * Exported for the timeline's own landing effect, which takes the remembered
 * position and must not be handed it twice.
 *
 * @param conversationId - The conversation to forget.
 */
export function forgetTimelinePosition(conversationId: string): void {
  rememberedTops.delete(conversationId);
}

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
   * True when this mount re-attached to a conversation it already had a
   * position for, and put the reader back on it.
   *
   * The timeline's own landing effect reads this and stands down: a reader
   * returning from a thread belongs where they were, not at the unread rule or
   * the newest message.
   */
  restoredPosition: boolean;
  /** Take the reader to the newest row and clear the pill. */
  scrollToBottom: (opts?: { behavior?: ScrollBehavior }) => void;
}

/**
 * Track where a reader is in a conversation, and put them back when it returns.
 *
 * Three answers, and each has a consumer that cannot get it anywhere else:
 *
 * - `isAtBottom` draws the jump-to-latest affordance, and is why this is state
 *   and not only a ref. The room's hook kept it in a ref because nothing
 *   rendered from it; the merged timeline renders two controls from it, so it
 *   is state — set only when the answer FLIPS, so a wheel tick inside the band
 *   still costs no render.
 * - `hasNewRows` draws the new-messages pill, which is what a reader gets
 *   instead of being yanked to the bottom by somebody else's message.
 * - `restoredPosition` tells the timeline's landing effect to stand down.
 *
 * @param input - The conversation on screen and how many rows it holds.
 * @returns The scroller's bindings and what is true of it.
 */
export function useTimelineScroll(input: TimelineScrollInput): TimelineScroll {
  const { conversationId, rowCount } = input;

  const elRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  /**
   * True while a freshly attached scroller is still being put back.
   *
   * **Scroll events fired during that window are layout, not the reader**, and
   * telling them apart is the whole point of this flag. A scroller that
   * attaches short and then grows emits a scroll event whose geometry says
   * "637px from the bottom" — indistinguishable, to {@link onScroll}, from
   * somebody reading back through history. Believing it recorded the reader as
   * scrolled up, and the restore then faithfully returned them to the top of
   * the room they had never left.
   */
  const pinPendingRef = useRef(false);

  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewRows, setHasNewRows] = useState(false);
  // Whether this mount found a position waiting for it. Read once, at mount,
  // because the landing effect that consumes it runs once too — and re-reading
  // the map later would answer with the position this very hook just wrote.
  const [restoredPosition, setRestoredPosition] = useState(
    () => conversationId !== null && rememberedTops.has(conversationId)
  );

  // The conversation this hook is currently tracking. Initialised to the one it
  // mounted with, so the effect below can tell a genuine SWITCH from the first
  // render — a switch forgets, a first render restores.
  const trackedRef = useRef(conversationId);

  const onScroll = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    // Ignored while restoring: see `pinPendingRef`. The reader has not touched
    // anything yet, so nothing they did can be recorded from it.
    if (pinPendingRef.current) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK_PX;
    atBottomRef.current = atBottom;
    if (trackedRef.current !== null) rememberTop(trackedRef.current, el.scrollTop);
    // Only on the flip. A wheel tick that stays inside the band renders nothing.
    setIsAtBottom((current) => (current === atBottom ? current : atBottom));
    if (atBottom) setHasNewRows(false);
  }, []);

  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    if (el === null) return;
    const target = trackedRef.current === null ? undefined : rememberedTops.get(trackedRef.current);
    // Nothing remembered: this is a first landing, and where it lands is the
    // timeline's decision (the unread rule, or the newest message). Writing a
    // `scrollTop` here would fight that effect one frame later.
    if (target === undefined) return;

    pinPendingRef.current = true;

    /** Put the scroller where it belongs, and say whether it landed. */
    const apply = (): boolean => {
      // The element may have been swapped again since this was scheduled.
      if (elRef.current !== el) return true;
      el.scrollTop = target;
      // **A scroller with nothing to scroll has NOT landed.** An element whose
      // content has not been laid out yet reports `scrollHeight ===
      // clientHeight`, which satisfies every "are we there" test trivially — so
      // the restore declared success against 680px of content, released the
      // guard, and the conversation then grew to 1317px and fired the scroll
      // event that recorded the reader as scrolled up.
      return el.scrollHeight > el.clientHeight && Math.abs(el.scrollTop - target) <= 1;
    };

    // Re-applied across the next few frames rather than once, because the
    // element can attach before it has a height — see {@link SETTLE_FRAMES}. It
    // stops the moment the position takes, so a conversation that lays out
    // immediately (every case but the push) costs exactly one assignment.
    let frames = 0;
    const settle = () => {
      if (elRef.current !== el) {
        pinPendingRef.current = false;
        return;
      }
      const landed = apply();
      frames += 1;
      if (landed || frames >= SETTLE_FRAMES) {
        pinPendingRef.current = false;
        return;
      }
      requestAnimationFrame(settle);
    };

    if (apply()) pinPendingRef.current = false;
    else requestAnimationFrame(settle);
  }, []);

  // A conversation SWITCH — never the first render, and never a remount of the
  // same conversation. Both of those are what the memory exists for; a switch is
  // the case where the reader has asked for somewhere else and belongs at its
  // newest message, which is what every chat surface does and what the room's
  // hook did before this one.
  useEffect(() => {
    if (trackedRef.current === conversationId) return;
    trackedRef.current = conversationId;
    if (conversationId !== null) forgetTimelinePosition(conversationId);
    atBottomRef.current = true;
    pinPendingRef.current = false;
    setRestoredPosition(false);
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
    if (trackedRef.current !== null) forgetTimelinePosition(trackedRef.current);
    setIsAtBottom(true);
    setHasNewRows(false);
  }, []);

  return { scrollRef, onScroll, isAtBottom, hasNewRows, restoredPosition, scrollToBottom };
}
