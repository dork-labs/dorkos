import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey, check } from 'drizzle-orm/sqlite-core';

/**
 * The three kinds of thread a person can have read state in
 * (team-room-home spec §D4, ADR 260808-140956).
 *
 * One list, used twice: it types {@link readCursors.threadKind} and it builds
 * the table's `CHECK`, so a fourth kind cannot be added to one half and
 * forgotten in the other.
 */
export const READ_CURSOR_THREAD_KINDS = ['room', 'session', 'inbox'] as const;

/** What kind of thing a read cursor points into. */
export type ReadCursorThreadKind = (typeof READ_CURSOR_THREAD_KINDS)[number];

/**
 * How far a PERSON has read in one thread — the single user-side read-state
 * store (team-room-home spec §D4, ADR 260808-140956).
 *
 * `(user_id, thread_kind, thread_id) → last_read_seq`. One row per person per
 * thread, O(1) storage, no per-message receipts: the industry-standard shape
 * (Slack, Discord, Telegram, Matrix all converge on a monotonic position
 * cursor) and the only one that stays cheap as a log grows.
 *
 * **This is the USER-side cursor. `room_members.last_read_seq` is the
 * AGENT-side one, and it survives.** They read the same-looking number and
 * answer different questions. The membership column is what the room's ambient
 * participation loop advances when it CLAIMS a turn — it says which entries an
 * agent has already been shown, and it is rewound when a claimed turn refuses
 * (room-participation spec §8.3). This table says which entries a human has
 * looked at, so it is written by a person's client and broadcast to that
 * person's other devices. Nothing may read one to answer the other's question,
 * and no migration collapses them.
 *
 * **Per-user by construction.** `user_id` is `NOT NULL` and is not a
 * placeholder for "the local human": the day a room holds two people, each one
 * already has their own row, and no query can accidentally read across users
 * because the user is the leading key column.
 *
 * **`thread_id` is opaque and carries no foreign key.** It is a room id, a
 * session id, or an inbox item id depending on `thread_kind`, and those live in
 * three different stores — one of them (sessions) not in this database at all,
 * because session storage is runtime-owned (ADR-0310). A cursor is also
 * meaningful for a thread that has been deleted or has not synced yet, so a
 * constraint here would delete read state as a side effect of a cleanup
 * elsewhere.
 *
 * **`last_read_seq` is a position, not a time.** Rooms already number entries
 * with a monotonic `seq`, and sessions number durable SSE events the same way,
 * so both sides compare integers on a key rather than parsing timestamps whose
 * ordering depends on whose clock wrote them.
 *
 * Monotonicity is a WRITE-PATH invariant, deliberately not a `CHECK`: a cursor
 * only ever moves forward, which SQLite cannot express about a value's own
 * previous state. `ReadCursorStore.set` enforces it with the same `lt()`
 * predicate `RoomStore.setReadCursor` uses.
 */
export const readCursors = sqliteTable(
  'read_cursors',
  {
    /**
     * The person this cursor belongs to. Never null, never a shared sentinel.
     *
     * **This is an `authors.id` — what `resolveCaller(res).id` returns, the
     * same namespace as `room_members.author_id`. It is NEVER the Better Auth
     * `user.id`.** The two look alike (both opaque strings for the same human)
     * and neither a type nor a foreign key here can tell them apart, so the
     * mistake would land silently and stay silent. What it costs: one person
     * ends up with two rows for one thread, and their unread divider resets to
     * the top the moment login is turned on or off — because branch 2 and
     * branch 3 of `resolveCaller` deliberately hand back the SAME author id,
     * while the account id exists in only one of them. Read the account id
     * through `bindOwner` and store what it hands back, never the account id
     * itself.
     */
    userId: text('user_id').notNull(),

    /** `'room' | 'session' | 'inbox'` — which store `thread_id` addresses. */
    threadKind: text('thread_kind').$type<ReadCursorThreadKind>().notNull(),

    /** Opaque id within `thread_kind`. Never joined, never parsed. */
    threadId: text('thread_id').notNull(),

    /** The highest position this person has read. Moves forward only. */
    lastReadSeq: integer('last_read_seq').notNull(),

    /** ISO-8601 timestamp of the last write that actually moved the cursor. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.threadKind, table.threadId] }),
    // `sql.raw` for the list, and it is not a shortcut. A value interpolated
    // into a `sql` template becomes a BIND PARAMETER, and drizzle-kit writes
    // the parameter marker straight into the migration file — `IN (?, ?, ?)`,
    // which is a syntax error the moment the migration runs. Nothing here comes
    // from outside this module, so raw is exactly as safe as a literal.
    check(
      'read_cursors_thread_kind',
      sql`${table.threadKind} IN (${sql.raw(
        READ_CURSOR_THREAD_KINDS.map((kind) => `'${kind}'`).join(', ')
      )})`
    ),
    // A position is a count of things read, so it has a floor and the database
    // knows it. Monotonicity is not expressible here (it is about a value's own
    // previous state) but non-negativity is about the value alone, and a
    // negative cursor is the shape a sign error takes: `-1` reads as "less than
    // every entry", which silently marks a whole thread unread forever rather
    // than failing anywhere a log would show it.
    //
    // `sql.raw` for the literal, for the same reason the kind list above uses
    // it: an interpolated `0` becomes a bind parameter, and drizzle-kit writes
    // the marker into the migration file, where `>= ?` is a syntax error the
    // first time the migration runs.
    check('read_cursors_last_read_seq', sql`${table.lastReadSeq} >= ${sql.raw('0')}`),
  ]
);
