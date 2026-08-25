import { sqliteTable, text, integer, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

/**
 * One thing someone said, projected out of whichever store actually owns it
 * (message-search spec §4, ADR 260728-214214).
 *
 * **This is a derived index, not a store.** Rooms, Claude Code, Codex and
 * OpenCode each keep their own canonical record and DorkOS never writes to any
 * of them (ADR-0310; for OpenCode that means reading a throwaway copy of its
 * SQLite store and never the live file — ADR 260825-110420). Every row here is a copy that can be thrown away and rebuilt in
 * seconds, which is what lets the table be this small: no attachments, no tool
 * calls, no thinking blocks — only what was *said*.
 *
 * `id` is `INTEGER PRIMARY KEY`, which in SQLite makes it an alias for the
 * table's rowid. That is not incidental: `messages_fts` is an external-content
 * FTS5 table declared `content_rowid='id'`, so the two are joined by this
 * column and nothing else. Do not give it a type, a default, or `AUTOINCREMENT`
 * — any of the three costs the rowid alias and silently breaks the index.
 *
 * `origin_key` is **opaque**. It is a single string the projection composes and
 * the index never parses: the room projection sets it to `roomId` today, and to
 * `` `${communityRef}:${roomId}` `` once community scoping lands, with no
 * migration and no query change. Never make it a foreign key and never split it.
 *
 * `created_at` is nullable because not every source has one, and a fabricated
 * timestamp would sort results into an order nobody can explain.
 *
 * No column ships without a consumer (spec D11): `role` is rendered and
 * filtered, `created_at` orders and displays, `source_id` labels a result and
 * scopes the frontier, and `origin_key` + `ordinal` are the navigation
 * coordinates a hit resolves through. Widening later is a projection change and
 * a rebuild, not a migration.
 */
export const messages = sqliteTable(
  'messages',
  {
    /** Rowid alias. Bound to `messages_fts` via `content_rowid='id'`. */
    id: integer('id').primaryKey(),

    /** `'rooms' | 'claude-code' | 'codex' | 'opencode'`. Labels a result and scopes the frontier. */
    sourceId: text('source_id').notNull(),

    /** Opaque container id composed by the projection. Never parsed here. */
    originKey: text('origin_key').notNull(),

    /** Monotonic position within the container — `room_entries.seq`, or the index in a transcript. */
    ordinal: integer('ordinal').notNull(),

    /** `'user' | 'assistant'`. */
    role: text('role').notNull(),

    /** ISO-8601. Nullable: not every source records one. */
    createdAt: text('created_at'),

    /**
     * The searchable text. The name is load-bearing — `messages_fts` declares a
     * column of the same name and re-reads the original text *by name*, so
     * renaming this column here without renaming it there leaves `MATCH` and
     * `bm25()` working while `snippet()` fails at runtime.
     */
    body: text('body').notNull(),
  },
  (table) => [
    // The projection's idempotency key: re-reading a container it already read
    // must not duplicate its messages. A named unique INDEX rather than an
    // inline UNIQUE constraint, matching `rooms.ts` — identical enforcement,
    // and a name that shows up in the error and in `EXPLAIN QUERY PLAN`.
    //
    // Resolve a conflict on it with `ON CONFLICT ... DO UPDATE` or
    // `INSERT OR IGNORE`. Bare `INSERT OR REPLACE` is only safe here because
    // `createDb` sets `recursive_triggers = ON`: without it SQLite skips the
    // DELETE trigger for the row REPLACE removes, and the FTS5 index silently
    // keeps the old text. See the measurement in packages/db/src/index.ts.
    //
    // This is also the only index `messages` gets. Its leading columns are
    // `(source_id, origin_key)`, which is exactly the container, so frontier
    // reads and per-container deletes ride the same B-tree. A separate index
    // for them would carry a row per message to answer a query this one
    // already answers.
    uniqueIndex('messages_source_id_origin_key_ordinal_unique').on(
      table.sourceId,
      table.originKey,
      table.ordinal
    ),
  ]
);

/**
 * The frontier: one row per container, recording what the indexer has already
 * read (message-search spec §4).
 *
 * Change detection carries two signals rather than one because the two source
 * shapes fail differently. An append-only transcript file is caught up by
 * `byte_offset`, with `size_bytes` and `mtime_ms` as the cheap "has anything
 * happened" check that also catches a file that *shrank* — a rewrite, which a
 * byte offset alone would happily read straight past. A room's log has no file,
 * so it is caught up by `last_ordinal` instead.
 *
 * `container_path` is the working directory a search hit opens in. It lives
 * here and deliberately not on `messages`: it is constant per container, and
 * repeating it on every message row to save one join is the denormalization
 * that later disagrees with itself. `NULL` for sources with no directory — a
 * room is not a directory.
 *
 * `last_error` is what makes a broken projection visible. A projection that an
 * upstream format change has quietly broken produces no rows, and a source with
 * nothing new also produces no rows; without this column the two are
 * indistinguishable. That is the sharpest negative recorded in
 * ADR 260728-214214, and this is the answer to it.
 */
export const searchSources = sqliteTable(
  'search_sources',
  {
    /** `'rooms' | 'claude-code' | 'codex' | 'opencode'`. */
    sourceId: text('source_id').notNull(),

    /** The opaque container id, same composition as `messages.origin_key`. */
    originKey: text('origin_key').notNull(),

    /** File-backed sources: bytes already consumed. */
    byteOffset: integer('byte_offset'),

    /** File-backed sources: size at last read, so a shrink is detected as a rewrite. */
    sizeBytes: integer('size_bytes'),

    /** File-backed sources: mtime at last read — the cheap change signal. */
    mtimeMs: integer('mtime_ms'),

    /**
     * The highest `ordinal` this container has contributed, whichever mechanism
     * owns it: the log watermark for a row-backed source, the last message index
     * written out of a transcript for a file-backed one. Both write it, and both
     * read it back to tell "this container has nothing to say" apart from "the
     * rows this frontier claims are no longer in the index" — the second being
     * the state that makes a resume position a lie. `NULL` means the container
     * has produced no message yet, which for a transcript of nothing but tool
     * results is a permanent and correct answer.
     */
    lastOrdinal: integer('last_ordinal'),

    /** The cwd a hit opens in. NULL for sources with no directory. */
    containerPath: text('container_path'),

    /** ISO-8601 timestamp of the last indexing attempt, successful or not. */
    lastIndexedAt: text('last_indexed_at').notNull(),

    /** Why the last attempt produced nothing, or NULL if it succeeded. */
    lastError: text('last_error'),
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.originKey] })]
);
