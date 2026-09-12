/**
 * Migration 0097 — `canvas_documents` starts serving two scopes (spec
 * `canvas-agent-seat` §1.1).
 *
 * SQLite cannot change a column's nullability or re-key an index in place, so
 * this migration is a table RECREATE: a new table, a copy, a drop, a rename and
 * four fresh indexes. A recreate has exactly two silent failure modes, and this
 * file is here for both of them.
 *
 * **A lost row, or a lost column inside a row.** The copy step names every
 * column explicitly, and drizzle-kit generated one that named a column the OLD
 * table does not have — so the migration as generated would have failed on
 * every install that already had a canvas. A test that only ever migrates a
 * FRESH database cannot see that: an empty table copies correctly however wrong
 * the statement is. So every assertion below runs against a database seeded at
 * 0096 and then upgraded, which is the path every existing install takes.
 *
 * **A dropped index.** `DROP TABLE` takes a table's indexes with it, so all four
 * have to be recreated after the rename. Drizzle reports nothing when one is
 * missing; the only place it shows is `sqlite_master`.
 *
 * The third property is the one the nullability exists for: a `session:` row
 * must survive a room being deleted, and a `room:` row must not survive its own
 * room being deleted. A session row that carried a `room_id` would be cascaded
 * away by an unrelated room's deletion, which is the bug the invariant prevents.
 *
 * @module db/tests/canvas-session-scope-migration
 */
import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type Database from 'better-sqlite3';
import { createDb, runMigrations } from '../index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/** The migration under test. */
const TAG = '0097_new_boomerang';

/** Journal index of `0096_groovy_daredevil` — the canvas table before this change. */
const PRE_SESSION_SCOPE_IDX = 96;

type Raw = Database.Database;

/** Temp migration folders to remove after each test. */
const tempMigrationDirs: string[] = [];

