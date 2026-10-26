/**
 * Migration `dor3123_needs_attention` — run history tells the truth about runs
 * that lost a tool (DOR-3123, FB-67, spec `schedules-failing` SF-3).
 *
 * `needs_attention` replaces `blocked`, and `completed` now means a run was
 * refused nothing. The migration adds the `outcome` column and rewrites the old
 * rows: a `blocked` run got nothing done, and a `completed` run that lost a
 * tool did part of its job. A `completed` run refused nothing, and every run
 * from before refused tools were recorded (`refused_tools` NULL), keep their
 * status: there is nothing on those rows to say they lost anything.
 *
 * The old shape is built by replaying the repo's own migration history up to
 * the entry before this one, the construction the other migration tests use.
 *
 * @module db/tests/run-needs-attention-migration
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
const TAG = '20261025175042_dor3123_needs_attention';

type Raw = Database.Database;

/** A database at the shape the previous migration left. */
function databaseAtOldShape(): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-needs-attention-'));
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

/** Insert an old run row with a status and a stored refused-tool list. */
function seedRun(raw: Raw, id: string, status: string, refusedTools: string | null): void {
  raw
    .prepare(
      `INSERT INTO pulse_runs (id, schedule_id, status, started_at, trigger, created_at, refused_tools)
       VALUES (?, 's1', ?, '2026-10-24T09:00:00.000Z', 'scheduled', '2026-10-24T09:00:00.000Z', ?)`
    )
    .run(id, status, refusedTools);
}

describe('migration dor3123_needs_attention', () => {
  it('builds the old shape without the column, so the next assertions test this migration', () => {
    const raw = databaseAtOldShape();
    const columns = (raw.prepare('PRAGMA table_info(pulse_runs)').all() as { name: string }[]).map(
      (c) => c.name
    );
    expect(columns).not.toContain('outcome');
  });

  it('rewrites blocked and refused-but-completed runs, and leaves the rest alone', () => {
    const raw = databaseAtOldShape();
    raw
      .prepare(
        `INSERT INTO pulse_schedules (id, name, cron, timezone, prompt, status, file_path, created_at, updated_at)
         VALUES ('s1', 'health-check', '0 * * * *', 'UTC', 'Check.', 'active', '/x/SKILL.md', '2026-10-01', '2026-10-01')`
      )
      .run();
    seedRun(raw, 'blocked', 'blocked', '["Bash"]');
    seedRun(raw, 'lost-a-tool', 'completed', '["mcp__dorkos__accounts_usage"]');
    seedRun(raw, 'clean', 'completed', '[]');
    seedRun(raw, 'before-the-column', 'completed', null);
    seedRun(raw, 'failed', 'failed', '["Bash"]');

    migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });

    const rows = raw.prepare('SELECT id, status, outcome FROM pulse_runs ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'before-the-column', status: 'completed', outcome: null },
      { id: 'blocked', status: 'needs_attention', outcome: 'nothing_done' },
      { id: 'clean', status: 'completed', outcome: null },
      // A failure outranks a refusal, exactly as the run-outcome rule does.
      { id: 'failed', status: 'failed', outcome: null },
      { id: 'lost-a-tool', status: 'needs_attention', outcome: 'partial' },
    ]);
  });
});
