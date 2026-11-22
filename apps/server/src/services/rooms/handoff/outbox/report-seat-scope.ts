/** Read-only report recipient scope, from the durable room ledger alone. */
import { and, eq, roomMembers, rooms, authors, type Db } from '@dorkos/db';
import { RoomSessionLedger } from '../../session-bindings/room-session-ledger.js';

export type ReportSeatScope =
  { roomId: string; authorId: string; joinedAt: string; agentPath: string } | 'unavailable' | null;

/** A retired native ID and a deliberate seat move retain the original room/agent relation. */
export function reportSeatScope(db: Db, sessionId: string): ReportSeatScope {
  const ledger = new RoomSessionLedger(db);
  const binding = ledger.bindingForSession(sessionId);
  const moved = binding ? undefined : ledger.seatMovedFrom(sessionId);
  const seat = binding ?? moved;
  if (!seat) return null;
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
    return 'unavailable';
  return {
    roomId: seat.roomId,
    authorId: seat.authorId,
    joinedAt: member.joinedAt,
    agentPath: author.naturalKey,
  };
}
