import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { createDb, runMigrations } from '../index';

/** The migration that added `message_id` and rebuilt the index (DOR-1579). */
const MIGRATION_0080 = new URL('../../drizzle/0080_message_search_message_id.sql', import.meta.url);

/**
 * Everything here runs against a database built by the REAL Drizzle migrator
 * over the committed migrations — never by executing the migration's SQL inline,
 * which would only prove the test's copy of it parses.
 *
 * That matters more for 0037 than for any migration before it. Half of
 * `0037_message_search.sql` is hand-written (`drizzle-orm@0.45.2/sqlite-core`
 * has no virtual-table builder, so an FTS5 index cannot be declared in
 * `src/schema/`), and `scripts/assert-migrations-current.sh` compares the schema
 * files against the snapshot — so it cannot see the FTS5 half at all. This file
 * is the only thing that guards it.
 */
function migrated(): BetterSqlite3.Database {
  const db = createDb(':memory:');
  runMigrations(db);
  return db.$client;
}

const COLUMNS_AND_VALUES =
  'INTO messages (id, source_id, origin_key, ordinal, role, created_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)';
const INSERT = `INSERT ${COLUMNS_AND_VALUES}`;
const REPLACE = `INSERT OR REPLACE ${COLUMNS_AND_VALUES}`;

/** Seeds four messages: three that stem to `dogs`, one that does not. */
function seedDogs(raw: BetterSqlite3.Database): void {
  const insert = raw.prepare(INSERT);
  insert.run(1, 'rooms', 'room-1', 1, 'user', '2026-07-28T10:00:00Z', 'we talked about a dog');
  insert.run(2, 'rooms', 'room-1', 2, 'assistant', '2026-07-28T10:00:01Z', 'two dogs actually');
  insert.run(3, 'rooms', 'room-1', 3, 'user', '2026-07-28T10:00:02Z', 'he DOGGED the point');
  insert.run(4, 'rooms', 'room-1', 4, 'user', '2026-07-28T10:00:03Z', 'nothing relevant here');
}

const countMatching = (raw: BetterSqlite3.Database, query: string): number =>
  (
    raw.prepare('SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH ?').get(query) as {
      c: number;
    }
  ).c;

