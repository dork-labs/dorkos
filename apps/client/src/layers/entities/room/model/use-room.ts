/**
 * Read one room and its history (spec `rooms` §7).
 *
 * @module entities/room/model/use-room
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
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
 * One definition of a room's history query, so the reader that fetches it and
 * the reader that only looks at it can never key on different things.
 */
function roomEntriesQuery(transport: Transport, roomId: string | null) {
  return {
    queryKey: roomKeys.entries(roomId ?? ''),
    queryFn: () => transport.listRoomEntries(roomId!),
  };
}

/**
 * Fetch the trailing page of a room's history, oldest-first.
 *
 * The server's default page size is the whole hydration this view needs.
 * Scrolling further back than that page is `?before=`, which the server serves
 * and no client surface asks for yet.
 *
 * **This is the room's owner of its history, and there should be one.** The
 * cache entry it fills is also where the live stream merges arriving entries
 * (`useRoomStream`), so a second fetch of the same key can overwrite an entry
 * the socket has already delivered but the in-flight GET predates. Anything that
 * only wants to READ the history reads {@link useLoadedRoomEntries} instead.
 *
 * @param roomId - The room to read, or `null` when nothing is selected.
 */
export function useRoomEntries(roomId: string | null): UseQueryResult<RoomEntry[]> {
  const transport = useTransport();
  return useQuery({ ...roomEntriesQuery(transport, roomId), enabled: roomId !== null });
}

/**
 * The room's history **this client already holds** — never a request.
 *
 * For decoration: a surface that can say something better when the history
 * happens to be loaded, and must say something true when it is not. The room
 * sheet's "last spoke" line is the case — worth printing over an open room,
 * never worth a history GET on its own.
 *
 * Two reasons it does not simply call {@link useRoomEntries}:
 *
 * - **It would fetch.** The trailing page of a room nobody has open is a real
 *   payload to decorate one line of a dialog with, and this is the same
 *   restraint the presence line keeps by not opening a second SSE stream.
 * - **It could overwrite live entries.** Mounting a second observer on a stale
 *   query starts a background refetch, and that response lands over anything the
 *   room's socket delivered while it was in flight. The history belongs to the
 *   stream; a decoration does not get to race it.
 *
 * Still reactive: it observes the same cache entry, so an arriving message
 * updates the line without anybody asking the server twice.
 *
 * @param roomId - The room to look at, or `null` when nothing is selected.
 * @returns The loaded page, or `undefined` when this client has never read it.
 */
export function useLoadedRoomEntries(roomId: string | null): RoomEntry[] | undefined {
  const transport = useTransport();
  return useQuery({ ...roomEntriesQuery(transport, roomId), enabled: false }).data;
}
