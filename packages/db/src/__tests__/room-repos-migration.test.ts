/**
 * Migration 0081 — `rooms.workspace_id` goes, `room_repos` arrives (spec
 * `project-rooms` §3.1, DOR-1591).
 *
 * Two halves that only look unrelated. `workspace_id` was the v1 placeholder for
 * "which checkout does this room mean", written by `createRoom` and read by
 * nothing; `room_repos` is the answer that replaced it — a cache of the
 * `room-repo.json` sidecar in each room's home directory. Dropping the first
 * without landing the second would leave the question unanswered, so they ship
 * as one migration and are asserted as one.
 *
 * Everything here runs against a database built by the REAL Drizzle migrator
 * over the committed migrations, never by executing this migration's SQL inline
 * — an inline copy only proves the test's transcription parses.
 *
 * @module db/tests/room-repos-migration
 */
import { describe, it, expect } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, runMigrations } from '../index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/** The migration under test. */
const TAG = '0081_nappy_phil_sheldon';

/** Journal index of the last migration BEFORE this one. */
const PRE_ROOM_REPOS_IDX = 80;

type Raw = Database.Database;

/** A database at the shape 0080 left — every migration before 0081, and not it. */
function databaseAtOldShape(): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-0080-'));
  mkdirSync(path.join(folder, 'meta'));

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  const before = journal.entries.filter((e) => e.idx <= PRE_ROOM_REPOS_IDX);

  // If 0081 is ever renumbered, the fixture would silently already include it
  // and every assertion below would pass for the wrong reason.
  expect(before.map((e) => e.tag)).not.toContain(TAG);
  expect(journal.entries.map((e) => e.tag)).toContain(TAG);

  for (const entry of before) {
    copyFileSync(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: before })
  );

  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  return sqlite;
}

/** A database with every committed migration applied, as production runs them. */
function migrated(): Raw {
  const db = createDb(':memory:');
  runMigrations(db);
  db.$client.pragma('foreign_keys = ON');
  return db.$client;
}

/** Insert a room at the OLD shape, `workspace_id` and all. */
function seedOldRoom(raw: Raw, id: string, workspaceId: string | null): void {
  raw
    .prepare(
      'INSERT INTO rooms (id, kind, slug, title, topic, workspace_id, archived, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      'channel',
      id,
      `#${id}`,
      null,
      workspaceId,
      0,
      '2026-08-27T10:00:00Z',
      '2026-08-27T10:00:00Z'
    );
}

