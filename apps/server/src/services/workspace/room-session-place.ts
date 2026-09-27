/**
 * Where an app-resumed room session's turn stands, for a caller that holds
 * nothing but a session id (DOR-1624, spec `agent-home-desk` §5.7).
 *
 * A room turn begins inside the rooms domain, which knows its room and its
 * agent. The SAME conversation can also be picked up in the app —
 * `POST /api/sessions/:id/messages` — and that route knows only a session id.
 * Both must agree: the turn stands in the agent's HOME, carries the agent as
 * `forAgent`, and is granted the room's folders exactly as a room turn is, so
 * an agent resumed from the app can keep working on the room's files it was
 * working on in the room.
 *
 * An app-resumed turn never refreshes the agent's copy (§6.1): only a room
 * turn does that, at its own launch.
 *
 * **The port is declared here and implemented in the rooms domain**
 * (`services/rooms/repo/room-turn-place.ts`), the same way the session-origin
 * overlays declare `ResolveRoomOrigins`. That is what lets the session route
 * ask a room question without importing a room type.
 *
 * @module server/services/workspace/room-session-place
 */
import path from 'node:path';
import type { DirectoryGrant } from '@dorkos/shared/agent-runtime';
import { isSameOrInside } from '@dorkos/shared/directory-grants';
import { logger } from '../../lib/logger.js';
import { resolveSessionCwd, type ResolveSessionCwdRequest } from './resolve-session-cwd.js';
import { logResolvedCwd, type ResolvedCwd } from './session-cwd-rung.js';

/** Where a room-bound session's turn stands and what it may reach. */
export interface RoomSessionTurnPlace {
  /** The agent's home. */
  cwd: string;
  /** The room's folders this turn may reach; empty for a room with no files. */
  additionalDirectories: DirectoryGrant[];
  /** The agent's copy of the room's files, or `null` when the room has none. */
  worktree: string | null;
  /**
   * True when this session was created standing in the agent's copy and its
   * runtime cannot move it (an OpenCode session from before room turns moved
   * home, spec §8.1). Such a session keeps running in its copy, with no grants.
   * The room's own next turn starts the room a fresh session at home.
   */
  standsInCopy?: boolean;
}

/** What a session id is worth to a room, as the composition root wires it. */
export interface RoomSessionPlacePort {
  /**
   * The room this session answers for, or `null` when it answers for none.
   *
   * The agent's display name rides along because it is the readable half of the
   * agent's copy's folder name, so the two paths that can start a turn in one
   * room conversation have to read it from the same place.
   *
   * The agent's home rides along too, because the ROOM decides which agent a
   * room-bound session is — a turn's body cannot (DOR-2091).
   *
   * @param sessionId - The session about to take a turn.
   */
  roomFor(sessionId: string): { roomId: string; agentName: string; agentPath: string } | null;
  /**
   * Place a turn for this agent in this room, exactly as a room turn is placed.
   * Never throws: a room whose files cannot be opened answers the home with no
   * grants.
   */
  placeTurn(
    roomId: string,
    agentPath: string,
    agentName: string,
    sessionId?: string
  ): Promise<RoomSessionTurnPlace>;
}

/** What {@link resolveSessionCwdWithRoom} answers: a directory, and for a room session its grants. */
export type ResolvedSessionPlace = ResolvedCwd & {
  /** The room's folders this turn may reach; present only for a room-bound session at home. */
  additionalDirectories?: DirectoryGrant[];
  /** The agent the room says this session is, for identity. */
  forAgent?: string;
};

/**
 * Resolve one turn's working directory, letting a room binding speak for it.
 *
 * Identical to {@link resolveSessionCwd} for a session no room answers for —
 * including an install with the rooms subsystem off, where `place` is absent.
 *
 * For a room-bound session:
 *
 * - no `cwd` named → the agent's home, with the room's grants;
 * - a `cwd` naming the agent's copy of the room's files, or a folder inside it →
 *   replaced by the home (the client resends the directory it last showed, and
 *   before this change that was the copy). Logged at debug;
 * - an OpenCode session created in the copy (it cannot move) → kept in its copy,
 *   with no grants; the room's next turn starts the room a fresh one at home;
 * - a `cwd` naming the home → the home, with the grants;
 * - any other `cwd` → that directory, explicitly, with no grants: the grants
 *   are computed for a turn standing at home.
 *
 * `forAgent` is the room's agent in every case.
 *
 * @param req - What the caller knows about the turn; the session id is required
 *   here because it is the only thing the room lookup has to go on.
 * @param place - The rooms domain's answer to that lookup, or `undefined`.
 */
export async function resolveSessionCwdWithRoom(
  req: ResolveSessionCwdRequest & { sessionId: string },
  place: RoomSessionPlacePort | undefined
): Promise<ResolvedSessionPlace> {
  const bound = place ? roomForSession(place, req.sessionId) : null;
  if (!place || !bound) return resolveSessionCwd(req);
  const { agentPath, roomId, agentName } = bound;
  // **The room's binding names the agent, and a body that names another is
  // IGNORED for the room's purposes** (DOR-2091). The route only checks that a
  // body `agentPath` is SOME registered agent, so taking it here would let a
  // POST to Ana's room session claim Ben.
  if (req.agentPath !== undefined && path.resolve(req.agentPath) !== path.resolve(agentPath)) {
    logger.warn('[cwd] a message named a different agent than its room session; using the room’s', {
      sessionId: req.sessionId,
      roomId,
    });
  }
  const placed = await place.placeTurn(roomId, agentPath, agentName, req.sessionId);
  if (placed.standsInCopy) {
    const resolved: ResolvedSessionPlace = {
      cwd: placed.cwd,
      rung: 'explicit',
      forAgent: agentPath,
    };
    logResolvedCwd(resolved, { sessionId: req.sessionId, roomId });
    return resolved;
  }
  let named = req.cwd;
  if (
    named !== undefined &&
    placed.worktree !== null &&
    isSameOrInside(path.resolve(named), path.resolve(placed.worktree))
  ) {
    logger.debug('[cwd] a room session named its copy of the room’s files; it runs at home', {
      sessionId: req.sessionId,
      roomId,
    });
    named = undefined;
  }
  const resolved: ResolvedSessionPlace =
    named === undefined || samePath(named, placed.cwd)
      ? {
          cwd: placed.cwd,
          rung: 'agent-home',
          ...(placed.additionalDirectories.length > 0
            ? { additionalDirectories: placed.additionalDirectories }
            : {}),
          forAgent: agentPath,
        }
      : { cwd: named, rung: 'explicit', forAgent: agentPath };
  logResolvedCwd(resolved, { sessionId: req.sessionId, roomId });
  return resolved;
}

/** Two spellings of one folder, compared lexically. */
function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * The room lookup, which never fails the turn: a binding that cannot be read is
 * one less thing to go on, not a reason for a person's message to 500.
 *
 * @param place - The port to ask.
 * @param sessionId - The session about to take a turn.
 */
function roomForSession(
  place: RoomSessionPlacePort,
  sessionId: string
): ReturnType<RoomSessionPlacePort['roomFor']> {
  try {
    return place.roomFor(sessionId);
  } catch (err) {
    logger.warn('[cwd] could not read the room binding', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
