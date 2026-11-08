/**
 * To-dos step 1 (DOR-3933): `commitments` becomes `todos`, with no other change.
 *
 * Up keeps every row byte for byte, every index and CHECK under its new name, and both "refuse
 * legacy" triggers. Down puts the old name back the same way, and lets the rename run again.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, readMigrationState } from '../index.js';

/** The journal index of the rename, and its tag. */
const RENAME_IDX = 185;
const RENAME_TAG = '20261107183323_dor3933_todos_rename';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const DOWN = fileURLToPath(new URL(`../down/${RENAME_TAG}.down.sql`, import.meta.url));

/** Every column the table has, in order. */
const COLUMNS = [
  'id',
  'agent_id',
  'owner_account',
  'to_account',
  'what',
  'due_at',
  'state',
  'source_session_id',
  'source_room_entry_id',
  'created_at',
  'due_notified_at',
  'closed_at',
  'note',
  'origin_marks',
  'assigned_by_kind',
  'assigned_by',
  'authority',
  'authority_marks',
  'chain_depth',
  'chain_agents',
  'title_from_source',
  'source_author',
  'room_id',
  'notes',
  'rank',
] as const;

/** Rows covering an agent's promise, a person's to-do, a reassigned one and odd text. */
const ROWS: Record<string, unknown>[] = [
  {
    id: '01A',
    agent_id: 'agent-qa',
    what: 'Run the upgrade check',
    state: 'open',
    created_at: '2026-10-11T09:00:00.000Z',
    assigned_by_kind: 'agent',
    assigned_by: 'agent-qa',
    authority: 'self',
    authority_marks: '{}',
    chain_depth: 0,
    chain_agents: '[]',
    title_from_source: 0,
  },
  {
    id: '01B',
    owner_account: 'owner',
    to_account: 'external:Acme',
    what: 'Ünïcödé — "quotes", \'apostrophes\', and a\nnewline',
    due_at: '2026-10-12T17:00:00.000Z',
    state: 'kept',
    source_session_id: 'sess-1',
    source_room_entry_id: 'entry-1',
    created_at: '2026-10-11T10:00:00.000Z',
    due_notified_at: '2026-10-12T17:00:00.000Z',
    closed_at: '2026-10-12T17:30:00.000Z',
    note: 'Done, sent the deck.',
    origin_marks: '{"outsider":true}',
    assigned_by_kind: 'person',
    assigned_by: 'owner',
    authority: 'person',
    authority_marks: '{"outsider":true}',
    chain_depth: 0,
    chain_agents: '[]',
    title_from_source: 1,
    source_author: 'someone',
    room_id: 'room-1',
    notes: '**Bold** notes',
    rank: 'a0',
  },
  {
    id: '01C',
    agent_id: 'agent-pm',
    what: 'x'.repeat(300),
    state: 'dropped',
    created_at: '2026-10-11T11:00:00.000Z',
    closed_at: '2026-10-11T12:00:00.000Z',
    note: '',
    assigned_by_kind: 'agent',
    assigned_by: 'agent-qa',
    authority: '{"level":"trusted"}',
    authority_marks: '{"teammate":[{"roomId":"r1","authorId":"a1"}]}',
    chain_depth: 2,
    chain_agents: '["agent-qa","agent-x"]',
    title_from_source: 0,
  },
];

