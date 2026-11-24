import {
  and,
  eq,
  inArray,
  isNull,
  ne,
  or,
  roomSessions,
  sessionBirthAllocations,
  sessionMessageQueue,
  sessionMetadata,
  sessionNativeBindings,
  sql,
} from '@dorkos/db';
import type { Db, DbTransaction, SQL } from '@dorkos/db';

type RoomSeat = typeof roomSessions.$inferInsert;
type SeatKey = Pick<RoomSeat, 'roomId' | 'authorId' | 'sessionId'>;

/** The durable generation of a pending birth, read from the room's own storage. */
export interface RoomSeatBirth {
  allocationCreatedAt: string;
  seatCreatedAt: string;
}

/** Read the session already bound to this room member. */
export function readRoomSeatSession(
  db: Db | DbTransaction,
  roomId: string,
  authorId: string
): string | null {
  const seat = db
    .select({ sessionId: roomSessions.sessionId })
    .from(roomSessions)
    .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
    .get();
  return seat?.sessionId ?? null;
}

function anotherSessionUsesSeatId(tx: Db | DbTransaction, seat: RoomSeat): boolean {
  const { sessionId, roomId, authorId } = seat;
  return Boolean(
    tx.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, sessionId)).get() ||
    tx
      .select()
      .from(sessionNativeBindings)
      .where(eq(sessionNativeBindings.sessionId, sessionId))
      .get() ||
    tx
      .select()
      .from(sessionMessageQueue)
      .where(eq(sessionMessageQueue.sessionId, sessionId))
      .get() ||
    tx
      .select()
      .from(roomSessions)
      .where(
        and(
          eq(roomSessions.sessionId, sessionId),
          or(ne(roomSessions.roomId, roomId), ne(roomSessions.authorId, authorId))
        )
      )
      .get()
  );
}

/** Bind the winning seat and reserve birth only when the caller just minted its id. */
export function bindRoomSeat(db: Db, seat: RoomSeat, birth?: 'minted'): string {
  const write = (tx: Db | DbTransaction) => {
    const insert = tx.insert(roomSessions).values(seat).onConflictDoNothing().run();
    if (insert.changes === 1) {
      if (birth === 'minted') {
        if (anotherSessionUsesSeatId(tx, seat)) throw new Error('Room seat ID is already in use.');
        const reserved = tx
          .insert(sessionBirthAllocations)
          .values({
            version: 1,
            sessionId: seat.sessionId,
            createdAt: seat.createdAt,
            sourceKind: 'internal',
            internalSource: {
              kind: 'room-seat',
              roomId: seat.roomId,
              authorId: seat.authorId,
              boundSessionId: seat.sessionId,
              seatCreatedAt: seat.createdAt,
            },
          })
          .run();
        if (reserved.changes !== 1) throw new Error('Could not record the new room seat.');
      }
      return seat.sessionId;
    }
    const winner = readRoomSeatSession(tx, seat.roomId, seat.authorId);
    if (winner === null && birth === 'minted') throw new Error('Room seat insert has no winner.');
    return winner ?? seat.sessionId;
  };
  return birth === 'minted' ? db.transaction(write, { behavior: 'immediate' }) : write(db);
}

/** Read the pending birth for this exact seat, without inferring one from a legacy binding. */
export function readRoomSeatBirth(db: Db, seat: SeatKey): RoomSeatBirth | undefined {
  const allocation = db
    .select()
    .from(sessionBirthAllocations)
    .where(eq(sessionBirthAllocations.sessionId, seat.sessionId))
    .get();
  const source = allocation?.internalSource;
  if (
    allocation?.sourceKind !== 'internal' ||
    source?.kind !== 'room-seat' ||
    source.roomId !== seat.roomId ||
    source.authorId !== seat.authorId ||
    source.boundSessionId !== seat.sessionId
  )
    return undefined;
  return { allocationCreatedAt: allocation.createdAt, seatCreatedAt: source.seatCreatedAt };
}

/** Retire only the pending allocations and unbound drafts of the exact seats being removed. */
export function forgetRoomSeatBirths(db: Db | DbTransaction, scope: SQL): void {
  const source = sessionBirthAllocations.internalSource;
  const seats = db
    .select({ sessionId: roomSessions.sessionId })
    .from(roomSessions)
    .where(
      and(
        scope,
        eq(roomSessions.sessionId, sessionBirthAllocations.sessionId),
        eq(roomSessions.sessionId, sql<string>`json_extract(${source}, '$.boundSessionId')`),
        eq(roomSessions.roomId, sql<string>`json_extract(${source}, '$.roomId')`),
        eq(roomSessions.authorId, sql<string>`json_extract(${source}, '$.authorId')`),
        eq(roomSessions.createdAt, sql<string>`json_extract(${source}, '$.seatCreatedAt')`)
      )
    );
  const exactSource = and(
    eq(sessionBirthAllocations.sourceKind, 'internal'),
    sql`json_extract(${source}, '$.kind') = 'room-seat'`,
    sql`exists ${seats}`
  );
  const exactDraftIds = db
    .select({ sessionId: sessionBirthAllocations.sessionId })
    .from(sessionBirthAllocations)
    .where(exactSource);
  db.delete(sessionMetadata)
    .where(
      and(
        inArray(sessionMetadata.sessionId, exactDraftIds),
        isNull(sessionMetadata.runtime),
        eq(sessionMetadata.modelLaunchState, 'pending-v1'),
        isNull(sessionMetadata.agentPath),
        isNull(sessionMetadata.launchOrigin)
      )
    )
    .run();
  db.delete(sessionBirthAllocations).where(exactSource).run();
}

/** Delete a seat and its exact pending birth inside the caller's transaction. */
export function deleteRoomSeat(db: Db | DbTransaction, roomId: string, authorId: string): void {
  const scope = sql`${roomSessions.roomId} = ${roomId} and ${roomSessions.authorId} = ${authorId}`;
  forgetRoomSeatBirths(db, scope);
  db.delete(roomSessions).where(scope).run();
}

/** Replace a seat's session without transferring any unconsumed birth to a new owner. */
export function replaceRoomSeat(db: Db, seat: SeatKey): boolean {
  return db.transaction(
    (tx) => {
      const scope = sql`${roomSessions.roomId} = ${seat.roomId} and ${roomSessions.authorId} = ${seat.authorId}`;
      forgetRoomSeatBirths(tx, sql`${scope} and ${ne(roomSessions.sessionId, seat.sessionId)}`);
      const result = tx.update(roomSessions).set({ sessionId: seat.sessionId }).where(scope).run();
      return result.changes > 0;
    },
    { behavior: 'immediate' }
  );
}
