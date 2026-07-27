/**
 * Keep the reader's `(member, room)` cursor level with what they are looking at.
 *
 * The unread badge and the "New messages" rule both read this cursor, so
 * whatever draws them has to be able to clear them — a badge on the room
 * currently open, with nothing in the product able to move it, is a lie the
 * reader cannot correct. The advance is monotonic server-side, so a second
 * client further behind can never un-read the room for this one.
 *
 * @module entities/room/model/use-mark-room-read
 */
import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/**
 * Advance the read cursor of the open room to its newest entry.
 *
 * Does nothing while the room is still loading, for a reader who is not a
 * member (they have no cursor to move), or when the cursor already covers
 * everything. Each `(room, seq)` pair is in flight at most once, so a refetch
 * that has not yet reflected the write cannot start a loop — but a write that
 * FAILS releases its marker, so the pair is retried rather than written off.
 *
 * @param room - The open room with its roster, or undefined while it loads.
 * @param entries - The room's loaded history, oldest first.
 */
export function useMarkRoomRead(
  room: RoomWithRoster | undefined,
  entries: readonly RoomEntry[]
): void {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const sentRef = useRef<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({ roomId, seq }: { roomId: string; seq: number }) =>
      transport.setRoomReadCursor(roomId, seq),
    onSuccess: (_result, { roomId }) => {
      // Deliberately NOT `roomKeys.all`. That is `['rooms']`, which prefix-matches
      // `['rooms','entries',roomId]` — so every cursor write would refetch the open
      // room's history, and an entry delivered by SSE mid-flight would be merged
      // and then overwritten by the older snapshot the in-flight GET returns. The
      // stream resumes from the cache and never re-delivers, so that entry would be
      // lost until something else refetched. The history belongs to the stream;
      // only the badge and the cursor are this mutation's to refresh.
      void queryClient.invalidateQueries({ queryKey: roomKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: roomKeys.detail(roomId) });
    },
    onError: () => {
      // Release the marker so the write is not written off. The next thing that
      // happens in the room — a new entry, a revisit, a refetch — retries it.
      // Deliberately not self-retrying: a read cursor is not worth a retry loop
      // against a server that is refusing.
      sentRef.current = null;
    },
  });
  const { mutate } = mutation;

  // `viewerAuthorId` is who the SERVER resolved this request as, so it is the
  // one cursor this client is entitled to move. The old lookup matched on
  // `kind === 'human'`, which found whichever human sorted first — with two
  // people in a room, reading it would have advanced somebody else's cursor and
  // cleared their unread badge.
  const membership = room?.members.find((member) => member.author.id === room.viewerAuthorId);
  const newestSeq = entries.length > 0 ? entries[entries.length - 1]!.seq : 0;
  // Deps are the three primitives this actually turns on, never the `room` or
  // `membership` objects: a refetch hands back new object identities for the same
  // facts, and re-running on those would send a write every time the cache
  // refreshed — and, once a failure releases the marker, would do it in a loop.
  const roomId = room?.id ?? null;
  const lastReadSeq = membership?.lastReadSeq ?? null;

  useEffect(() => {
    if (roomId === null || lastReadSeq === null || newestSeq === 0) return;
    if (lastReadSeq >= newestSeq) return;
    const marker = `${roomId}:${newestSeq}`;
    if (sentRef.current === marker) return;
    sentRef.current = marker;
    mutate({ roomId, seq: newestSeq });
  }, [roomId, lastReadSeq, newestSeq, mutate]);
}

/**
 * Clear a room's unread badge without opening it — what the sidebar's
 * "Mark as read" performs.
 *
 * Two calls, because the caller has a room summary and not its history: read
 * the room's newest entry, then move the cursor onto that exact `seq`. It is
 * deliberately not "set the cursor to a very large number" — the cursor is not
 * clamped server-side, so an optimistic overshoot would silently swallow the
 * next messages to arrive as already-read.
 *
 * A room with nothing in it resolves without writing anything: there is no seq
 * to move to, and its badge was already absent.
 */
export function useMarkRoomReadNow(): UseMutationResult<void, Error, string> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (roomId: string) => {
      const [newest] = await transport.listRoomEntries(roomId, { limit: 1 });
      if (!newest) return;
      await transport.setRoomReadCursor(roomId, newest.seq);
    },
    onSuccess: (_result, roomId) => {
      void queryClient.invalidateQueries({ queryKey: roomKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: roomKeys.detail(roomId) });
    },
    meta: { errorLabel: "Couldn't mark that room as read" },
  });
}
