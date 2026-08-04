/**
 * Clear the unread badge on a whole section at once — what "Mark all channels
 * read" and "Mark all read" perform (spec `rooms` §14.1).
 *
 * @module features/dashboard-sidebar/model/use-mark-rooms-read
 */
import { useCallback, useRef } from 'react';
import { useMarkRoomReadNow } from '@/layers/entities/room';

/**
 * Mark several rooms read in one gesture.
 *
 * **There is no bulk endpoint, and this does not invent one.** It runs the
 * existing per-room path (`useMarkRoomReadNow`) once per room, which is the
 * same two calls the row menu's "Mark as read" makes — read the room's newest
 * entry, then move the cursor onto that exact `seq`. Doing it per room is not
 * only the smaller change, it is the correct one: the cursor is not clamped
 * server-side, so there is no "set them all very high" shortcut that does not
 * silently swallow the next messages to arrive as already-read.
 *
 * Only rooms that are actually behind should be handed in — a room already
 * caught up would spend two requests to write the cursor it already has.
 *
 * **One gesture, one sweep.** A second call while a sweep is still running is
 * dropped rather than doubled. The menu stays open long enough to be clicked
 * twice and the badges do not clear until the writes land, so an impatient
 * second click read as a second sweep — 12 requests over three rooms, and the
 * work is idempotent so the extra ones buy nothing.
 *
 * Failures collapse into ONE line, not one per room: the underlying mutation
 * carries an `errorToastId`, so a section where the server is refusing says
 * "Couldn't mark that room as read" once, however many rooms were in the sweep.
 * That is the honest shape for a single gesture — the person pressed one thing,
 * so one thing failed.
 */
export function useMarkRoomsRead(): (roomIds: readonly string[]) => void {
  const markRead = useMarkRoomReadNow();
  // `mutateAsync`, not `mutate` with an `onSettled` callback. One `useMutation`
  // has ONE observer, and each `mutate` detaches the previous mutation from it —
  // so with a sweep of three rooms only the last one's `onSettled` ever runs,
  // and a counter fed from those callbacks would never reach zero. The promise
  // each call returns belongs to that call, so counting them is the only honest
  // way to know when the whole sweep has landed.
  const { mutateAsync } = markRead;
  const sweeping = useRef(false);

  return useCallback(
    (roomIds: readonly string[]) => {
      if (sweeping.current || roomIds.length === 0) return;
      sweeping.current = true;
      // `allSettled`, so a room that refuses still counts as done and does not
      // strand the gesture. The failure itself is already reported — the
      // mutation cache raises its toast whether or not anyone awaits this.
      void Promise.allSettled(roomIds.map((roomId) => mutateAsync(roomId))).finally(() => {
        sweeping.current = false;
      });
    },
    [mutateAsync]
  );
}
