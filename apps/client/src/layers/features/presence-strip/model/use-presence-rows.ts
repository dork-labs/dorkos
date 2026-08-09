/**
 * Gathering every live signal this client holds into the strip's rows.
 *
 * Four reads, each already owned by something else, none of them added for this
 * strip: the room presence store, the room list, the rooms whose rosters are in
 * hand, and the fleet-wide session-status projection. The strip introduces no
 * poll and no endpoint — presence is pushed, and a surface that had to ask
 * would be describing the past.
 *
 * @module features/presence-strip/model/use-presence-rows
 */
import { useCallback, useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useResolvedAgents } from '@/layers/entities/agent';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { roomKeys, useRooms, useRoomPresenceEverywhere } from '@/layers/entities/room';
import { useSessionListStore } from '@/layers/entities/session';
import { useTransport } from '@/layers/shared/model';
import { buildPresenceRows, type PresenceRow, type WorkingSession } from '../lib/presence-rows';

/** One shared empty answer, so a quiet cockpit never re-renders its reader. */
const NOBODY: PresenceRow[] = [];

/** The same, for the half of the strip that reads sessions. */
const NO_SESSIONS: WorkingSession[] = [];

/** Field separator inside one session's signature entry. */
const FIELD = '\u0000';

/** Record separator between entries in the working-set signature. */
const RECORD = '\u0001';

/**
 * Which sessions the runtimes say are mid-turn, fleet-wide.
 *
 * Read from the session-list store rather than from `useSessions`, and that is
 * the whole point: the query cache is scoped to the selected working directory,
 * so a per-directory read would see one agent's sessions and miss every other
 * agent on the machine. The store is fed by the global `/api/events` stream and
 * spans the fleet (`useAgentAttentionMap` reads it the same way, for the same
 * reason).
 *
 * `statusCwds` is the honest gate: it holds a session only once its runtime
 * reported a working directory for it. A runtime that projects a lifecycle
 * without one leaves a session nothing can attribute, and an unattributable
 * turn is not presence — it is a fact about the machine with nobody's name on
 * it, so it never reaches a row.
 */
function useWorkingSessions(): readonly WorkingSession[] {
  // Raw slices, folded outside the selector — the shape `useAgentAttentionMap`
  // documents: immer only replaces these two references when they actually
  // change, whereas a set built inside a zustand selector would mint a new
  // reference on every store tick and re-render on all of them.
  const statuses = useSessionListStore(useCallback((held) => held.statuses, []));
  const statusCwds = useSessionListStore(useCallback((held) => held.statusCwds, []));

  // The working set as one sorted string, and the array memoised on THAT.
  //
  // `statuses` moves on every status event the fleet produces — a token count,
  // a cost, a context reading — and almost none of those change WHO is working.
  // Memoising the array on `statuses` therefore minted a new array (and, below
  // it, new rows, new faces, a new hover card) twenty times for twenty events
  // that said nothing new. The signature changes only when a session starts
  // streaming, stops, or moves.
  const signature = useMemo(() => {
    const parts: string[] = [];
    for (const [sessionId, cwd] of Object.entries(statusCwds)) {
      // `streaming` only. `blocked` is an agent WAITING on a person — the
      // opposite of working, and already the triage header's subject two lines
      // up; `error` and `interrupted` are turns that have stopped.
      if (statuses[sessionId]?.lifecycle !== 'streaming') continue;
      parts.push(`${sessionId}${FIELD}${cwd}`);
    }
    // Sorted so that a store whose key order changed — immer rebuilds objects —
    // cannot pass for a change in who is working.
    return parts.sort().join(RECORD);
  }, [statuses, statusCwds]);

  return useMemo(() => {
    if (signature.length === 0) return NO_SESSIONS;
    return signature.split(RECORD).map((part) => {
      const [sessionId, cwd] = part.split(FIELD);
      return { sessionId: sessionId!, cwd: cwd! };
    });
  }, [signature]);
}

/**
 * Who is working right now, as rows ready to draw.
 *
 * **Two halves, two different limits, both honest.** Room claims name what an
 * agent is bound to and reach only the rooms this client is subscribed to;
 * running sessions span the whole fleet and can only say that a turn is in
 * flight. Neither is padded out with the other's certainty, and an agent
 * appearing in both is one row (see {@link buildPresenceRows}).
 *
 * The room rosters are read with `useQueries` against the same cache key
 * `useRoom` fills, so a room already open is a cache hit and costs nothing.
 * There is no realistic case where it is not: an author-level claim only
 * reaches this client over a room's own stream, which is opened by the same
 * view that fetched the roster.
 *
 * @param excludeRoomIds - Rooms already narrating their own presence elsewhere
 *   on the page, whose claims should draw no row here. Held as a joined string
 *   internally, so a caller passing a fresh array each render costs nothing.
 *   See {@link PresenceRowsInput.excludeRoomIds} for why the exclusion happens
 *   inside the builder rather than over the claims on the way in.
 * @returns The rows to draw, or a shared empty array when nobody is working.
 */
export function usePresenceRows(excludeRoomIds: readonly string[] = []): readonly PresenceRow[] {
  const transport = useTransport();
  const claims = useRoomPresenceEverywhere();
  const sessions = useWorkingSessions();
  const { data: roomList } = useRooms();
  const { data: meshAgents } = useMeshAgentPaths();

  // Joined to a string rather than kept as an array: a fresh array every render
  // would re-key the queries below and defeat every memo under it.
  const roomIdKey = useMemo(
    () => [...new Set(claims.map((claim) => claim.roomId))].sort().join('\n'),
    [claims]
  );
  const roomIds = useMemo(() => (roomIdKey.length === 0 ? [] : roomIdKey.split('\n')), [roomIdKey]);

  // `combine` rather than a memo over the results: `useQueries` hands back a
  // fresh array every render, so a `useMemo` keyed on it would rebuild the map —
  // and every row under it — on each pass. Combining is where TanStack applies
  // structural sharing, so the map's identity only moves when a roster does.
  const rosters = useQueries({
    queries: roomIds.map((roomId) => ({
      queryKey: roomKeys.detail(roomId),
      queryFn: () => transport.getRoom(roomId),
    })),
    combine: (results) => {
      const byId: Record<string, RoomWithRoster> = {};
      for (const result of results) {
        if (result.data !== undefined) byId[result.data.id] = result.data;
      }
      return byId;
    },
  });

  const rooms = useMemo(() => {
    const byId: Record<string, RoomSummary> = {};
    for (const room of roomList ?? []) byId[room.id] = room;
    return byId;
  }, [roomList]);

  const agentPaths = useMemo(
    () => (meshAgents?.agents ?? []).map((agent) => agent.projectPath),
    [meshAgents]
  );
  const { data: resolvedAgents } = useResolvedAgents(agentPaths);
  const agents = useMemo<Record<string, AgentManifest | null>>(
    () => resolvedAgents ?? {},
    [resolvedAgents]
  );

  // Joined for the same reason the room ids are: a caller writing
  // `usePresenceStrip([teamRoomId])` builds a fresh array on every render, and
  // keying the rows on it would undo every memo above.
  const excludeKey = excludeRoomIds.join(RECORD);

  return useMemo(() => {
    if (claims.length === 0 && sessions.length === 0) return NOBODY;
    const rows = buildPresenceRows({
      claims,
      rosters,
      rooms,
      sessions,
      agents,
      excludeRoomIds: excludeKey.length === 0 ? [] : excludeKey.split(RECORD),
    });
    return rows.length === 0 ? NOBODY : rows;
  }, [claims, rosters, rooms, sessions, agents, excludeKey]);
}
