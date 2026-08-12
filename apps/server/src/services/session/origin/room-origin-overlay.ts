import type { Session } from '@dorkos/shared/types';
import { dropUserLastMessageAtWithoutOperator } from './user-last-message-origin.js';

/**
 * Batched room-binding lookup, injected from the composition root.
 *
 * Answers only for session ids that a room is CURRENTLY answering with. The
 * binding moves when a runtime renames a session mid-turn (DOR-784,
 * `RoomSessionLedger.rebindBySessionId`), so the id in `room_sessions` is always
 * the live one and a stale id correctly answers nothing.
 */
export type ResolveRoomOrigins = (
  sessionIds: string[]
) => Map<string, { roomLabel: string; roomId: string }>;

/**
 * Overlay room origin onto listed sessions, in place. A session bound to a room
 * in `room_sessions` gets `origin: 'room'`, `originLabel` naming that room and
 * `originRoomId` identifying it; an unbound session passes through untouched. A
 * no-op when `resolveRoomOrigins` is undefined (rooms subsystem off).
 *
 * **Both the name and the id go on the wire, and the id is the join.** A label
 * is not unique — a live and an archived channel can share a slug, and a direct
 * message can be titled `#general` — so a client that filed conversations under
 * a room by NAME had to guess between colliding rooms and was silently wrong
 * for the loser (DOR-1157). The label is what a person reads; the id is what
 * code matches on.
 *
 * **This is the only thing that can know.** A room turn leaves no marker in the
 * transcript head, so `classify-origin.ts` reads it as an ordinary
 * user-initiated session — which is exactly how the same conversation ended up
 * listed twice in "Jump back in": once as the room, once as the run underneath
 * it. The binding table is the server's own record of which sessions ARE room
 * turns, so the truth is here rather than inferred client-side from a title.
 *
 * Ordered AFTER the Pulse task overlay at every call site, and that ordering is
 * deliberate: a scheduled task that posts into a room is still a scheduled task
 * to the person who scheduled it, and "Scheduled task · nightly-digest" says
 * more than "#general" does. Whichever overlay runs last wins, so this one runs
 * first and Pulse overwrites it.
 */
export function applyRoomOriginOverlay(
  sessions: Session[],
  resolveRoomOrigins: ResolveRoomOrigins | undefined
): void {
  if (!resolveRoomOrigins || sessions.length === 0) return;
  const origins = resolveRoomOrigins(sessions.map((s) => s.id));
  if (origins.size === 0) return;
  for (const session of sessions) {
    const match = origins.get(session.id);
    if (match) {
      session.origin = 'room';
      session.originLabel = match.roomLabel;
      session.originRoomId = match.roomId;
      // A room turn's prompt IS another agent's post, byte for byte
      // (`room-turn-runner.ts`), so nothing in the transcript can tell it from
      // something the operator typed. Only this binding knows, so the reading
      // is dropped here (BC-16).
      dropUserLastMessageAtWithoutOperator(session);
    }
  }
}