afterEach(() => {
  for (const dir of tempMigrationDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a throwaway migrations folder holding only migrations up to and
 * including `idx`, so a test can stand a database up at an older schema version
 * and let the real {@link runMigrations} upgrade it.
 *
 * The same helper `migrations.test.ts` uses, and copied rather than shared for
 * the reason that file's own comment gives: the migrator reads
 * `meta/_journal.json` for the list to apply, so truncating the journal and
 * copying those `.sql` files is the whole of it.
 *
 * @param idx - Highest journal index to include.
 * @returns Absolute path to the temporary migrations folder.
 */
function migrationsFolderThrough(idx: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dorkos-canvas-scope-'));
  tempMigrationDirs.push(dir);
  mkdirSync(path.join(dir, 'meta'));

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= idx);
  writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify(journal));

  for (const entry of journal.entries) {
    copyFileSync(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`));
  }
  return dir;
}

/** Insert a room, so a canvas document has something to hang off. */
function seedRoom(raw: Raw, id: string): void {
  raw
    .prepare(
      'INSERT INTO rooms (id, kind, slug, title, topic, archived, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, 'channel', id, `#${id}`, null, 0, '2026-09-11T10:00:00Z', '2026-09-11T10:00:00Z');
}

/**
 * Insert one PRE-migration canvas document — the 0096 column list, with no
 * `thread_root_entry_id` and a non-null `room_id`, exactly as an install that
 * has been running the room canvas already holds.
 */
function seedPreMigrationDocument(
  raw: Raw,
  input: { id: string; roomId: string; sourceKey: string | null; title: string; content: unknown }
): void {
  raw
    .prepare(
      `INSERT INTO canvas_documents
        (id, scope, room_id, content, title, content_type, author_id, source_key, source_label,
         resolved_cwd, tree_kind, ahead_of_main, pinned, rev, last_touched_by, last_touched_at,
         editing_by, editing_heartbeat_at, opened_at, last_active_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.id,
      `room:${input.roomId}`,
      input.roomId,
      JSON.stringify(input.content),
      input.title,
      'file',
      'author-ana',
      input.sourceKey,
      "Ana's copy",
      '/work/ana',
      'worktree',
      3,
      1,
      7,
      'author-ana',
      '2026-09-11T10:00:00Z',
      'author-ana',
      '2026-09-11T10:00:30Z',
      '2026-09-11T09:00:00Z',
      '2026-09-11T10:00:00Z'
    );
}

/** Insert one SESSION-scoped document — `room_id` null, which 0096 refused. */
function seedSessionDocument(raw: Raw, input: { id: string; sessionId: string }): void {
  raw
    .prepare(
      `INSERT INTO canvas_documents
        (id, scope, room_id, content, title, content_type, author_id, source_key, source_label,
         resolved_cwd, tree_kind, ahead_of_main, pinned, rev, last_touched_by, last_touched_at,
         opened_at, last_active_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.id,
      `session:${input.sessionId}`,
      null,
      JSON.stringify({ type: 'url', url: 'https://example.test' }),
      'Example',
      'url',
      'owner',
      `url:https://example.test`,
      null,
      null,
      null,
      null,
      0,
      1,
      'owner',
      '2026-09-11T10:00:00Z',
      '2026-09-11T10:00:00Z',
      '2026-09-11T10:00:00Z'
    );
}

/** A database seeded at 0096 with a room and one document, then fully migrated. */
function upgradedFrom0096(): Raw {
  const db = createDb(':memory:');
  migrate(db, { migrationsFolder: migrationsFolderThrough(PRE_SESSION_SCOPE_IDX) });
  const raw = db.$client;
  seedRoom(raw, 'general');
  seedPreMigrationDocument(raw, {
    id: 'doc-old',
    roomId: 'general',
    sourceKey: 'path:/src/router.ts',
    title: 'router.ts',
    content: { type: 'file', sourcePath: '/src/router.ts' },
  });
  runMigrations(db);
  raw.pragma('foreign_keys = ON');
  return raw;
}

const indexesOf = (raw: Raw, table: string): string[] =>
  (
    raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?").all(table) as {
      name: string;
    }[]
  ).map((i) => i.name);

describe('0097 — the canvas table serves two scopes', () => {
  it('is in the journal under the tag this file names', () => {
    const journal = JSON.parse(
      readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain(TAG);
  });

  it('upgrades a database that already holds room documents, keeping their contents', () => {
    const raw = upgradedFrom0096();
    const row = raw.prepare('SELECT * FROM canvas_documents WHERE id = ?').get('doc-old') as Record<
      string,
      unknown
    >;
    // Every column of the copied row, not just its id: a recreate that names
    // the wrong columns in its SELECT loses their contents while the row count
    // still looks right.
    expect(row).toMatchObject({
      id: 'doc-old',
      scope: 'room:general',
      room_id: 'general',
      content: JSON.stringify({ type: 'file', sourcePath: '/src/router.ts' }),
      title: 'router.ts',
      content_type: 'file',
      author_id: 'author-ana',
      source_key: 'path:/src/router.ts',
      source_label: "Ana's copy",
      resolved_cwd: '/work/ana',
      tree_kind: 'worktree',
      ahead_of_main: 3,
      pinned: 1,
      rev: 7,
      last_touched_by: 'author-ana',
      last_touched_at: '2026-09-11T10:00:00Z',
      editing_by: 'author-ana',
      editing_heartbeat_at: '2026-09-11T10:00:30Z',
      opened_at: '2026-09-11T09:00:00Z',
      last_active_at: '2026-09-11T10:00:00Z',
      // The column the rebuild added: null for every row written before it.
      thread_root_entry_id: null,
    });
  });

  it('makes room_id nullable, so a session document needs no room', () => {
    const raw = upgradedFrom0096();
    expect(() =>
      seedSessionDocument(raw, { id: 'doc-session', sessionId: 'sess-1' })
    ).not.toThrow();
    const row = raw
      .prepare('SELECT scope, room_id FROM canvas_documents WHERE id = ?')
      .get('doc-session');
    expect(row).toEqual({ scope: 'session:sess-1', room_id: null });
  });

  it('still refuses a ROOM document naming a room that does not exist', () => {
    // The cascade is kept for the rows that have one; only the NOT NULL went.
    const raw = upgradedFrom0096();
    expect(() =>
      seedPreMigrationDocument(raw, {
        id: 'doc-ghost',
        roomId: 'ghost',
        sourceKey: null,
        title: 'Ghost',
        content: { type: 'json', data: {} },
      })
    ).toThrow(/FOREIGN KEY/i);
  });

  it('keeps a session document when an unrelated room is deleted, and drops the room’s own', () => {
    const raw = upgradedFrom0096();
    seedSessionDocument(raw, { id: 'doc-session', sessionId: 'sess-1' });
    raw.prepare('DELETE FROM rooms WHERE id = ?').run('general');
    const ids = (
      raw.prepare('SELECT id FROM canvas_documents ORDER BY id').all() as { id: string }[]
    ).map((r) => r.id);
    expect(ids).toEqual(['doc-session']);
  });

  it('carries all four indexes, keyed on scope', () => {
    const raw = upgradedFrom0096();
    // SQLite's own `sqlite_autoindex_*` for the text primary key is not ours.
    const names = indexesOf(raw, 'canvas_documents').filter((n) => !n.startsWith('sqlite_'));
    expect(names.sort()).toEqual([
      'canvas_documents_source_unique',
      'idx_canvas_documents_last_touched',
      'idx_canvas_documents_scope',
      'idx_canvas_documents_scope_type',
    ]);
    // The columns, not just the names: an index recreated on the wrong column
    // is the same silent failure as a missing one.
    const columnsOf = (index: string): string[] =>
      (raw.prepare(`PRAGMA index_info(${index})`).all() as { name: string }[]).map((c) => c.name);
    expect(columnsOf('idx_canvas_documents_scope')).toEqual(['scope', 'last_active_at']);
    expect(columnsOf('canvas_documents_source_unique')).toEqual(['scope', 'source_key']);
    expect(columnsOf('idx_canvas_documents_scope_type')).toEqual(['scope', 'content_type']);
    expect(columnsOf('idx_canvas_documents_last_touched')).toEqual([
      'scope',
      'last_touched_by',
      'last_touched_at',
    ]);
  });

  it('keeps the dedupe key unique per scope, and lets two scopes hold one source', () => {
    const raw = upgradedFrom0096();
    // The same file, open on one person's canvas and on a room's table: two
    // rows, because the scope is half the key. This is what lets a session
    // document and a room document name the same path without colliding.
    seedSessionDocument(raw, { id: 'doc-session', sessionId: 'sess-1' });
    expect(() => seedSessionDocument(raw, { id: 'doc-session-2', sessionId: 'sess-1' })).toThrow(
      /UNIQUE/i
    );
    expect(() => seedSessionDocument(raw, { id: 'doc-other', sessionId: 'sess-2' })).not.toThrow();
  });
});
