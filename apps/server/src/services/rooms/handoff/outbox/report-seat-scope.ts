/** Read-only report recipient scope, from the durable room ledger alone. */
import { and, eq, roomMembers, rooms, authors, type Db } from '@dorkos/db';
import { RoomSessionLedger } from '../../session-bindings/room-session-ledger.js';

/**
 * The seat a saved report is checked for: that seat, `'unavailable'` when the chat is a room's
 * seat that cannot take it now, or null when the chat is no seat for this report and the report
 * goes to it as a chat message.
 */
export type ReportSeatScope =
  { roomId: string; authorId: string; joinedAt: string; agentPath: string } | 'unavailable' | null;

/**
 * Whether a spin-off of a session whose seat moved is still the seat's work: it started at or
 * before the move (DOR-3753). The old session stays a real chat a person can reopen, and a
 * spin-off started there afterwards is that chat's, not the seat's. An unknown start is never
 * taken for an early one.
 *
 * @param spinOffStartedAt - When the spin-off was first started (epoch ms), or null when unknown.
 * @param movedAt - When the seat moved off the session (epoch ms).
 */
export function spinOffPredatesMove(
  spinOffStartedAt: number | null | undefined,
  movedAt: number
): boolean {
  return typeof spinOffStartedAt === 'number' && spinOffStartedAt <= movedAt;
}

/**
 * A retired native ID and a deliberate seat move retain the original room/agent relation; a
 * move does only for a spin-off started at or before it ({@link spinOffPredatesMove}), while
 * the agent's membership then still stands. Otherwise the session the seat moved off is no seat
 * for this report, only the chat that started the spin-off: null, so the report goes there as a
 * chat message, the way the live path falls through (DOR-3753).
 *
 * @param db - The database.
 * @param sessionId - The chat the spin-off reports to.
 * @param spinOffStartedAt - When the reporting spin-off was first started, or null when unknown.
 */
export function reportSeatScope(
  db: Db,
  sessionId: string,
  spinOffStartedAt: number | null
): ReportSeatScope {
  const ledger = new RoomSessionLedger(db);
  const binding = ledger.bindingForSession(sessionId);
  const moved = binding ? undefined : ledger.seatMovedFrom(sessionId);
  const seat = binding ?? moved;
  if (!seat) return null;
  // Started after the move, or at an unknown time: the reopened old chat's own work, not the seat's.
  if (moved && !spinOffPredatesMove(spinOffStartedAt, moved.movedAt)) return null;
  const room = db.select().from(rooms).where(eq(rooms.id, seat.roomId)).get();
  const member = db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, seat.roomId), eq(roomMembers.authorId, seat.authorId)))
    .get();
  const author = db.select().from(authors).where(eq(authors.id, seat.authorId)).get();
  if (
    !room ||
    room.archived ||
    !member ||
    author?.kind !== 'agent' ||
    (moved && Date.parse(member.joinedAt) > moved.movedAt)
  )
    // The seat it moved to is gone or is a later membership: the old chat takes it, as live does.
    return moved ? null : 'unavailable';
  return {
    roomId: seat.roomId,
    authorId: seat.authorId,
    joinedAt: member.joinedAt,
    agentPath: author.naturalKey,
  };
}
