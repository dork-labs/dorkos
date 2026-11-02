/**
 * The To-dos v1 rebuild of `commitments` (DOR-3088), held to Security's migration checks
 * (`todos-v1-trust.md`, "Checks for the migration PR"):
 *
 * 1. One transaction, a foreign-key check, every old CHECK and index kept.
 * 2. The new author, level and mark columns are NOT NULL.
 * 3. Old rows backfill as the agent itself with `legacy`, and no new row can ever be `legacy`.
 * 4. The down-migration puts every old row back unchanged.
 *
 * Plus the brief's own: an automatic database copy before it runs, and a byte-identical
 * read-back of every existing row.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, readMigrationState, runMigrations, snapshotBeforeMigrations } from '../index.js';

/** The journal index of the rebuild, and its tag. */
const TODOS_IDX = 179;
const TODOS_TAG = '20261102213849_dor3088_todos';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const DOWN = fileURLToPath(new URL(`../down/${TODOS_TAG}.down.sql`, import.meta.url));

/** Every column the table had before to-dos, in its old order. */
const OLD_COLUMNS = [
  'id',
  'agent_id',
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
] as const;

type OldRow = Record<(typeof OLD_COLUMNS)[number], string | null>;

/** Old rows covering every state, every nullable column empty and full, and odd text. */
const OLD_ROWS: OldRow[] = [
  {
    id: '01A',
    agent_id: 'agent-qa',
    to_account: null,
    what: 'Run the upgrade check',
    due_at: null,
    state: 'open',
    source_session_id: null,
    source_room_entry_id: null,
    created_at: '2026-10-11T09:00:00.000Z',
    due_notified_at: null,
    closed_at: null,
    note: null,
    origin_marks: null,
  },
  {
    id: '01B',
    agent_id: 'agent-pm',
    to_account: 'external:Acme',
    what: 'x'.repeat(300),
    due_at: '2026-10-12T17:00:00.000Z',
    state: 'kept',
    source_session_id: 'sess-1',
    source_room_entry_id: 'entry-1',
    created_at: '2026-10-11T10:00:00.000Z',
    due_notified_at: '2026-10-12T17:00:00.000Z',
    closed_at: '2026-10-12T17:30:00.000Z',
    note: 'Done, sent the deck.',
    origin_marks: '{"outsider":true}',
  },
  {
    id: '01C',
    agent_id: 'agent-qa',
    to_account: 'agent-pm',
    what: 'Ünïcödé — "quotes", \'apostrophes\', and a\nnewline',
    due_at: '2026-10-13T08:00:00.000Z',
    state: 'missed',
    source_session_id: null,
    source_room_entry_id: 'entry-2',
    created_at: '2026-10-11T11:00:00.000Z',
    due_notified_at: '2026-10-13T08:00:00.000Z',
    closed_at: '2026-10-13T09:00:00.000Z',
    note: null,
    origin_marks: '{"teammate":[{"roomId":"r1","authorId":"a1"}]}',
  },
  {
    id: '01D',
    agent_id: 'agent-pm',
    to_account: null,
    what: 'Dropped one',
    due_at: null,
    state: 'dropped',
    source_session_id: 'sess-2',
    source_room_entry_id: null,
    created_at: '2026-10-11T12:00:00.000Z',
    due_notified_at: null,
    closed_at: '2026-10-11T13:00:00.000Z',
    note: '',
    origin_marks: 'not json',
  },
];

/** A to-do as the service will write one: every new column set. */
const NEW_ROW = {
  id: '02A',
  agent_id: 'agent-qa',
  owner_account: null,
  what: 'Check the build',
  state: 'open',
  created_at: '2026-11-02T09:00:00.000Z',
  assigned_by_kind: 'person',
  assigned_by: 'dorian',
  authority: 'person',
  authority_marks: '{}',
  chain_depth: 0,
  chain_agents: '[]',
  title_from_source: 0,
};

