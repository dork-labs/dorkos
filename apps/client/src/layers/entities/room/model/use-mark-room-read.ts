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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/**
 * Advance the read cursor of the open room to its newest entry.
 *
 * Does nothing while the room is still loading, for a reader who is not a
 * member (they have no cursor to move), or when the cursor already covers
 * everything. Each `(room, seq)` pair is sent at most once per mount, so a
 * refetch that has not yet reflected the write cannot start a loop.
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: roomKeys.all }),
  });
  const { mutate } = mutation;

  // v1 mints exactly one human author (spec `rooms` §2), so the roster's human
  // member is the person reading. Accounts replace this lookup, not the rule.
  const membership = room?.members.find((member) => member.author.kind === 'human');
  const newestSeq = entries.length > 0 ? entries[entries.length - 1]!.seq : 0;

  useEffect(() => {
    if (!room || !membership || newestSeq === 0) return;
    if (membership.lastReadSeq >= newestSeq) return;
    const marker = `${room.id}:${newestSeq}`;
    if (sentRef.current === marker) return;
    sentRef.current = marker;
    mutate({ roomId: room.id, seq: newestSeq });
  }, [room, membership, newestSeq, mutate]);
}
