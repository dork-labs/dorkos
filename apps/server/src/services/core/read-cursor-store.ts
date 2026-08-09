/**
 * How far each person has read, in every kind of thread they can read
 * (team-room-home spec §D4, ADR 260808-140956).
 *
 * The one write path onto the `read_cursors` table, and the seam the read-state
 * route (`PUT /api/read-cursors/:kind/:id`) and the room + session migrations
 * are built on. It lives in `services/core/` because read state is not a room
 * concern or a session concern: rooms, agent sessions and the inbox all address
 * it, and none of them owns it.
 *
 * **Nothing serving a REQUEST writes through this class.** Every request-path
 * write goes through {@link ReadCursorService}, which is the only thing that
 * broadcasts `read_cursor` — a cursor moved silently here is a badge left lit on
 * the reader's other device, and nothing about the call site would say so. The
 * store is for the two callers that must NOT announce themselves: migrations and
 * backfills. Reads are open to anyone.
 *
 * **Not the agent cursor.** `RoomStore.setReadCursor` writes
 * `room_members.last_read_seq`, which is what an agent's ambient turn has been
 * SHOWN; this is what a person has LOOKED AT. Both survive, and neither is
 * derived from the other — see the `read_cursors` table docs in
 * `@dorkos/db`.
 *
 * @module server/services/core/read-cursor-store
 */
import { readCursors, and, eq, lt, type Db, type ReadCursorThreadKind } from '@dorkos/db';

/** One person's position in one thread. */
export interface ReadCursor {
  /** The person the cursor belongs to. */
  userId: string;
  /** Which store {@link ReadCursor.threadId} addresses. */
  threadKind: ReadCursorThreadKind;
  /** Opaque id within {@link ReadCursor.threadKind}. */
  threadId: string;
  /** The highest position this person has read. */
  lastReadSeq: number;
  /** ISO-8601 stamp of the write that last moved the cursor. */
  updatedAt: string;
}