describe('To-dos rebuild of commitments (DOR-3088)', () => {
  let directory: string;
  let db: ReturnType<typeof createDb>;

  /** Copy the migrations up to and including one journal index into `directory`. */
  function stageThrough(lastIdx: number, edit?: (tag: string, sql: string) => string) {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= lastIdx);
    for (const entry of journal.entries as { tag: string }[]) {
      const from = join(MIGRATIONS, `${entry.tag}.sql`);
      const to = join(directory, `${entry.tag}.sql`);
      if (edit) writeFileSync(to, edit(entry.tag, readFileSync(from, 'utf8')));
      else copyFileSync(from, to);
    }
    writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify(journal));
  }

  function migrateThrough(lastIdx: number) {
    stageThrough(lastIdx);
    migrate(db, { migrationsFolder: directory });
  }

  function insertOld(row: OldRow) {
    const cols = OLD_COLUMNS.join(', ');
    const marks = OLD_COLUMNS.map(() => '?').join(', ');
    db.$client
      .prepare(`INSERT INTO commitments (${cols}) VALUES (${marks})`)
      .run(...OLD_COLUMNS.map((c) => row[c]));
  }

  /** Every old column of every row, as SQLite's own literal and storage class: byte for byte. */
  function readBackOld(handle = db.$client) {
    const select = OLD_COLUMNS.map((c) => `quote("${c}") AS "${c}", typeof("${c}") AS "${c}__t"`);
    return handle.prepare(`SELECT ${select.join(', ')} FROM commitments ORDER BY id`).all();
  }

  function indexes() {
    return (
      db.$client
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'commitments' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
  }

  function insertNew(overrides: Record<string, unknown>) {
    const row = { ...NEW_ROW, ...overrides };
    const cols = Object.keys(row);
    db.$client
      .prepare(
        `INSERT INTO commitments (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      )
      .run(...Object.values(row));
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'todos-migration-'));
    mkdirSync(join(directory, 'meta'));
    db = createDb(':memory:');
    migrateThrough(TODOS_IDX - 1);
    for (const row of OLD_ROWS) insertOld(row);
  });

  afterEach(() => {
    if (db.$client.open) db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  describe('up', () => {
    it('reads every existing row back byte for byte', () => {
      const before = readBackOld();
      migrateThrough(TODOS_IDX);
      expect(readBackOld()).toEqual(before);
    });

    it('backfills old rows as the agent itself, marked legacy, carrying their marks', () => {
      migrateThrough(TODOS_IDX);
      const rows = db.$client
        .prepare(
          `SELECT id, owner_account, assigned_by_kind, assigned_by, authority, authority_marks,
                  chain_depth, chain_agents, title_from_source, source_author, room_id, notes, rank
             FROM commitments ORDER BY id`
        )
        .all();
      const same = {
        owner_account: null,
        assigned_by_kind: 'agent',
        authority: 'legacy',
        chain_depth: 0,
        chain_agents: '[]',
        title_from_source: 0,
        source_author: null,
        room_id: null,
        notes: null,
        rank: null,
      };
      expect(rows).toEqual([
        { id: '01A', ...same, assigned_by: 'agent-qa', authority_marks: '{}' },
        { id: '01B', ...same, assigned_by: 'agent-pm', authority_marks: '{"outsider":true}' },
        {
          id: '01C',
          ...same,
          assigned_by: 'agent-qa',
          authority_marks: '{"teammate":[{"roomId":"r1","authorId":"a1"}]}',
        },
        // Marks nobody can read are the outsider mark, never none.
        { id: '01D', ...same, assigned_by: 'agent-pm', authority_marks: '{"outsider":true}' },
      ]);
    });

    it('keeps both old indexes and adds the owner and assigner ones', () => {
      expect(indexes()).toEqual(['commitments_agent_state_idx', 'commitments_due_idx']);
      migrateThrough(TODOS_IDX);
      expect(indexes()).toEqual([
        'commitments_agent_state_idx',
        'commitments_assigned_by_idx',
        'commitments_due_idx',
        'commitments_owner_state_idx',
      ]);
    });

    it('keeps the state check and the 300-character check on what', () => {
      migrateThrough(TODOS_IDX);
      expect(() => insertNew({ id: 'bad-state', state: 'overdue' })).toThrow(/CHECK/);
      expect(() => insertNew({ id: 'too-long', what: 'x'.repeat(301) })).toThrow(/CHECK/);
      expect(() => insertNew({ id: 'just-right', what: 'x'.repeat(300) })).not.toThrow();
    });

    it('makes who assigned it, its authority, its marks and its chain NOT NULL', () => {
      migrateThrough(TODOS_IDX);
      for (const column of [
        'assigned_by_kind',
        'assigned_by',
        'authority',
        'authority_marks',
        'chain_depth',
        'chain_agents',
        'title_from_source',
      ]) {
        expect(() => insertNew({ id: `null-${column}`, [column]: null }), column).toThrow(
          /NOT NULL/
        );
      }
    });

    it('refuses an authority or marks it cannot read', () => {
      migrateThrough(TODOS_IDX);
      expect(() => insertNew({ id: 'a1', authority: 'admin' })).toThrow(/CHECK/);
      expect(() => insertNew({ id: 'a2', authority: '[1]' })).toThrow(/CHECK/);
      expect(() => insertNew({ id: 'a3', authority_marks: 'nope' })).toThrow(/CHECK/);
      expect(() => insertNew({ id: 'a4', chain_agents: '{}' })).toThrow(/CHECK/);
      expect(() => insertNew({ id: 'a5', chain_depth: -1 })).toThrow(/CHECK/);
      expect(() =>
        insertNew({ id: 'a6', authority: '{"asks":"some","reach":"project"}' })
      ).not.toThrow();
    });

    it('lets exactly one of an agent and a person own a row', () => {
      migrateThrough(TODOS_IDX);
      expect(() => insertNew({ id: 'both', owner_account: 'dorian' })).toThrow(/CHECK/);
      expect(() => insertNew({ id: 'neither', agent_id: null })).toThrow(/CHECK/);
      expect(() =>
        insertNew({ id: 'person', agent_id: null, owner_account: 'dorian' })
      ).not.toThrow();
    });

    it('never writes legacy on a new row, nor turns a row legacy later', () => {
      migrateThrough(TODOS_IDX);
      // Even shaped exactly like a legacy row, an insert is refused.
      expect(() =>
        insertNew({
          id: 'fake-legacy',
          assigned_by_kind: 'agent',
          assigned_by: 'agent-qa',
          authority: 'legacy',
        })
      ).toThrow(/legacy authority is only for rows from before to-dos/);
      insertNew({ id: 'real' });
      expect(() =>
        db.$client.prepare(`UPDATE commitments SET authority = 'legacy' WHERE id = 'real'`).run()
      ).toThrow(/legacy authority is only for rows from before to-dos/);
    });

    it('lets a legacy row change state and lose legacy, never move to another owner as legacy', () => {
      migrateThrough(TODOS_IDX);
      const update = (set: string) =>
        db.$client.prepare(`UPDATE commitments SET ${set} WHERE id = '01A'`).run();
      expect(() => update(`state = 'kept'`)).not.toThrow();
      expect(() => update(`assigned_by = 'agent-pm'`)).toThrow(/CHECK/);
      expect(() => update(`agent_id = NULL, owner_account = 'dorian'`)).toThrow(/CHECK/);
      expect(() => update(`authority = 'person'`)).not.toThrow();
    });

    it('rolls back whole when any statement fails, leaving the old table and the ledger as they were', () => {
      const ledger = () =>
        (
          db.$client.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as {
            n: number;
          }
        ).n;
      const applied = ledger();
      const before = readBackOld();
      // The same file, with its foreign-key guard made to fail at the very end.
      stageThrough(TODOS_IDX, (tag, sql) =>
        tag === TODOS_TAG
          ? sql.replace("SELECT count(*) FROM pragma_foreign_key_check('commitments')", 'SELECT 1')
          : sql
      );
      expect(() => migrate(db, { migrationsFolder: directory })).toThrow(/__dor3088_fk_guard/);
      expect(ledger()).toBe(applied);
      expect(readBackOld()).toEqual(before);
      const columns = (
        db.$client.prepare(`SELECT name FROM pragma_table_info('commitments')`).all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(columns).toEqual([...OLD_COLUMNS]);
      expect(
        db.$client
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'commitments'`
          )
          .all()
      ).toEqual([]);
    });

    it('ends with the foreign-key check on commitments, after the new table is in place', () => {
      const sql = readFileSync(join(MIGRATIONS, `${TODOS_TAG}.sql`), 'utf8');
      const statements = sql.split('--> statement-breakpoint').map((s) => s.trim());
      const guard = statements.findIndex((s) =>
        s.includes("pragma_foreign_key_check('commitments')")
      );
      const rename = statements.findIndex((s) => s.startsWith('ALTER TABLE `__new_commitments`'));
      expect(guard).toBeGreaterThan(rename);
      expect(guard).toBe(statements.length - 2);
    });
  });

  describe('the automatic copy before it runs', () => {
    it('snapshots the database, old rows and all, before the rebuild is applied', () => {
      const file = join(directory, 'dork.db');
      const backups = join(directory, 'backups');
      db.$client.close();
      db = createDb(file);
      migrateThrough(TODOS_IDX - 1);
      for (const row of OLD_ROWS) insertOld(row);
      const expected = readBackOld();

      // The shipped journal decides what is pending, the same as at boot.
      expect(readMigrationState(db).pending[0]).toBe(TODOS_TAG);
      const snapshot = snapshotBeforeMigrations(db, { dir: backups });
      expect(snapshot).toMatch(new RegExp(`-pre-${TODOS_TAG}\\.db$`));
      expect(existsSync(snapshot!)).toBe(true);

      const copy = new Database(snapshot!, { readonly: true });
      try {
        expect(readBackOld(copy)).toEqual(expected);
      } finally {
        copy.close();
      }
    });
  });

  describe('down', () => {
    /** Run the down file as the sqlite3 shell would, minus its dot-commands, stopping at the first error. */
    function runDown() {
      const sql = readFileSync(DOWN, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('.'))
        .join('\n');
      db.$client.exec(sql);
    }

    function triggerCount() {
      return (
        db.$client
          .prepare(
            `SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'commitments'`
          )
          .get() as { n: number }
      ).n;
    }

    it('tells the sqlite3 shell to stop at the first error', () => {
      expect(readFileSync(DOWN, 'utf8').split('\n')[0]).toBe('.bail on');
    });

    it('refuses, changing nothing, once a later migration has run', () => {
      migrateThrough(TODOS_IDX);
      const before = readBackOld();
      // A later migration's ledger row, as Drizzle would record it.
      db.$client
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        .run('later', Number.MAX_SAFE_INTEGER);

      expect(runDown).toThrow(/CHECK/);
      if (db.$client.inTransaction) db.$client.exec('ROLLBACK');

      expect(readBackOld()).toEqual(before);
      expect(triggerCount()).toBe(2);
    });

    it('puts every old row back unchanged, in the old shape, and lets the rebuild run again', () => {
      const before = readBackOld();
      migrateThrough(TODOS_IDX);
      // A to-do an agent owns, written after the upgrade, goes down with the rest.
      insertNew({ id: '02A' });

      runDown();

      const after = readBackOld() as Record<string, unknown>[];
      expect(after.filter((r) => r.id !== "'02A'")).toEqual(before);
      const columns = (
        db.$client.prepare(`SELECT name FROM pragma_table_info('commitments')`).all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(columns).toEqual([...OLD_COLUMNS]);
      expect(indexes()).toEqual(['commitments_agent_state_idx', 'commitments_due_idx']);
      expect(
        db.$client
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'commitments'`
          )
          .all()
      ).toEqual([]);
      // The old CHECKs are back, named as before.
      const schemaSql = (
        db.$client
          .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'commitments'`)
          .get() as { sql: string }
      ).sql;
      expect(schemaSql).toContain('commitments_state');
      expect(schemaSql).toContain('commitments_what_length');

      // The ledger forgot it, so the next boot applies it again, and the rows come through again.
      expect(readMigrationState(db).pending[0]).toBe(TODOS_TAG);
      migrateThrough(TODOS_IDX);
      expect((readBackOld() as Record<string, unknown>[]).filter((r) => r.id !== "'02A'")).toEqual(
        before
      );
    });

    it('refuses, changing nothing, while a person owns a to-do', () => {
      migrateThrough(TODOS_IDX);
      insertNew({ id: 'mine', agent_id: null, owner_account: 'dorian' });
      const before = readBackOld();

      expect(runDown).toThrow(/CHECK/);
      // The shell's -bail and better-sqlite3 both stop at the error; the open transaction goes.
      if (db.$client.inTransaction) db.$client.exec('ROLLBACK');

      expect(readBackOld()).toEqual(before);
      expect(triggerCount()).toBe(2);
    });
  });

  it('keeps both legacy guards on the latest schema, through every later migration', () => {
    // Drizzle does not know the triggers exist, so a later rebuild of the table would drop them.
    runMigrations(db);
    const triggers = (
      db.$client
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'commitments' ORDER BY name`
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(triggers).toEqual(['commitments_no_legacy_update', 'commitments_no_new_legacy']);
  });

  it('is applied by the ordinary boot path', () => {
    runMigrations(db);
    expect(
      (
        db.$client.prepare(`SELECT authority FROM commitments WHERE id = '01A'`).get() as {
          authority: string;
        }
      ).authority
    ).toBe('legacy');
  });
});
