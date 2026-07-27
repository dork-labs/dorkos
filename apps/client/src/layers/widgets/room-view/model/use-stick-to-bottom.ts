/**
 * Follow a room's newest message — unless the reader has scrolled away.
 *
 * @module widgets/room-view/model/use-stick-to-bottom
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * How far from the bottom still counts as being at it. A few pixels of rounding
 * (fractional device pixels, a half-rendered row) must not read as "scrolled
 * up"; a screenful must.
 */
const AT_BOTTOM_SLACK_PX = 64;

/** What the scroll container needs from its host. */
export interface StickToBottom {
  /** Attach to the scrolling element. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Attach to that element's `onScroll`. */
  onScroll: () => void;
}

/**
 * Keep a room pinned to its newest entry while the reader is at the bottom, and
 * leave them exactly where they are when they are not.
 *
 * A room opens at its newest message the way every chat surface does. After
 * that, an arriving entry only scrolls a reader who was already at the bottom —
 * reading back through history while an agent replies used to yank the view
 * away on every message.
 *
 * Whether the reader is at the bottom lives in a ref, not state: nothing
 * renders from it, and a scroll handler that re-rendered the timeline on every
 * wheel tick would cost more than the guard saves.
 *
 * @param roomId - The room on screen, or `null` when none is.
 * @param newestEntryId - Id of the newest entry held, or `null` for an empty or
 *   still-loading room. Keyed on the entry rather than the array so a live
 *   arrival scrolls to itself and a re-render for any other reason does not.
 */
export function useStickToBottom(
  roomId: string | null,
  newestEntryId: string | null
): StickToBottom {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastRoomIdRef = useRef<string | null>(null);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK_PX;
  }, []);

  useEffect(() => {
    // Room bookkeeping first, and unconditionally: a room you have not scrolled
    // yet opens at the bottom, whether or not it has anything in it yet.
    const roomChanged = lastRoomIdRef.current !== roomId;
    lastRoomIdRef.current = roomId;
    if (roomChanged) atBottomRef.current = true;

    const el = scrollRef.current;
    if (!el || newestEntryId === null || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [roomId, newestEntryId]);

  return { scrollRef, onScroll };
}
