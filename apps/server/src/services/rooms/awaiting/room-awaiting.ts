/**
 * How many of a room's turns are waiting on a person right now (DOR-3236).
 *
 * A folded sidebar section keeps a room on screen while an agent there is
 * stopped on an approval, a question or an MCP prompt, and the room list is
 * where it reads that from. **Asked of the server's own session state, never of
 * anything an agent reports**: a session counts while its projector holds a live
 * pending interaction (`hasPendingInteractions`, the same probe the stall
 * watchdog and the write-lock ask), and it belongs to the room its binding in
 * the room session ledger names. A count, and nothing else: no session ids, no
 * prompt, no tool name.
 *
 * @module services/rooms/awaiting/room-awaiting
 */
import {
  listLiveProjectors,
  onProjectorStatusChange,
} from '../../session/session-state-projector.js';
import { eventFanOut, type BroadcastAudience } from '../../core/event-fan-out.js';
import { readOwnerAccount } from '../../core/auth/index.js';
import { resolveOperatorAuthor } from '../operator-author.js';
import type { RoomService } from '../room-service.js';
import type { RoomSessionLedger } from '../session-bindings/room-session-ledger.js';

/** The two things this module asks of a live session. */
export interface AwaitingSession {
  /** The session's id, as the ledger knows it. */
  readonly sessionId: string;
  /** Whether a person has an approval, a question or a prompt to answer there. */
  hasPendingInteractions(): boolean;
}

/** Which room a session answers for. */
export type RoomBindings = Pick<RoomSessionLedger, 'bindingForSession'>;

/**
 * Count, per room, the bound sessions waiting on a person. A room with none is
 * absent from the map.
 *
 * @param bindings - The room session ledger.
 * @param sessions - Every live session; the projector registry by default.
 */
export function countAwaitingByRoom(
  bindings: RoomBindings,
  sessions: Iterable<AwaitingSession> = listLiveProjectors()
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (!session.hasPendingInteractions()) continue;
    const roomId = bindings.bindingForSession(session.sessionId)?.roomId;
    if (roomId !== undefined) counts.set(roomId, (counts.get(roomId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Tell readers when a room's count changes, on the `room_awaiting` event.
 *
 * Its own event rather than `room_activity`, for the reason `room_presence` is:
 * a wait has no entry and no `seq`. Sent only on a change, so the projector's
 * many status transitions cost one ledger lookup each and nothing on the wire.
 *
 * @param bindings - The room session ledger.
 * @param rooms - The room service whose membership gate addresses each event.
 * @param deps - Where statuses come from, the live sessions, and where a change
 *   goes; injectable for tests.
 * @returns Stops watching.
 */
export function watchRoomAwaiting(
  bindings: RoomBindings,
  rooms: Pick<RoomService, 'authorRegistry' | 'requireMembership'>,
  deps: {
    onStatusChange?: (listener: (update: { sessionId: string }) => void) => () => void;
    sessions?: () => Iterable<AwaitingSession>;
    publish?: (roomId: string, awaiting: number) => void;
  } = {}
): () => void {
  const subscribe = deps.onStatusChange ?? onProjectorStatusChange;
  const sessions = deps.sessions ?? listLiveProjectors;
  const publish =
    deps.publish ??
    ((roomId: string, awaiting: number) =>
      eventFanOut.broadcast('room_awaiting', { roomId, awaiting }, roomAudience(roomId, rooms)));
  /** The last count sent per room; a room at zero is absent. */
  const sent = new Map<string, number>();
  return subscribe(({ sessionId }) => {
    const roomId = bindings.bindingForSession(sessionId)?.roomId;
    if (roomId === undefined) return;
    const awaiting = countAwaitingByRoom(bindings, sessions()).get(roomId) ?? 0;
    if ((sent.get(roomId) ?? 0) === awaiting) return;
    if (awaiting === 0) sent.delete(roomId);
    else sent.set(roomId, awaiting);
    publish(roomId, awaiting);
  });
}

/** Address a count through the same membership gate as room reads. */
function roomAudience(
  roomId: string,
  rooms: Pick<RoomService, 'authorRegistry' | 'requireMembership'>
): BroadcastAudience {
  return (principal) => {
    // Agent streams carry no verified agent identity to resolve membership from.
    if (principal.kind !== 'operator' && principal.kind !== 'program') return false;
    try {
      const registry = rooms.authorRegistry;
      const author =
        principal.kind === 'operator' || principal.userId === readOwnerAccount()?.id
          ? resolveOperatorAuthor(registry)
          : registry.human(principal.userId);
      rooms.requireMembership(roomId, author.id);
      return true;
    } catch {
      return false;
    }
  };
}
