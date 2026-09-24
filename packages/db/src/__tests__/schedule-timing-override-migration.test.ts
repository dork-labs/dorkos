/**
 * Migration 0108 — a person's own timing for a package's schedule (DOR-2302).
 *
 * The migration adds two nullable columns to `pulse_schedules`, and the whole
 * promise it makes to an upgrading install is that nothing changes: every
 * schedule someone already has must come out of it on exactly the timing it
 * went in with. A NULL override means "the file's timing", so the assertion
 * that matters is that the old row's overrides are NULL and its own cron and
 * timezone are untouched — a default of `''` on `cron_override` would take
 * every existing schedule off its timer, silently.
 *
 * The old shape is built by replaying the repo's own migration history up to
 * the entry before this one, the construction the other migration tests use,
 * because a transcribed fixture is a second copy of the schema and it drifts.
 *
 * @module db/tests/schedule-timing-override-migration
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
const TAG = '0108_magical_morph';

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
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-0108-'));
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

describe('migration 0108: timing overrides on pulse_schedules', () => {
  it('builds the old shape without the columns, so the next assertions test this migration', () => {
    // Purpose: without this, a cut in the wrong place would leave every
    // assertion below passing against a table that already had the columns.
    const raw = databaseAtOldShape();
    expect(scheduleColumns(raw)).not.toContain('cron_override');
    expect(scheduleColumns(raw)).not.toContain('timezone_override');
  });

  it('adds both columns and leaves every existing schedule on its own timing', () => {
    // Purpose: an upgrade must not move a single schedule. The overrides have to
    // arrive NULL ("the file's timing"), never `''`, which would mean "on
    // demand" and take the schedule off its timer.
    const raw = databaseAtOldShape();
    raw
      .prepare(
        `INSERT INTO pulse_schedules (id, name, cron, timezone, prompt, status, file_path, created_at, updated_at)
         VALUES ('s1', 'flow-drain', '0 * * * *', 'Europe/Berlin', 'Drain the queue.', 'active', '/x/SKILL.md', '2026-09-01', '2026-09-01')`
      )
      .run();

    migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });

    expect(scheduleColumns(raw)).toEqual(
      expect.arrayContaining(['cron_override', 'timezone_override'])
    );
    const row = raw
      .prepare(
        'SELECT cron, timezone, cron_override, timezone_override FROM pulse_schedules WHERE id = ?'
      )
      .get('s1');
    expect(row).toEqual({
      cron: '0 * * * *',
      timezone: 'Europe/Berlin',
      cron_override: null,
      timezone_override: null,
    });
  });
});
