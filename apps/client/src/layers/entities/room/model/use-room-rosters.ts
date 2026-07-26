/**
 * Read the rosters of several rooms at once.
 *
 * The list endpoint returns no members, so anything that needs to know WHO is in
 * a room has to ask per room. Every read is keyed `roomKeys.detail(id)`, so it
 * shares its cache with `useRoom` — opening a room the sidebar already fetched
 * costs nothing, and the global `room_member_*` events refresh both together.
 *
 * @module entities/room/model/use-room-rosters
 */
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/** Rosters keyed by room id, holding only the rooms whose read has landed. */
export type RoomRosters = ReadonlyMap<string, RoomRosterEntry[]>;

/**
 * Fetch the rosters for a set of rooms.
 *
 * Bounded by the number of direct messages, which is bounded by the fleet — this
 * is a handful of small cached reads, not a fan-out over history.
 *
 * @param roomIds - The rooms to read. A room still loading is simply absent from
 *   the result, so callers see "not known yet" rather than "empty roster".
 */
export function useRoomRosters(roomIds: readonly string[]): RoomRosters {
  const transport = useTransport();

  const results = useQueries({
    queries: roomIds.map((roomId) => ({
      queryKey: roomKeys.detail(roomId),
      queryFn: () => transport.getRoom(roomId),
    })),
  });

  // `useQueries` hands back a fresh wrapper array every render, so memoizing on
  // it would never hit. The key is a signature of what a caller can observe —
  // which rooms resolved, and who is on each — as ONE string, because a dep
  // array has to be a constant length and a spread would not be.
  const signature = results
    .map((result, index) => {
      const members = result.data?.members;
      return `${roomIds[index]}=${members ? members.map((m) => m.author.id).join(',') : '?'}`;
    })
    .join(';');

  const rosters = new Map<string, RoomRosterEntry[]>();
  roomIds.forEach((roomId, index) => {
    const room = results[index]?.data;
    if (room) rosters.set(roomId, room.members);
  });

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` captures every observable change; `rosters` is rebuilt from the same reads
  return useMemo(() => rosters, [signature]);
}