/** Insert a room at the NEW shape. */
function seedRoom(raw: Raw, id: string): void {
  raw
    .prepare(
      'INSERT INTO rooms (id, kind, slug, title, topic, archived, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, 'channel', id, `#${id}`, null, 0, '2026-08-27T10:00:00Z', '2026-08-27T10:00:00Z');
}

const columnsOf = (raw: Raw, table: string): string[] =>
  (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('0081 — dropping rooms.workspace_id and adding room_repos', () => {
  describe('the column that goes', () => {
    it('drops workspace_id and leaves every other column of rooms standing', () => {
      const raw = databaseAtOldShape();
      const before = columnsOf(raw, 'rooms');
      expect(before).toContain('workspace_id');

      raw.exec(readFileSync(path.join(DRIZZLE_DIR, `${TAG}.sql`), 'utf-8'));

      const after = columnsOf(raw, 'rooms');
      expect(after).not.toContain('workspace_id');
      expect(after).toEqual(before.filter((c) => c !== 'workspace_id'));
    });

    it('keeps the rooms a person had, values and all', () => {
      // A `DROP COLUMN` rewrites the table under SQLite's hood. Nothing about
      // the rest of a room may move with it — this is a person's channel list.
      const raw = databaseAtOldShape();
      seedOldRoom(raw, 'general', '/Users/planted/checkouts/dorkos');
      seedOldRoom(raw, 'quiet', null);

      raw.exec(readFileSync(path.join(DRIZZLE_DIR, `${TAG}.sql`), 'utf-8'));

      expect(raw.prepare('SELECT id, kind, slug, title FROM rooms ORDER BY id').all()).toEqual([
        { id: 'general', kind: 'channel', slug: 'general', title: '#general' },
        { id: 'quiet', kind: 'channel', slug: 'quiet', title: '#quiet' },
      ]);
    });

    it('keeps the channel-slug and well-known indexes, which sit on the same table', () => {
      // SQLite refuses `DROP COLUMN` on an INDEXED column, and drizzle emits no
      // `DROP INDEX` here — which is only correct because `workspace_id` was
      // never indexed. Asserting the survivors is what would catch a future
      // index on that column being dropped along with it.
      const raw = databaseAtOldShape();
      raw.exec(readFileSync(path.join(DRIZZLE_DIR, `${TAG}.sql`), 'utf-8'));

      const indexes = (
        raw
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='rooms'")
          .all() as { name: string }[]
      ).map((i) => i.name);
      expect(indexes).toContain('rooms_channel_slug_unique');
      expect(indexes).toContain('rooms_well_known_unique');
    });
  });

  describe('the table that arrives', () => {
    it('has exactly the four columns the spec names, with last_merge_seq the only nullable one', () => {
      const columns = migrated().prepare('PRAGMA table_info(room_repos)').all() as {
        name: string;
        notnull: number;
        pk: number;
      }[];

      expect(columns.map((c) => c.name)).toEqual([
        'room_id',
        'mode',
        'created_at',
        'last_merge_seq',
      ]);
      expect(columns.filter((c) => c.notnull === 0).map((c) => c.name)).toEqual(['last_merge_seq']);
      expect(columns.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['room_id']);
    });

    it('holds at most one repo per room', () => {
      const raw = migrated();
      seedRoom(raw, 'general');
      const insert = raw.prepare(
        'INSERT INTO room_repos (room_id, mode, created_at, last_merge_seq) VALUES (?,?,?,?)'
      );
      insert.run('general', 'owned', '2026-08-27T10:00:00Z', null);

      // By primary key rather than by a sweep: a second enable has to be the
      // idempotent 409 the route promises, never a second binding.
      expect(() => insert.run('general', 'owned', '2026-08-27T11:00:00Z', null)).toThrow();
    });

    it('refuses a cache row for a room that does not exist', () => {
      const raw = migrated();
      expect(() =>
        raw
          .prepare(
            'INSERT INTO room_repos (room_id, mode, created_at, last_merge_seq) VALUES (?,?,?,?)'
          )
          .run('no-such-room', 'owned', '2026-08-27T10:00:00Z', null)
      ).toThrow(/FOREIGN KEY/i);
    });

    it('takes its row with the room when the room is deleted', () => {
      // The cache row has no meaning without its room, and nothing reconciles a
      // binding whose room is gone — the sweep reads sidecars under rooms that
      // exist. Cascade is what keeps the table from accruing orphans.
      const raw = migrated();
      seedRoom(raw, 'general');
      raw
        .prepare(
          'INSERT INTO room_repos (room_id, mode, created_at, last_merge_seq) VALUES (?,?,?,?)'
        )
        .run('general', 'owned', '2026-08-27T10:00:00Z', 12);

      raw.prepare("DELETE FROM rooms WHERE id = 'general'").run();

      expect(raw.prepare('SELECT COUNT(*) AS n FROM room_repos').get()).toEqual({ n: 0 });
    });

    it('records where the last merge landed, and nothing when there has been none', () => {
      const raw = migrated();
      seedRoom(raw, 'general');
      const insert = raw.prepare(
        'INSERT INTO room_repos (room_id, mode, created_at, last_merge_seq) VALUES (?,?,?,?)'
      );
      insert.run('general', 'owned', '2026-08-27T10:00:00Z', null);
      expect(raw.prepare('SELECT last_merge_seq FROM room_repos').get()).toEqual({
        last_merge_seq: null,
      });

      raw.prepare("UPDATE room_repos SET last_merge_seq = 7 WHERE room_id = 'general'").run();
      expect(raw.prepare('SELECT last_merge_seq FROM room_repos').get()).toEqual({
        last_merge_seq: 7,
      });
    });
  });

  describe('the whole chain', () => {
    it('applies onto a database that already holds rooms', () => {
      const raw = databaseAtOldShape();
      seedOldRoom(raw, 'general', '/Users/planted/checkouts/dorkos');

      expect(() =>
        raw.exec(readFileSync(path.join(DRIZZLE_DIR, `${TAG}.sql`), 'utf-8'))
      ).not.toThrow();
      expect(columnsOf(raw, 'room_repos')).toHaveLength(4);
      expect(raw.prepare('SELECT COUNT(*) AS n FROM rooms').get()).toEqual({ n: 1 });
    });

    it('applies onto an empty database', () => {
      const raw = databaseAtOldShape();
      expect(() =>
        raw.exec(readFileSync(path.join(DRIZZLE_DIR, `${TAG}.sql`), 'utf-8'))
      ).not.toThrow();
      expect(raw.prepare('SELECT COUNT(*) AS n FROM room_repos').get()).toEqual({ n: 0 });
    });
  });
});
