/**
 * Migration 0096 — `canvas_documents`, the table a room's shared canvas lives in
 * (spec `room-canvas` §1).
 *
 * Three properties are asserted here rather than left to review, and each one is
 * a silent failure somewhere else if it is wrong.
 *
 * **The indexes.** Drizzle ignores a standalone `index(...)` export WITHOUT
 * error (`.claude/rules/testing.md`), so a table can be declared with four
 * indexes and generated with none while every type-check passes. The only place
 * that shows is the SQL, which is what this file reads.
 *
 * **The cascade, and the thing that is NOT a cascade.** Deleting a room deletes
 * its documents, because a canvas row has no meaning without its room. ARCHIVING
 * a room deletes nothing — archive is a flag, so the constraint never fires, and
 * a dormant room keeps its whole table and shows it read-only. Getting that pair
 * backwards would either orphan rows forever or throw away a room's record the
 * day somebody archived it.
 *
 * **The dedupe key.** `(scope, source_key)` is unique, which is what makes two
 * agents opening the same file land on one document instead of two.
 *
 * Everything runs against a database built by the REAL Drizzle migrator over the
 * committed migrations, never by executing this migration's SQL inline — an
 * inline copy only proves the test's transcription parses.
 *
 * @module db/tests/canvas-documents-migration
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { createDb, runMigrations } from '../index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/** The migration under test. */
const TAG = '0096_charming_darwin';

type Raw = Database.Database;

/** A database with every committed migration applied, as production runs them. */
function migrated(): Raw {
  const db = createDb(':memory:');
  runMigrations(db);
  db.$client.pragma('foreign_keys = ON');
  return db.$client;
}

/** Insert a room, so a canvas document has something to hang off. */
function seedRoom(raw: Raw, id: string, archived = false): void {
  raw
    .prepare(
      'INSERT INTO rooms (id, kind, slug, title, topic, archived, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      'channel',
      id,
      `#${id}`,
      null,
      archived ? 1 : 0,
      '2026-09-11T10:00:00Z',
      '2026-09-11T10:00:00Z'
    );
}

/** Insert one canvas document, defaulting everything a caller does not name. */
function seedDocument(
  raw: Raw,
  input: { id: string; roomId: string; sourceKey: string | null; scope?: string }
): void {
  raw
    .prepare(
      `INSERT INTO canvas_documents
        (id, scope, room_id, content, title, content_type, author_id, source_key, source_label,
         resolved_cwd, pinned, rev, last_touched_by, last_touched_at, opened_at, last_active_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.id,
      input.scope ?? `room:${input.roomId}`,
      input.roomId,
      JSON.stringify({ type: 'url', url: 'https://example.test' }),
      'Example',
      'url',
      'author-ana',
      input.sourceKey,
      null,
      null,
      0,
      1,
      'author-ana',
      '2026-09-11T10:00:00Z',
      '2026-09-11T10:00:00Z',
      '2026-09-11T10:00:00Z'
    );
}

const indexesOf = (raw: Raw, table: string): string[] =>
  (
    raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?").all(table) as {
      name: string;
    }[]
  ).map((i) => i.name);

describe('0096 — the room canvas table', () => {
  it('is in the journal under the tag this file names', () => {
    const journal = JSON.parse(
      readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain(TAG);
  });

  it('creates the table with every column the spec names, and ISO-text timestamps', () => {
    const columns = migrated().prepare('PRAGMA table_info(canvas_documents)').all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];

    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'scope',
      'room_id',
      'content',
      'title',
      'content_type',
      'author_id',
      'source_key',
      'source_label',
      'resolved_cwd',
      'pinned',
      'rev',
      'last_touched_by',
      'last_touched_at',
      'editing_by',
      'editing_heartbeat_at',
      'opened_at',
      'last_active_at',
    ]);
    expect(columns.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['id']);
    // Every timestamp is TEXT, as every sibling table in the rooms schema
    // already is. An integer column here would read back as a `Date` where every
    // neighbour reads back as a string.
    for (const name of ['last_touched_at', 'editing_heartbeat_at', 'opened_at', 'last_active_at']) {
      expect(columns.find((c) => c.name === name)?.type, `${name} must be TEXT`).toBe('TEXT');
    }
  });

  it('carries all four indexes — the failure Drizzle would not report', () => {
    const names = indexesOf(migrated(), 'canvas_documents');
    expect(names).toContain('idx_canvas_documents_room');
    expect(names).toContain('canvas_documents_source_unique');
    expect(names).toContain('idx_canvas_documents_type');
    expect(names).toContain('idx_canvas_documents_last_touched');
  });

  it('refuses two documents with the same source key in one scope', () => {
    const raw = migrated();
    seedRoom(raw, 'general');
    seedDocument(raw, { id: 'doc-1', roomId: 'general', sourceKey: 'path:/src/router.ts' });
    expect(() =>
      seedDocument(raw, { id: 'doc-2', roomId: 'general', sourceKey: 'path:/src/router.ts' })
    ).toThrow(/UNIQUE/i);
  });

  it('lets many documents carry no source key at all', () => {
    // `json` and `widget` have no natural identity, so every open of one is a
    // fresh document. SQLite treats NULLs as distinct in a unique index, which
    // is exactly the behaviour that makes this work — pinned here because a
    // future change to a NOT NULL sentinel would silently collapse them.
    const raw = migrated();
    seedRoom(raw, 'general');
    seedDocument(raw, { id: 'doc-1', roomId: 'general', sourceKey: null });
    seedDocument(raw, { id: 'doc-2', roomId: 'general', sourceKey: null });
    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM canvas_documents').get() as { n: number }
    ).toEqual({ n: 2 });
  });

  it('refuses a document for a room that does not exist', () => {
    const raw = migrated();
    expect(() => seedDocument(raw, { id: 'doc-1', roomId: 'ghost', sourceKey: null })).toThrow(
      /FOREIGN KEY/i
    );
  });

  it('takes a room’s documents with the room when the room is DELETED', () => {
    const raw = migrated();
    seedRoom(raw, 'general');
    seedDocument(raw, { id: 'doc-1', roomId: 'general', sourceKey: null });
    raw.prepare('DELETE FROM rooms WHERE id = ?').run('general');
    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM canvas_documents').get() as { n: number }
    ).toEqual({ n: 0 });
  });

  it('keeps a room’s documents when the room is ARCHIVED', () => {
    // The asymmetry archiving exists for: the record survives, the activity
    // stops. Archive is a flag on `rooms`, so the cascade never fires — and the
    // service refuses every WRITE on an archived room instead.
    const raw = migrated();
    seedRoom(raw, 'general');
    seedDocument(raw, { id: 'doc-1', roomId: 'general', sourceKey: null });
    raw.prepare('UPDATE rooms SET archived = 1 WHERE id = ?').run('general');
    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM canvas_documents').get() as { n: number }
    ).toEqual({ n: 1 });
  });
});
