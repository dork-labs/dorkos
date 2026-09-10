/**
 * The one way a surface inside a room asks "where does THIS agent work here?"
 * before opening a session (DOR-1974).
 *
 * @module entities/room/model/use-room-bound-session
 */
import { useCallback } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomSessionsResponse, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { reportClientError } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
// Same-slice siblings rather than this slice's own barrel — see `use-route-room`.
import { roomKeys } from '../api/query-keys';
import { roomBoundSessionId } from '../lib/room-bound-session';
import { useRouteRoom } from './use-route-room';

/** What {@link resolveRoomBoundSession} needs: a cache to read, a port to ask over. */
export interface ResolveRoomSessionDeps {
  /** Query client holding (and filling) the room read and its bindings. */
  queryClient: QueryClient;
  /** Transport used when either answer is not cached yet. */
  transport: Transport;
}

/**
 * Ask which session a room has bound for one agent, reading cache first.
 *
 * **Imperative, and resolved on the click rather than on mount.** The bindings
 * read is deliberately lazy (see `useRoomSessions`): it is wanted by a handful
 * of affordances a person opens rarely, and putting it on every room open would
 * buy a request per room forever. Resolving here keeps that property AND removes
 * the race a mount-time fetch would introduce — a button whose answer is still
 * in flight when it is pressed has no honest thing to do with the press.
 *
 * **Every failure answers `null`.** The room may be one the caller cannot see
 * (404), or the caller may be an agent rather than a person (403 `PEOPLE_ONLY`);
 * both mean "this room has nothing to tell you about where that agent works",
 * which is the same thing an agent that has never answered here means. The
 * caller's own fallback is a working destination in all three cases, so there is
 * nothing to interrupt anybody about — the error is reported, not shown.
 *
 * @param deps - Query client to read and fill, transport to ask over.
 * @param roomId - The room on screen.
 * @param agentPath - The agent's project directory.
 * @returns The bound session id, or `null` when this room has none for it.
 */
export async function resolveRoomBoundSession(
  deps: ResolveRoomSessionDeps,
  roomId: string,
  agentPath: string
): Promise<string | null> {
  try {
    // Both reads together: the roster is what turns a directory into this
    // room's author id, and the bindings are keyed by that id. Either one alone
    // cannot answer, so waiting for both costs nothing over waiting for one.
    const [room, sessions] = await Promise.all([
      deps.queryClient.ensureQueryData<RoomWithRoster>({
        queryKey: roomKeys.detail(roomId),
        queryFn: () => deps.transport.getRoom(roomId),
      }),
      deps.queryClient.ensureQueryData<RoomSessionsResponse>({
        queryKey: roomKeys.sessions(roomId),
        queryFn: () => deps.transport.listRoomSessions(roomId),
      }),
    ]);
    return roomBoundSessionId(room, sessions.bindings, agentPath);
  } catch (error) {
    reportClientError(deps.transport, error);
    return null;
  }
}

/**
 * Resolve an agent's session for the room the page is showing.
 *
 * Hand it a project directory and it answers the session that room has bound for
 * that agent, or `null` when there is no room on screen and when the room on
 * screen has no binding for it. The callback is stable, so a memoized surface can
 * hold it without rebuilding.
 *
 * **Why any of this exists.** `/session?dir=<path>` resolves the directory's most
 * recent human CONVERSATION (`resolveSessionForCwd`), and a room turn is filed
 * under origin `room`, which `partitionSessionsByOrigin` puts in the automated
 * bucket on purpose. So the directory route can never land on a room-bound
 * session — for an agent that has only ever worked in rooms it mints a brand-new
 * one instead. A link followed from inside a room has to name the session
 * outright, and this is where that name comes from.
 *
 * @returns A resolver taking the agent's project directory.
 */
export function useRoomBoundSession(): (agentPath: string) => Promise<string | null> {
  const queryClient = useQueryClient();
  const transport = useTransport();
  const route = useRouteRoom();
  const roomId = route.status === 'ready' ? route.roomId : null;

  return useCallback(
    (agentPath: string) =>
      roomId === null
        ? Promise.resolve(null)
        : resolveRoomBoundSession({ queryClient, transport }, roomId, agentPath),
    [queryClient, transport, roomId]
  );
}
