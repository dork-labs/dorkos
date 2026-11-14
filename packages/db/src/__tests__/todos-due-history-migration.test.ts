/**
 * DOR-3034 adds due-date history without rebuilding `todos`, backfills dated rows, and leaves the
 * two hand-written legacy-refusal triggers in place.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../index.js';

const MIGRATION_IDX = 195;
const MIGRATION_TAG = '20261114004307_dor3034_due_history';
const MIGRATIONS = fileURLToPath(new URL('../../drizzle/', import.meta.url));

describe('the to-do due history migration (DOR-3034)', () => {
  let directory: string;
  let db: ReturnType<typeof createDb>;

  /** Copy migrations through one journal index into the temporary folder, then run them. */
  function migrateThrough(lastIdx: number): void {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= lastIdx);
    for (const entry of journal.entries as { tag: string }[]) {
      copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
    }
    writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify(journal));
    migrate(db, { migrationsFolder: directory });
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'todos-due-history-migration-'));
    mkdirSync(join(directory, 'meta'));
    db = createDb(':memory:');
    migrateThrough(MIGRATION_IDX - 1);
    db.$client
      .prepare(
        `INSERT INTO todos
          (id, agent_id, what, due_at, state, created_at, assigned_by_kind, assigned_by,
           authority, authority_marks, chain_depth, chain_agents, title_from_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'todo-before',
        'agent-a',
        'Ship the fix',
        '2026-11-13T10:00:00.000Z',
        'open',
        '2026-11-12T10:00:00.000Z',
        'agent',
        'agent-a',
        'self',
        '{}',
        0,
        '[]',
        0
      );
  });

  afterEach(() => {
    if (db.$client.open) db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('adds and backfills due history while preserving both refusal triggers', () => {
    migrateThrough(MIGRATION_IDX);
    const columns = db.$client.prepare(`SELECT name FROM pragma_table_info('todos')`).all() as {
      name: string;
    }[];
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['original_due_at', 'score_due_at', 'move_count'])
    );
    expect(
      db.$client
        .prepare('SELECT due_at, original_due_at, score_due_at, move_count FROM todos WHERE id = ?')
        .get('todo-before')
    ).toEqual({
      due_at: '2026-11-13T10:00:00.000Z',
      original_due_at: '2026-11-13T10:00:00.000Z',
      score_due_at: '2026-11-13T10:00:00.000Z',
      move_count: 0,
    });
    const triggers = db.$client
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'todos'`)
      .all() as { name: string }[];
    expect(triggers.map(({ name }) => name).sort()).toEqual([
      'todos_no_legacy_update',
      'todos_no_new_legacy',
    ]);
  });

  it('has the expected journal tag', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'));
    expect(journal.entries[MIGRATION_IDX].tag).toBe(MIGRATION_TAG);
  });
});