describe('0037_message_search — messages, search_sources, messages_fts', () => {
  describe('the two real tables', () => {
    it('gives messages exactly the columns spec §4 lists, with created_at the only nullable one', () => {
      // Red if a column is dropped, renamed, or has its nullability flipped —
      // asserted off the migrated database rather than off the schema file,
      // because half this migration is hand-written and the two can disagree.
      const columns = migrated().prepare('PRAGMA table_info(messages)').all() as {
        name: string;
        notnull: number;
      }[];

      expect(columns.map((c) => c.name)).toEqual([
        'id',
        'source_id',
        'origin_key',
        'ordinal',
        'role',
        'created_at',
        'body',
        // Added by 0080, so it sits last: SQLite appends an ALTER TABLE column.
        'message_id',
      ]);
      expect(columns.filter((c) => c.notnull === 0).map((c) => c.name)).toEqual([
        'created_at',
        // Nullable on purpose (DOR-1579): a room needs no message id, and a
        // transcript record that carries none contributes nothing rather than an
        // id invented at index time.
        'message_id',
      ]);
    });

    it('makes messages.id an alias for the rowid', () => {
      // The FTS5 index reaches the text by rowid. That only works while `id` is
      // an INTEGER PRIMARY KEY, i.e. an alias for the rowid. Red the moment
      // `id` becomes a text key or gains a non-integer type: the two stop being
      // the same number and the index points at nothing.
      //
      // This pins the ALIAS, which is the real invariant, and deliberately does
      // not claim to pin the `content_rowid='id'` clause in 0037. Measured:
      // deleting that clause reds nothing, because FTS5 then defaults to the
      // rowid and — precisely BECAUSE `id` is its alias — resolves to the same
      // column. The clause is documentation of intent, and it stays correct for
      // exactly as long as this assertion holds.
      const raw = migrated();
      raw
        .prepare(
          "INSERT INTO messages (source_id, origin_key, ordinal, role, body) VALUES ('rooms', 'room-1', 1, 'user', 'assigned by sqlite')"
        )
        .run();

      const row = raw.prepare('SELECT rowid AS row_id, id AS pk FROM messages').get() as {
        row_id: number;
        pk: number;
      };
      expect(row.pk).toBe(row.row_id);
      expect(typeof row.pk).toBe('number');
    });

    it('rejects a second message at the same (source_id, origin_key, ordinal)', () => {
      // The projection's idempotency key. Red if the unique index is missing:
      // re-reading a container it already read would duplicate every message.
      const raw = migrated();
      raw.prepare(INSERT).run(1, 'rooms', 'room-1', 7, 'user', null, 'first');

      expect(() => {
        raw.prepare(INSERT).run(2, 'rooms', 'room-1', 7, 'assistant', null, 'second');
      }).toThrow(/UNIQUE/);

      // Same ordinal in a DIFFERENT container is legal — the constraint is the
      // triple, not the ordinal.
      expect(() => {
        raw.prepare(INSERT).run(3, 'rooms', 'room-2', 7, 'user', null, 'other room');
      }).not.toThrow();
    });

    it('gives search_sources the columns spec §4 lists, with only last_indexed_at required', () => {
      const columns = migrated().prepare('PRAGMA table_info(search_sources)').all() as {
        name: string;
        notnull: number;
      }[];

      expect(columns.map((c) => c.name)).toEqual([
        'source_id',
        'origin_key',
        'byte_offset',
        'size_bytes',
        'mtime_ms',
        'last_ordinal',
        'container_path',
        'last_indexed_at',
        'last_error',
      ]);
      // `container_path` and `last_error` are nullable on purpose: a room has no
      // directory, and a source that succeeded has no error.
      expect(columns.filter((c) => c.notnull === 1).map((c) => c.name)).toEqual([
        'source_id',
        'origin_key',
        'last_indexed_at',
      ]);
    });

    it('keys search_sources on the container — the pair, not either half', () => {
      // Red if the primary key collapses to `source_id`: the second insert would
      // be refused, and one row per RUNTIME cannot be a frontier over containers.
      const raw = migrated();
      const insert = raw.prepare(
        'INSERT INTO search_sources (source_id, origin_key, last_indexed_at) VALUES (?, ?, ?)'
      );
      insert.run('claude-code', 'session-a', '2026-07-28T10:00:00Z');

      expect(() => insert.run('claude-code', 'session-b', '2026-07-28T10:00:00Z')).not.toThrow();
      expect(() => insert.run('rooms', 'session-a', '2026-07-28T10:00:00Z')).not.toThrow();
      expect(() => insert.run('claude-code', 'session-a', '2026-07-28T11:00:00Z')).toThrow(
        /UNIQUE|PRIMARY/
      );
    });
  });

  describe('the FTS5 index', () => {
    it('names its column body, so snippet() can re-read the original text', () => {
      // THE assertion that catches the misnamed-column trap, and the only one
      // that does. With `content='messages'` FTS5 re-reads the text out of the
      // content table BY COLUMN NAME; measured against a deliberately mismatched
      // name, `MATCH` returns the same 3 hits and `bm25()` the same score while
      // this line fails with `SQL logic error`. A MATCH-only test is blind to it.
      const raw = migrated();
      seedDogs(raw);

      const row = raw
        .prepare(
          "SELECT snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS s FROM messages_fts WHERE messages_fts MATCH 'dogs' ORDER BY rowid LIMIT 1"
        )
        .get() as { s: string };

      expect(row.s).toContain('<mark>');
      expect(row.s).toBe('we talked about a <mark>dog</mark>');
    });

    it('stems, so searching dogs finds dog, dogs and DOGGED', () => {
      // Red under a bare `unicode61` tokenizer, which returns 1 — the literal
      // `dogs` and nothing else. This is the difference between a search box
      // that works and one that makes you guess the exact word you typed.
      const raw = migrated();
      seedDogs(raw);

      expect(countMatching(raw, 'dogs')).toBe(3);
      expect(countMatching(raw, 'dog')).toBe(3);
      // Still a search, not a substring scan: the fourth row never matches.
      expect(countMatching(raw, 'relevant')).toBe(1);
    });

    it('ranks with bm25()', () => {
      const raw = migrated();
      seedDogs(raw);

      const ranked = raw
        .prepare(
          "SELECT rowid, bm25(messages_fts) AS score FROM messages_fts WHERE messages_fts MATCH 'dogs' ORDER BY score"
        )
        .all() as { rowid: number; score: number }[];

      expect(ranked).toHaveLength(3);
      expect(ranked.every((r) => Number.isFinite(r.score))).toBe(true);
    });
  });

  describe('the three sync triggers', () => {
    it('indexes a message on INSERT', () => {
      const raw = migrated();
      expect(countMatching(raw, 'dogs')).toBe(0);

      seedDogs(raw);

      // Red without the AFTER INSERT trigger: an external-content FTS5 table
      // stores no copy of the text and indexes nothing on its own.
      expect(countMatching(raw, 'dogs')).toBe(3);
    });

    it('retracts the old text and indexes the new one on UPDATE', () => {
      const raw = migrated();
      seedDogs(raw);

      raw.prepare("UPDATE messages SET body = 'cats' WHERE id = 2").run();

      // Red without the AFTER UPDATE trigger, in both directions and measured
      // that way: the stale index keeps answering 3 for `dogs` and 0 for `cats`,
      // so a search finds a message that no longer says what it matched on.
      expect(countMatching(raw, 'dogs')).toBe(2);
      expect(countMatching(raw, 'cats')).toBe(1);
    });

    it('retracts BEFORE it re-indexes, so a word in both bodies survives', () => {
      // The AFTER UPDATE trigger's two statements are order-dependent, and the
      // case above cannot see it: `two dogs` -> `cats` shares no term, so
      // retract-then-insert and insert-then-retract agree. Sharing a term is the
      // realistic edit — a message re-projected after a small change — and there
      // the wrong order retracts the word it has just re-indexed.
      //
      // Measured, swapping the two statements in 0037: `dog` drops to 0. A word
      // present in BOTH the old and the new body vanishes from the index, and
      // every integrity check still reports ok.
      const raw = migrated();
      raw.prepare(INSERT).run(1, 'rooms', 'room-1', 1, 'user', null, 'the dog barked loudly');

      raw.prepare("UPDATE messages SET body = 'the dog purred loudly' WHERE id = 1").run();

      expect(countMatching(raw, 'dog')).toBe(1);
      expect(countMatching(raw, 'loudly')).toBe(1);
      expect(countMatching(raw, 'purred')).toBe(1);
      expect(countMatching(raw, 'barked')).toBe(0);
    });

    it('retracts the text on DELETE', () => {
      const raw = migrated();
      seedDogs(raw);

      raw.prepare('DELETE FROM messages').run();

      // MATCH, deliberately, and NOT `SELECT count(*) FROM messages_fts`.
      // Measured: an unqualified count over an external-content table reads the
      // CONTENT table, so it returns 0 whether or not the trigger exists and
      // cannot fail. This one returns 3 without the AFTER DELETE trigger.
      expect(countMatching(raw, 'dogs')).toBe(0);

      // And the orphans are not merely invisible — reading one is an error.
      // Without the trigger this raises `database disk image is malformed`,
      // because the index still points at content rows that are gone.
      expect(() =>
        raw
          .prepare(
            "SELECT snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS s FROM messages_fts WHERE messages_fts MATCH 'dogs'"
          )
          .all()
      ).not.toThrow();
    });

    it('fires the DELETE trigger for a row REPLACE removes', () => {
      // The trap this whole schema walks into by design. `messages` carries a
      // unique key described as an idempotency key, so the obvious way to
      // re-project a container is `INSERT OR REPLACE` — and SQLite runs a
      // table's DELETE triggers for rows that REPLACE removes ONLY when
      // `recursive_triggers` is on. It is off by default; `createDb` turns it
      // on, and this is what proves it.
      //
      // Red without that pragma, and silent in production without it: measured,
      // `MATCH 'dog'` returns 1 for text that exists nowhere, `bm25()` scores it
      // happily, and BOTH `PRAGMA integrity_check` and FTS5's own
      // `integrity-check` report ok. Only `snippet()` gives it away.
      const raw = migrated();
      raw.prepare(INSERT).run(1, 'rooms', 'room-1', 1, 'user', null, 'the dog barked');

      // Same (source_id, origin_key, ordinal) — a re-read of a container the
      // indexer had already read.
      raw.prepare(REPLACE).run(2, 'rooms', 'room-1', 1, 'user', null, 'cats now');

      expect(raw.prepare('SELECT count(*) AS c FROM messages').get()).toEqual({ c: 1 });
      expect(countMatching(raw, 'dog')).toBe(0);
      expect(countMatching(raw, 'cats')).toBe(1);
      expect(() =>
        raw
          .prepare(
            "SELECT snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS s FROM messages_fts WHERE messages_fts MATCH 'dog'"
          )
          .all()
      ).not.toThrow();
    });

    it('empties the index when 0080 runs, so the next sweep rewrites it with ids', () => {
      // The BACKFILL, and it is a rebuild (DOR-1579). `message_id` arrives empty
      // on every row already indexed and no statement could fill it — the ids
      // live in the stores this index is derived from — so 0080 throws the
      // derived copy away and lets the next sweep write it again.
      //
      // Run against the REAL migration file, and against a database that has
      // been put back into the shape 0080 expects (the column dropped, rows in
      // the tables). Executing a copy of the SQL would only prove this test's
      // copy parses; asserting on a freshly-migrated database would prove
      // nothing at all, since it is empty either way.
      const raw = migrated();
      raw.prepare(INSERT).run(1, 'rooms', 'room-1', 1, 'user', null, 'the dog barked');
      raw
        .prepare(
          "INSERT INTO search_sources (source_id, origin_key, last_indexed_at) VALUES ('rooms', 'room-1', '2026-08-26T10:00:00Z')"
        )
        .run();
      raw.exec('ALTER TABLE messages DROP COLUMN message_id');
      expect(countMatching(raw, 'dog')).toBe(1);

      raw.exec(readFileSync(MIGRATION_0080, 'utf8'));

      expect(raw.prepare('SELECT count(*) AS c FROM messages').get()).toEqual({ c: 0 });
      expect(raw.prepare('SELECT count(*) AS c FROM search_sources').get()).toEqual({ c: 0 });
      // The half a `DROP TABLE` or a `DELETE` that skipped the trigger would
      // leave behind: FTS5 external content keeps no copy of the text, so only
      // `messages_fts_ad` firing per row retracts its terms. Without it the
      // index goes on answering for text that exists nowhere.
      expect(countMatching(raw, 'dog')).toBe(0);
      expect(
        (raw.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name)
      ).toContain('message_id');
    });

    it('keeps recursive_triggers on, because REPLACE depends on it', () => {
      // Named separately from the behaviour above so that removing the pragma
      // reds something that says WHICH knob moved, not only that search broke.
      const db = createDb(':memory:');
      expect(db.$client.pragma('recursive_triggers', { simple: true })).toBe(1);
    });
  });
});
