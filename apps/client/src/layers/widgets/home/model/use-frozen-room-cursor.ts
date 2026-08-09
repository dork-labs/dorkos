/**
 * Where this reader had got to when they arrived.
 *
 * @module widgets/home/model/use-frozen-room-cursor
 */
import { useState } from 'react';
import { useRoom } from '@/layers/entities/room';

/** A cursor together with the room it was taken from. */
interface FrozenCursor {
  roomId: string | null;
  seq: number | null;
}

/**
 * The reader's own read cursor, as it stood when this surface opened.
 *
 * **Frozen, because the live one is gone within a frame.** Opening a room marks
 * it read (`useMarkRoomRead`), so by the time anything on the page could compare
 * against the live cursor it has already been dragged to the newest entry — and
 * every question of the form "has anything happened since I got here?" answers
 * "no", forever. Taking a copy on the first render that has one is what makes
 * that question answerable at all.
 *
 * **It reads the room itself rather than being handed a cursor.** The room is a
 * cached query the surface below has already fetched, so the read costs nothing,
 * and owning it keeps the "which member am I" rule in one place — matched on
 * `viewerAuthorId`, never on `author.kind`, which returns whichever human sorts
 * first once two people share an install.
 *
 * **Why this is not `widgets/room-view`'s `useFrozenReadCursor`.** That one holds
 * the unread DIVIDER still while you read, and takes its cursor as an argument
 * because the surface around it already has one. This one answers a different
 * question for a different consumer and does its own reading, and in any case a
 * widget may not import another widget (the FSD layer rule). If a third consumer
 * ever wants it, the shared half belongs in `entities/room`, not in either
 * widget.
 *
 * @param roomId - The room being read.
 * @returns The frozen cursor, or `null` while the room has not loaded and for a
 * reader who is not a member of it. `null` means "cannot say", and every caller
 * has to treat it as such rather than as "nothing is new".
 */
export function useFrozenRoomCursor(roomId: string): number | null {
  const { data: room } = useRoom(roomId);
  const lastReadSeq =
    room?.members.find((member) => member.author.id === room.viewerAuthorId)?.lastReadSeq ?? null;

  // Render-time state adjustment, the pattern React recommends for "reset some
  // state when a prop changes" (https://react.dev/learn/you-might-not-need-an-effect).
  // An effect would commit one frame holding the wrong cursor first, and that
  // frame is exactly the one a reader would see the wrong answer in.
  const [frozen, setFrozen] = useState<FrozenCursor>({ roomId: null, seq: null });

  if (frozen.roomId === roomId) return frozen.seq;
  // Nothing to freeze yet. Waiting is correct: a cursor is taken once, and taking
  // it early — before the roster arrived — would freeze the absence of one.
  if (lastReadSeq === null) return null;

  setFrozen({ roomId, seq: lastReadSeq });
  return lastReadSeq;
}