/** Get and advance per-user read cursors. */
export class ReadCursorStore {
  /**
   * Binds the store to a database and a clock.
   *
   * @param db - The DorkOS database.
   * @param now - ISO-8601 clock, injected so a test can tell two writes apart.
   */
  constructor(
    private readonly db: Db,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  /**
   * Where this person has read up to, or `null` when they have never read this
   * thread.
   *
   * Absence is deliberately not folded into `0`: "never opened" and "read
   * nothing yet" look the same to a divider but not to a migration, and the
   * caller is the one that knows which it wants.
   *
   * @param userId - The person.
   * @param threadKind - Which kind of thread.
   * @param threadId - The thread.
   */
  get(userId: string, threadKind: ReadCursorThreadKind, threadId: string): ReadCursor | null {
    return (
      this.db
        .select()
        .from(readCursors)
        .where(
          and(
            eq(readCursors.userId, userId),
            eq(readCursors.threadKind, threadKind),
            eq(readCursors.threadId, threadId)
          )
        )
        .get() ?? null
    );
  }

  /**
   * Every thread of one kind this person has read, keyed by thread id.
   *
   * One query for a whole sidebar: the room list draws an unread badge per row
   * and would otherwise ask this table once per room. A thread the person has
   * never opened is simply absent, which every caller reads as 0 — the same
   * distinction {@link ReadCursorStore.get} keeps, kept the same way.
   *
   * @param userId - The person.
   * @param threadKind - Which kind of thread.
   */
  listForUser(userId: string, threadKind: ReadCursorThreadKind): Map<string, number> {
    const rows = this.db
      .select()
      .from(readCursors)
      .where(and(eq(readCursors.userId, userId), eq(readCursors.threadKind, threadKind)))
      .all();
    return new Map(rows.map((row) => [row.threadId, row.lastReadSeq]));
  }

  /**
   * Everybody who has read this one thread, keyed by person.
   *
   * The other axis of {@link ReadCursorStore.listForUser}, and one query for the
   * same reason: a room's roster reports a cursor per member, and asking per
   * member would make opening a room cost a query per person in it.
   *
   * @param threadKind - Which kind of thread.
   * @param threadId - The thread.
   */
  listForThread(threadKind: ReadCursorThreadKind, threadId: string): Map<string, number> {
    const rows = this.db
      .select()
      .from(readCursors)
      .where(and(eq(readCursors.threadKind, threadKind), eq(readCursors.threadId, threadId)))
      .all();
    return new Map(rows.map((row) => [row.userId, row.lastReadSeq]));
  }

  /**
   * Move this person's cursor forward, and only forward.
   *
   * Monotonic by predicate rather than by a read-then-write: the `lt()` in the
   * conflict clause is evaluated by SQLite against the stored row, so a stale
   * client on a second device cannot un-read a thread for the first one no
   * matter how the two writes interleave. The same discipline
   * `RoomStore.setReadCursor` uses on the agent-side cursor, for the same
   * reason.
   *
   * A rejected write leaves the row completely untouched — `updated_at`
   * included — so the stamp always names the moment the cursor actually moved.
   *
   * **Arguments are checked here, before SQLite sees them, and the errors name
   * the offending value.** The `CHECK` on the table would catch a negative seq,
   * but as a `SQLITE_CONSTRAINT` naming a constraint rather than a caller — and
   * `NaN`, `Infinity` and `1.5` are not caught by it at all: SQLite stores a
   * float in an `INTEGER` column and `NaN` silently becomes `NULL`, which the
   * `NOT NULL` then blames on the column. The cursor migrations in 3.3/3.4
   * compute these positions arithmetically, so an arithmetic bug has to arrive
   * as an arithmetic error with the number in it, not as constraint noise three
   * layers away from the subtraction that produced it.
   *
   * @param userId - The person. An `authors.id`; must not be empty.
   * @param threadKind - Which kind of thread.
   * @param threadId - The thread. Must not be empty.
   * @param lastReadSeq - The position they have now read to. A non-negative
   *   integer.
   * @throws RangeError - `lastReadSeq` is not a non-negative integer.
   * @throws TypeError - `userId` or `threadId` is empty.
   * @returns The cursor as it now stands, which is the higher of the stored
   *   value and the requested one.
   */
  set(
    userId: string,
    threadKind: ReadCursorThreadKind,
    threadId: string,
    lastReadSeq: number
  ): ReadCursor {
    if (!Number.isInteger(lastReadSeq) || lastReadSeq < 0) {
      throw new RangeError(
        `read cursor position must be a non-negative integer, got ${String(lastReadSeq)}`
      );
    }
    // Empty ids are refused rather than stored: the primary key would accept
    // `''` happily, and every later read for that person or that thread would
    // then answer with a row belonging to nobody in particular.
    if (userId === '') throw new TypeError('read cursor userId must not be empty');
    if (threadId === '') throw new TypeError('read cursor threadId must not be empty');

    const updatedAt = this.now();
    this.db
      .insert(readCursors)
      .values({ userId, threadKind, threadId, lastReadSeq, updatedAt })
      .onConflictDoUpdate({
        target: [readCursors.userId, readCursors.threadKind, readCursors.threadId],
        set: { lastReadSeq, updatedAt },
        setWhere: lt(readCursors.lastReadSeq, lastReadSeq),
      })
      .run();

    // A second read rather than `.returning()` on the statement above, and it
    // cannot be folded away: `setWhere` makes a refused write update ZERO rows,
    // so `.returning()` would hand back nothing exactly when the caller most
    // needs an answer — and the refused write is the COMMON case here, since
    // re-opening a thread already read is what most calls are. Non-null by
    // construction either way: the statement inserted the row or found one to
    // conflict with.
    return this.get(userId, threadKind, threadId)!;
  }
}
