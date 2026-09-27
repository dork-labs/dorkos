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
import { assertOwnDesk, DeskNotOwnError } from '../core/agent-identity/index.js';
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
   * home, spec §8.1). Such a session takes no more turns — its transcript stays
   * readable — and the room's own next turn starts the room a fresh session at
   * home.
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

/**
 * The sentence a person sees when an app-resumed room conversation cannot take
 * another turn because its runtime keeps it inside the room's files.
 */
export const ROOM_SESSION_MOVED_MESSAGE =
  "This conversation started inside the room's files before an update and can't continue " +
  "here. Carry on in the room, where the agent's next turn starts fresh in its own folder.";

/** Why a room-bound session's turn must not start, with the sentence to show. */
export interface RoomSessionRefusal {
  /**
   * `ROOM_SESSION_MOVED` — the session's runtime keeps it inside the room's
   * files; `DESK_NOT_OWN` — the message named a folder that is not the room's
   * agent's own.
   */
  code: 'ROOM_SESSION_MOVED' | 'DESK_NOT_OWN';
  /** Shown as-is. */
  message: string;
}

/** What {@link resolveSessionCwdWithRoom} answers: a directory, and for a room session its grants. */
export type ResolvedSessionPlace = ResolvedCwd & {
  /** The room's folders this turn may reach; present only for a room-bound session at home. */
  additionalDirectories?: DirectoryGrant[];
  /** The agent the room says this session is, for identity. */
  forAgent?: string;
  /** Present when this turn must not start; the caller refuses it before anything runs. */
  refusal?: RoomSessionRefusal;
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
 * - an OpenCode session created in the copy (it cannot move) → refused with
 *   `ROOM_SESSION_MOVED`: no turn stands in a room's files, and its transcript
 *   stays readable; the room's next turn starts the room a fresh one at home;
 * - a `cwd` naming the home → the home, with the grants;
 * - any other `cwd` → that directory, explicitly, with no grants, when it is
 *   the agent's own desk (a private copy of its own project); refused with
 *   `DESK_NOT_OWN` when it is not — another agent's folder, a room's, or any
 *   folder that is no copy of the agent's own.
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
    logger.info('[cwd] an app-resumed room session stands in the room’s files; not continuing it', {
      sessionId: req.sessionId,
      roomId,
    });
    return {
      cwd: placed.cwd,
      rung: 'explicit',
      forAgent: agentPath,
      refusal: { code: 'ROOM_SESSION_MOVED', message: ROOM_SESSION_MOVED_MESSAGE },
    };
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
  if (resolved.rung === 'explicit') {
    // **The desk guard** (spec `agent-home-desk` §3.4, I3): a named folder is
    // the room's agent's own, or the turn does not start.
    try {
      assertOwnDesk(agentPath, resolved.cwd, 'home');
    } catch (err) {
      if (!(err instanceof DeskNotOwnError)) throw err;
      return {
        ...resolved,
        refusal: {
          code: 'DESK_NOT_OWN',
          message:
            `This room conversation always runs from ${agentName}'s own folder ` +
            `("${agentPath}") and can't move to "${path.resolve(resolved.cwd)}", not even to ` +
            `a folder inside it. Send the message without choosing a folder.`,
        },
      };
    }
  }
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
