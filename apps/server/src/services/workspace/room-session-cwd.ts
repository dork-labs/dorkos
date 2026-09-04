/**
 * The room rung, for a caller that holds nothing but a session id (DOR-1624).
 *
 * A room turn already reaches rung 2 the direct way: it begins inside the rooms
 * domain, which knows its room, its agent and that agent's label, and passes all
 * three to {@link resolveSessionCwd}. The SAME conversation can also be picked
 * up in the app — `POST /api/sessions/:id/messages` — and that route knows only
 * a session id. So it asked the ordinary chain, landed on the agent's own
 * folder, and showed the operator a directory the agent had not worked in since
 * it joined the room: every uncommitted edit in the room worktree was on disk
 * and invisible.
 *
 * This module is the missing half of that question, and deliberately nothing
 * more. It does not decide anything: it fills in the `room` field the resolver
 * already accepts and the one collaborator only the rooms domain can supply,
 * then hands both to the same chain every other turn boundary uses. The
 * precedence — an explicitly named `cwd` still winning outright — stays where it
 * has always been, in `resolve-session-cwd.ts`.
 *
 * **The port is declared here and implemented in the rooms domain**
 * (`services/rooms/repo/room-worktree-cwd.ts`), the same way the session-origin
 * overlays declare `ResolveRoomOrigins`. That is what lets the session route ask
 * a room question without importing a room type, and lets the resolver go on
 * knowing nothing about rooms at all.
 *
 * @module server/services/workspace/room-session-cwd
 */
import { logger } from '../../lib/logger.js';
import {
  resolveSessionCwd,
  sessionCwdDeps,
  type ResolveSessionCwdDeps,
  type ResolveSessionCwdRequest,
  type ResolvedCwd,
} from './resolve-session-cwd.js';

/** What a session id is worth to the room rung, as the composition root wires it. */
export interface RoomSessionPlacePort {
  /**
   * The room this session answers for, or `null` when it answers for none.
   *
   * The agent's display name rides along because it is the readable half of the
   * worktree's directory name, so the two paths that can start a turn in one
   * room conversation have to read it from the same place or they name two
   * different directories.
   *
   * @param sessionId - The session about to take a turn.
   */
  roomFor(sessionId: string): { roomId: string; agentName: string } | null;
  /** This install's {@link ResolveSessionCwdDeps.ensureRoomWorktree}. */
  ensureRoomWorktree: ResolveSessionCwdDeps['ensureRoomWorktree'];
}

/**
 * Resolve one turn's working directory, letting a room binding speak for it.
 *
 * Identical to {@link resolveSessionCwd} for a session no room answers with —
 * including an install with the rooms subsystem off, where `place` is absent.
 *
 * @param req - What the caller knows about the turn; the session id is required
 *   here because it is the only thing the room lookup has to go on.
 * @param place - The rooms domain's answer to that lookup, or `undefined`.
 * @returns The directory to run in, the rung that chose it, and any degradation.
 */
export function resolveSessionCwdWithRoom(
  req: Omit<ResolveSessionCwdRequest, 'room'> & { sessionId: string },
  place: RoomSessionPlacePort | undefined
): Promise<ResolvedCwd> {
  const room = place ? roomForSession(place, req.sessionId) : null;
  if (!place || !room) return resolveSessionCwd(req);
  return resolveSessionCwd(
    { ...req, room },
    sessionCwdDeps({
      ensureRoomWorktree: (roomId, agentPath, agentName) =>
        place.ensureRoomWorktree(roomId, agentPath, agentName),
    })
  );
}

/**
 * The room lookup, which never fails the turn.
 *
 * The same rule the rest of the chain follows: a binding that cannot be read is
 * one less thing to go on, not a reason for a person's message to 500. A turn
 * that loses this answer runs where it ran before the rung existed.
 *
 * @param place - The port to ask.
 * @param sessionId - The session about to take a turn.
 */
function roomForSession(
  place: RoomSessionPlacePort,
  sessionId: string
): { roomId: string; agentName: string } | null {
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
