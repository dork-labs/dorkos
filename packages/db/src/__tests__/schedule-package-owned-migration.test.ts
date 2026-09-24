/**
 * Migration 0109 — who owns a schedule's file, kept on the row (DOR-2272).
 *
 * The column lets a sync see the moment a file stops being a package's and keep
 * the person's switch. A row that existed before the column could have been a
 * package's under the old rule, and NULL would read as "the person's", which
 * would switch a person's OFF schedule back on at the first sync. So every
 * existing row is backfilled to `unknown`, which the first sync treats like a
 * package it is about to release.
 *
 * The old shape is built by replaying the repo's own migration history up to
 * the entry before this one, the construction the other migration tests use.
 *
 * @module db/tests/schedule-package-owned-migration
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/** The migration under test, found in the journal by its tag rather than its number. */
const TAG = '0109_aspiring_union_jack';

type Raw = Database.Database;

/**
 * A database at the shape the previous migration left — every entry before
 * {@link TAG} applied, and {@link TAG} itself not.
 *
 * The cut is found by TAG, not by a hard-coded index, so a renumber on rebase
 * moves the cut with the file instead of leaving this test asserting against a
 * shape that already includes it.
 */
function databaseAtOldShape(): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-0109-'));
  mkdirSync(path.join(folder, 'meta'));

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  const self = journal.entries.find((e) => e.tag === TAG);
  expect(self).toBeDefined();
  const before = journal.entries.filter((e) => e.idx < self!.idx);

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

/** The column names `pulse_schedules` has right now. */
function scheduleColumns(raw: Raw): string[] {
  return (raw.prepare('PRAGMA table_info(pulse_schedules)').all() as { name: string }[]).map(
    (c) => c.name
  );
}

describe('migration 0109: package_owned on pulse_schedules', () => {
  it('builds the old shape without the column, so the next assertion tests this migration', () => {
    // Purpose: a cut in the wrong place would leave the assertion below passing
    // against a table that already had the column.
    expect(scheduleColumns(databaseAtOldShape())).not.toContain('package_owned');
  });

  it("marks every existing schedule 'unknown', and leaves new rows NULL", () => {
    // Purpose: an existing row may have been a package's; NULL would say it was
    // the person's and lose their switch at the first sync (DOR-2272 review).
    const raw = databaseAtOldShape();
    raw
      .prepare(
        `INSERT INTO pulse_schedules (id, name, cron, timezone, prompt, status, enabled, file_path, created_at, updated_at)
         VALUES ('s1', 'nightly', '0 3 * * *', 'UTC', 'Sweep.', 'active', 0, '/x/SKILL.md', '2026-09-01', '2026-09-01')`
      )
      .run();

    migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });

    expect(
      raw.prepare('SELECT package_owned, enabled FROM pulse_schedules WHERE id = ?').get('s1')
    ).toEqual({
      package_owned: 'unknown',
      enabled: 0,
    });
    raw
      .prepare(
        `INSERT INTO pulse_schedules (id, name, cron, timezone, prompt, status, file_path, created_at, updated_at)
         VALUES ('s2', 'later', '0 3 * * *', 'UTC', 'Sweep.', 'active', '/y/SKILL.md', '2026-09-25', '2026-09-25')`
      )
      .run();
    expect(raw.prepare('SELECT package_owned FROM pulse_schedules WHERE id = ?').get('s2')).toEqual(
      {
        package_owned: null,
      }
    );
  });
});
