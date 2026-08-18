/**
 * Where each of a room's agents does its work (spec `unified-conversation`
 * §5.3.3).
 *
 * The one read behind "Open its session" in the live lane's peek. It is
 * deliberately not part of the room read: `RoomWithRoster` carries no session id
 * on the room, the member or the roster entry, and `specs/room-presence` §15
 * kept the mapping off the presence signal until there was a design that checked
 * the caller's right to it. `GET /api/rooms/:id/sessions` is that design — ids
 * only, people only.
 *
 * @module entities/room/api/use-room-sessions
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { RoomSessionsResponse } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from './query-keys';

/**
 * The room→session bindings, fetched when somebody asks for them.
 *
 * **`enabled` is the point, not a convenience.** This answer is wanted by
 * exactly one affordance — the peek's "Open its session" — which a person opens
 * rarely and deliberately. Fetching it on room mount would put a request on
 * every room open, forever, for a link most of them never draw. The host passes
 * `enabled` from the peek's own open state, and the answer is then cached per
 * room for as long as the reader stays.
 *
 * @param roomId - The room on screen, or `null` when none is.
 * @param options.enabled - Whether to ask now. Defaults to `false`, so a caller
 *   that forgets to pass it fetches nothing rather than fetching always.
 * @returns The bindings, one per agent that has answered in this room.
 */
export function useRoomSessions(
  roomId: string | null,
  options: { enabled?: boolean } = {}
): UseQueryResult<RoomSessionsResponse> {
  const transport = useTransport();
  return useQuery({
    queryKey: roomKeys.sessions(roomId ?? ''),
    queryFn: () => transport.listRoomSessions(roomId!),
    enabled: roomId !== null && options.enabled === true,
  });
}
