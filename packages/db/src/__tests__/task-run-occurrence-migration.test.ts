/**
 * Migration `task_run_occurrence` — which occurrence a task run stood for, and
 * how many it missed (DOR-2718).
 *
 * The migration adds two nullable columns to `pulse_runs`. Its promise to an
 * upgrading install is that run history reads exactly as before: every old run
 * keeps its row, and both new columns arrive NULL, which the run history reads
 * as "nothing to say about lateness". A default of `0` on `missed_ticks` would
 * be a claim about runs nobody measured.
 *
 * The old shape is built by replaying the repo's own migration history up to
 * the entry before this one, the construction the other migration tests use,
 * because a transcribed fixture is a second copy of the schema and it drifts.
 *
 * @module db/tests/task-run-occurrence-migration
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/** The migration under test, found in the journal by its tag rather than its position. */
const TAG = '20261005122407_task_run_occurrence';

type Raw = Database.Database;

/**
 * A database at the shape the previous migration left — every entry before
 * {@link TAG} applied, and {@link TAG} itself not.
 */
function databaseAtOldShape(): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-run-occurrence-'));
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
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return sqlite;
}

/** The column names `pulse_runs` has right now. */
function runColumns(raw: Raw): string[] {
  return (raw.prepare('PRAGMA table_info(pulse_runs)').all() as { name: string }[]).map(
    (c) => c.name
  );
}

describe('migration task_run_occurrence: scheduled_for and missed_ticks on pulse_runs', () => {
  it('builds the old shape without the columns, so the next assertions test this migration', () => {
    // Purpose: a cut in the wrong place would leave every assertion below
    // passing against a table that already had the columns.
    const raw = databaseAtOldShape();
    expect(runColumns(raw)).not.toContain('scheduled_for');
    expect(runColumns(raw)).not.toContain('missed_ticks');
  });

  it('adds both columns, and an old run reads NULL in each', () => {
    const raw = databaseAtOldShape();
    raw
      .prepare(
        `INSERT INTO pulse_schedules (id, name, cron, timezone, prompt, status, file_path, created_at, updated_at)
         VALUES ('s1', 'daily-report', '0 9 * * *', 'UTC', 'Report.', 'active', '/x/SKILL.md', '2026-09-01', '2026-09-01')`
      )
      .run();
    raw
      .prepare(
        `INSERT INTO pulse_runs (id, schedule_id, status, started_at, trigger, created_at)
         VALUES ('r1', 's1', 'completed', '2026-09-02T09:00:01.000Z', 'scheduled', '2026-09-02T09:00:01.000Z')`
      )
      .run();

    migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });

    expect(runColumns(raw)).toEqual(expect.arrayContaining(['scheduled_for', 'missed_ticks']));
    const row = raw
      .prepare(
        'SELECT status, started_at, scheduled_for, missed_ticks FROM pulse_runs WHERE id = ?'
      )
      .get('r1');
    expect(row).toEqual({
      status: 'completed',
      started_at: '2026-09-02T09:00:01.000Z',
      scheduled_for: null,
      missed_ticks: null,
    });
  });
});
