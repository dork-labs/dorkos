/**
 * Read one room and its history (spec `rooms` §7).
 *
 * @module entities/room/model/use-room
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/**
 * Fetch one room with its roster.
 *
 * @param roomId - The room to read, or `null` when nothing is selected (the
 *   query stays idle rather than firing against a made-up id).
 */
export function useRoom(roomId: string | null): UseQueryResult<RoomWithRoster> {
  const transport = useTransport();
  return useQuery({
    queryKey: roomKeys.detail(roomId ?? ''),
    queryFn: () => transport.getRoom(roomId!),
    enabled: roomId !== null,
  });
}

/**
 * Fetch the trailing page of a room's history, oldest-first.
 *
 * The server's default page size is the whole hydration this view needs;
 * scrolling further back is `?before=`, which arrives with the composer.
 *
 * @param roomId - The room to read, or `null` when nothing is selected.
 */
export function useRoomEntries(roomId: string | null): UseQueryResult<RoomEntry[]> {
  const transport = useTransport();
  return useQuery({
    queryKey: roomKeys.entries(roomId ?? ''),
    queryFn: () => transport.listRoomEntries(roomId!),
    enabled: roomId !== null,
  });
}
