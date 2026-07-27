/**
 * Hold the unread rule still while you read.
 *
 * @module widgets/room-view/model/use-frozen-read-cursor
 */
import { useState } from 'react';

/** A cursor together with the room it belongs to. */
interface FrozenCursor {
  roomId: string | null;
  seq: number | null;
}

/**
 * The read cursor as it stood when this room was opened.
 *
 * Opening a room advances the real cursor, which is what clears the sidebar
 * badge — but the rule marking where you left off has to stay where it was, or
 * it would vanish out from under you the instant the room loaded. So the rule
 * renders from a frozen copy: taken on the first read of a room, held until you
 * leave it, and taken again the next time you come back.
 *
 * The freeze is render-time state adjustment rather than an effect — the
 * pattern React recommends for "reset some state when a prop changes"
 * (https://react.dev/learn/you-might-not-need-an-effect), and the one
 * `TasksPage` already uses. An effect would render one frame with the wrong
 * cursor first, which is the exact frame the rule would flicker in.
 *
 * @param roomId - The room being read, or `null` when none is selected.
 * @param lastReadSeq - The live cursor, or `null` for a non-member.
 * @returns The cursor to draw the unread rule from.
 */
export function useFrozenReadCursor(
  roomId: string | null,
  lastReadSeq: number | null
): number | null {
  const [frozen, setFrozen] = useState<FrozenCursor>({ roomId: null, seq: null });

  if (frozen.roomId === roomId) return frozen.seq;

  if (roomId === null) {
    setFrozen({ roomId: null, seq: null });
    return null;
  }

  // Wait for the room to load before freezing — until its roster arrives there
  // is no cursor to take, and the previous room's must not stand in for it.
  if (lastReadSeq === null) return null;

  setFrozen({ roomId, seq: lastReadSeq });
  return lastReadSeq;
}