describe('the rename of commitments to todos (DOR-3933)', () => {
  let directory: string;
  let db: ReturnType<typeof createDb>;

  /** Copy the migrations up to and including one journal index into `directory`, and run them. */
  function migrateThrough(lastIdx: number) {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= lastIdx);
    for (const entry of journal.entries as { tag: string }[]) {
      copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
    }
    writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify(journal));
    migrate(db, { migrationsFolder: directory });
  }

  function insert(table: string, row: Record<string, unknown>) {
    const cols = Object.keys(row);
    db.$client
      .prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      )
      .run(...Object.values(row));
  }

  /** Every column of every row, as SQLite's own literal and storage class: byte for byte. */
  function readBack(table: string) {
    const select = COLUMNS.map((c) => `quote("${c}") AS "${c}", typeof("${c}") AS "${c}__t"`);
    return db.$client.prepare(`SELECT ${select.join(', ')} FROM ${table} ORDER BY id`).all();
  }

  function names(type: 'index' | 'trigger', table: string) {
    return (
      db.$client
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all(type, table) as { name: string }[]
    ).map((r) => r.name);
  }

  function tableSql(table: string) {
    return (
      db.$client
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) as { sql: string } | undefined
    )?.sql;
  }

  function runDown() {
    const sql = readFileSync(DOWN, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('.'))
      .join('\n');
    db.$client.exec(sql);
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'todos-rename-migration-'));
    mkdirSync(join(directory, 'meta'));
    db = createDb(':memory:');
    migrateThrough(RENAME_IDX - 1);
    for (const row of ROWS) insert('commitments', row);
  });

  afterEach(() => {
    if (db.$client.open) db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('is the rename, at the index this test names', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'));
    expect(journal.entries[RENAME_IDX].tag).toBe(RENAME_TAG);
  });

  describe('up', () => {
    it('moves every row byte for byte, and leaves no commitments table', () => {
      const before = readBack('commitments');
      migrateThrough(RENAME_IDX);
      expect(readBack('todos')).toEqual(before);
      expect(tableSql('commitments')).toBeUndefined();
      const columns = (
        db.$client.prepare(`SELECT name FROM pragma_table_info('todos')`).all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(columns).toEqual([...COLUMNS]);
    });

    it('keeps every index and CHECK, under their new names', () => {
      migrateThrough(RENAME_IDX);
      expect(names('index', 'todos')).toEqual([
        'todos_agent_state_idx',
        'todos_assigned_by_idx',
        'todos_due_idx',
        'todos_owner_state_idx',
      ]);
      const sql = tableSql('todos')!;
      for (const check of [
        'state',
        'what_length',
        'owner',
        'assigned_by_kind',
        'authority',
        'legacy_is_own',
        'authority_marks',
        'title_from_source',
        'chain_depth',
        'chain_agents',
        'notes_length',
        'rank_length',
      ]) {
        expect(sql).toContain(`"todos_${check}"`);
      }
      expect(sql).not.toContain('commitments');
      expect(() => insert('todos', { ...ROWS[0], id: 'too-long', what: 'x'.repeat(301) })).toThrow(
        /CHECK/
      );
    });

    it('recreates both legacy guards on todos, and they still refuse legacy', () => {
      migrateThrough(RENAME_IDX);
      expect(names('trigger', 'todos')).toEqual(['todos_no_legacy_update', 'todos_no_new_legacy']);
      expect(() => insert('todos', { ...ROWS[0], id: 'new-legacy', authority: 'legacy' })).toThrow(
        /legacy authority is only for rows from before to-dos/
      );
      expect(() =>
        db.$client.prepare(`UPDATE todos SET authority = 'legacy' WHERE id = '01A'`).run()
      ).toThrow(/legacy authority is only for rows from before to-dos/);
    });

    it('rolls back whole when any statement fails, leaving commitments and the ledger as they were', () => {
      const before = readBack('commitments');
      const ledger = readMigrationState(db);
      // A statement that fails after every other one has run, so only the transaction can undo them.
      const sql = readFileSync(join(MIGRATIONS, `${RENAME_TAG}.sql`), 'utf8').replace(
        'DROP TABLE `__dor3933_fk_guard`;',
        'DROP TABLE `__dor3933_fk_guard`;--> statement-breakpoint\nSELECT * FROM `__no_such_table`;'
      );
      const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= RENAME_IDX);
      for (const entry of journal.entries as { tag: string }[]) {
        const from = join(MIGRATIONS, `${entry.tag}.sql`);
        const to = join(directory, `${entry.tag}.sql`);
        if (entry.tag === RENAME_TAG) writeFileSync(to, sql);
        else copyFileSync(from, to);
      }
      writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify(journal));

      expect(() => migrate(db, { migrationsFolder: directory })).toThrow();
      expect(readBack('commitments')).toEqual(before);
      expect(tableSql('todos')).toBeUndefined();
      expect(readMigrationState(db).pending).toEqual(ledger.pending);
    });

    it('ends with the foreign-key check on todos, after the new table is in place', () => {
      const sql = readFileSync(join(MIGRATIONS, `${RENAME_TAG}.sql`), 'utf8');
      const statements = sql.split('--> statement-breakpoint').map((s) => s.trim());
      expect(statements.at(-2)).toContain("pragma_foreign_key_check('todos')");
      const renameAt = statements.findIndex((s) => s.includes('RENAME TO `todos`'));
      expect(renameAt).toBeGreaterThan(-1);
      expect(renameAt).toBeLessThan(statements.length - 2);
    });
  });

  describe('down', () => {
    it('tells the sqlite3 shell to stop at the first error', () => {
      expect(readFileSync(DOWN, 'utf8').split('\n')[0]).toBe('.bail on');
    });

    it('puts every row back under commitments, guards and all, and lets the rename run again', () => {
      const before = readBack('commitments');
      const beforeSql = tableSql('commitments');
      migrateThrough(RENAME_IDX);

      runDown();

      expect(readBack('commitments')).toEqual(before);
      expect(tableSql('todos')).toBeUndefined();
      expect(names('index', 'commitments')).toEqual([
        'commitments_agent_state_idx',
        'commitments_assigned_by_idx',
        'commitments_due_idx',
        'commitments_owner_state_idx',
      ]);
      expect(names('trigger', 'commitments')).toEqual([
        'commitments_no_legacy_update',
        'commitments_no_new_legacy',
      ]);
      // The same CHECKs, under their old names.
      const sql = tableSql('commitments')!;
      for (const check of ['state', 'what_length', 'owner', 'legacy_is_own', 'rank_length']) {
        expect(beforeSql).toContain(`"commitments_${check}"`);
        expect(sql).toContain(`"commitments_${check}"`);
      }
      expect(() => insert('commitments', { ...ROWS[0], id: 'x', authority: 'legacy' })).toThrow(
        /legacy authority is only for rows from before to-dos/
      );

      // The ledger forgot it, so the next boot applies it again, and the rows come through again.
      expect(readMigrationState(db).pending[0]).toBe(RENAME_TAG);
      migrateThrough(RENAME_IDX);
      expect(readBack('todos')).toEqual(before);
    });

    it('refuses, changing nothing, once a later migration has run', () => {
      migrateThrough(RENAME_IDX);
      const before = readBack('todos');
      db.$client
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        .run('later', Number.MAX_SAFE_INTEGER);

      expect(runDown).toThrow(/CHECK/);
      if (db.$client.inTransaction) db.$client.exec('ROLLBACK');

      expect(readBack('todos')).toEqual(before);
      expect(names('trigger', 'todos')).toEqual(['todos_no_legacy_update', 'todos_no_new_legacy']);
    });
  });
});
