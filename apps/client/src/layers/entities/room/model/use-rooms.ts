/**
 * Read the rooms this cockpit can see (spec `rooms` §7).
 *
 * One query holds every non-archived room and callers partition it by kind, so
 * the sidebar's two sections share a single request and a single cache to
 * invalidate.
 *
 * @module entities/room/model/use-rooms
 */
import { useMemo } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/** How long a room list stays fresh before a refocus refetches it. */
const ROOMS_STALE_TIME_MS = 30_000;

/**
 * Fetch every room the caller may see, newest activity first.
 *
 * Each summary carries `unreadCount`, which is `null` for a room the caller has
 * not joined. That is not zero — see {@link RoomSummary}.
 */
export function useRooms(): UseQueryResult<RoomSummary[]> {
  const transport = useTransport();
  return useQuery({
    queryKey: roomKeys.list(),
    queryFn: () => transport.listRooms(),
    staleTime: ROOMS_STALE_TIME_MS,
  });
}

/** A room list split into the two kinds the sidebar renders. */
export interface RoomsByKind {
  channels: RoomSummary[];
  dms: RoomSummary[];
}

/**
 * Split a room list into channels and direct messages.
 *
 * Threads are deliberately dropped: a thread belongs to the room it hangs off
 * and is reached from there, never from a top-level sidebar section.
 *
 * @param rooms - The full room list, or undefined while it loads.
 */
export function useRoomsByKind(rooms: RoomSummary[] | undefined): RoomsByKind {
  return useMemo(
    () => ({
      channels: (rooms ?? []).filter((room) => room.kind === 'channel'),
      dms: (rooms ?? []).filter((room) => room.kind === 'dm'),
    }),
    [rooms]
  );
}
