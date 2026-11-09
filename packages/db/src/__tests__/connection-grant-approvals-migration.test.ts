/**
 * The access-change ledger gains `approve_read` and `request_id` (agent grant autonomy, phase 3).
 *
 * Up is a table rebuild: every row of every older kind reads back byte for byte, with the same
 * count and ids, both indexes come back, the new CHECK holds, and a failure anywhere rolls the
 * whole file back. Down puts the old table back the same way, and refuses, changing nothing,
 * while any `approve_read` row exists or once a later migration has run.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, readMigrationState } from '../index.js';

const TAG = '20261109000421_connection_grant_approvals';
const MIGRATIONS = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const DOWN = fileURLToPath(new URL(`../down/${TAG}.down.sql`, import.meta.url));

/** Every column the table had before this migration, in order. */
const OLD_COLUMNS = [
  'id',
  'kind',
  'outcome',
  'refusal_code',
  'actor_kind',
  'actor_id',
  'actor_session_id',
  'target_agent_id',
  'connection_id',
  'before_json',
  'after_json',
  'reason',
  'undo_of',
  'undone_by',
  'created_at',
] as const;

const BEFORE = '{"level":"read-write","revisionIds":["r","w"],"excluded":false}';
const AFTER = '{"level":"read","revisionIds":["r"],"excluded":false}';

/** One row of every older kind, applied and refused, an undo, and odd text. */
const ROWS: Record<string, unknown>[] = [
  {
    id: '01A',
    kind: 'narrow_own',
    outcome: 'applied',
    refusal_code: null,
    actor_kind: 'agent',
    actor_id: 'flow',
    actor_session_id: 's1',
    target_agent_id: 'flow',
    connection_id: 'c1',
    before_json: BEFORE,
    after_json: AFTER,
    reason: null,
    undo_of: null,
    undone_by: null,
    created_at: '2026-11-08T10:00:00.000Z',
  },
  {
    id: '01B',
    kind: 'narrow_other',
    outcome: 'applied',
    refusal_code: null,
    actor_kind: 'agent',
    actor_id: 'pm',
    actor_session_id: 's2',
    target_agent_id: 'flow',
    connection_id: 'c1',
    before_json: BEFORE,
    after_json: AFTER,
    reason: 'It wasn’t using it — "really".',
    undo_of: null,
    undone_by: '01F',
    created_at: '2026-11-08T10:01:00.000Z',
  },
  {
    id: '01C',
    kind: 'exclude_own',
    outcome: 'applied',
    refusal_code: null,
    actor_kind: 'agent',
    actor_id: 'flow',
    actor_session_id: null,
    target_agent_id: 'flow',
    connection_id: 'c2',
    before_json: AFTER,
    after_json: AFTER.replace('false', 'true'),
    reason: null,
    undo_of: null,
    undone_by: null,
    created_at: '2026-11-08T10:02:00.000Z',
  },
  {
    id: '01D',
    kind: 'exclude_other',
    outcome: 'applied',
    refusal_code: null,
    actor_kind: 'agent',
    actor_id: 'pm',
    actor_session_id: 's2',
    target_agent_id: 'b',
    connection_id: 'c2',
    before_json: AFTER,
    after_json: AFTER.replace('false', 'true'),
    reason: 'Not needed.',
    undo_of: null,
    undone_by: null,
    created_at: '2026-11-08T10:03:00.000Z',
  },
  {
    id: '01E',
    kind: 'narrow_other',
    outcome: 'refused',
    refusal_code: 'GRANT_NARROW_RATE',
    actor_kind: 'agent',
    actor_id: 'pm',
    actor_session_id: 's2',
    target_agent_id: 'b',
    connection_id: 'c1',
    before_json: null,
    after_json: null,
    reason: 'One more.',
    undo_of: null,
    undone_by: null,
    created_at: '2026-11-08T10:04:00.000Z',
  },
  {
    id: '01F',
    kind: 'undo',
    outcome: 'applied',
    refusal_code: null,
    actor_kind: 'person',
    actor_id: 'install-1',
    actor_session_id: null,
    target_agent_id: 'flow',
    connection_id: 'c1',
    before_json: AFTER,
    after_json: BEFORE,
    reason: null,
    undo_of: '01B',
    undone_by: null,
    created_at: '2026-11-08T10:05:00.000Z',
  },
];

describe('the access-change ledger learns read approvals', () => {
  let directory: string;
  let db: ReturnType<typeof createDb>;

  function journal() {
    return JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
  }

  function idx(): number {
    const entry = journal().entries.find((e) => e.tag === TAG);
    expect(entry).toBeDefined();
    return entry!.idx;
  }

  /** Copy the migrations up to and including one journal index into `directory`, and run them. */
  function migrateThrough(lastIdx: number, replace?: (sql: string) => string) {
    const data = journal();
    const entries = data.entries.filter((entry) => entry.idx <= lastIdx);
    for (const entry of entries) {
      const to = join(directory, `${entry.tag}.sql`);
      if (entry.tag === TAG && replace) {
        writeFileSync(to, replace(readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), 'utf8')));
      } else {
        copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), to);
      }
    }
    writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ ...data, entries }));
    migrate(db, { migrationsFolder: directory });
  }

  function insert(row: Record<string, unknown>) {
    const cols = Object.keys(row);
    db.$client
      .prepare(
        `INSERT INTO connection_grant_changes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      )
      .run(...Object.values(row));
  }

  /** Every older column of every row, as SQLite's own literal and storage class: byte for byte. */
  function readBack() {
    const select = OLD_COLUMNS.map((c) => `quote("${c}") AS "${c}", typeof("${c}") AS "${c}__t"`);
    return db.$client
      .prepare(`SELECT ${select.join(', ')} FROM connection_grant_changes ORDER BY id`)
      .all();
  }

  function indexes() {
    return (
      db.$client
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'connection_grant_changes' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
  }

  function columns() {
    return (
      db.$client.prepare(`PRAGMA table_info('connection_grant_changes')`).all() as {
        name: string;
      }[]
    ).map((c) => c.name);
  }

  function runDown() {
    const sql = readFileSync(DOWN, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('.'))
      .join('\n');
    db.$client.exec(sql);
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'grant-approvals-migration-'));
    mkdirSync(join(directory, 'meta'));
    db = createDb(':memory:');
    migrateThrough(idx() - 1);
    for (const row of ROWS) insert(row);
  });

  afterEach(() => {
    if (db.$client.open) db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  describe('up', () => {
    it('keeps every row of every older kind byte for byte, with the same count and ids', () => {
      const before = readBack();
      expect(before).toHaveLength(ROWS.length);
      migrateThrough(idx());
      expect(readBack()).toEqual(before);
      expect(
        db.$client
          .prepare('SELECT count(*) AS n FROM connection_grant_changes WHERE request_id IS NULL')
          .get()
      ).toEqual({ n: ROWS.length });
    });

    it('adds request_id, keeps both indexes, and takes approve_read but nothing unknown', () => {
      migrateThrough(idx());
      expect(columns()).toEqual([
        ...OLD_COLUMNS.slice(0, 12),
        'request_id',
        ...OLD_COLUMNS.slice(12),
      ]);
      expect(indexes()).toEqual([
        'connection_grant_changes_actor_idx',
        'connection_grant_changes_connection_idx',
      ]);
      insert({ ...ROWS[0], id: '02A', kind: 'approve_read', request_id: 'request-1' });
      expect(() => insert({ ...ROWS[0], id: '02B', kind: 'approve_write' })).toThrow(/CHECK/);
    });

    it('ends with the foreign-key check, after the new table is in place', () => {
      const sql = readFileSync(join(MIGRATIONS, `${TAG}.sql`), 'utf8');
      const statements = sql.split('--> statement-breakpoint').map((s) => s.trim());
      expect(statements.at(-2)).toContain("pragma_foreign_key_check('connection_grant_changes')");
      const renameAt = statements.findIndex((s) =>
        s.includes('RENAME TO `connection_grant_changes`')
      );
      expect(renameAt).toBeGreaterThan(-1);
      expect(renameAt).toBeLessThan(statements.length - 2);
      expect(sql).not.toMatch(/^PRAGMA foreign_keys/m);
    });

    it('rolls back whole when any statement fails, leaving the old table and the ledger as they were', () => {
      const before = readBack();
      const ledger = readMigrationState(db);
      expect(() =>
        migrateThrough(idx(), (sql) =>
          sql.replace(
            'DROP TABLE `__grant_approvals_fk_guard`;',
            'DROP TABLE `__grant_approvals_fk_guard`;--> statement-breakpoint\nSELECT * FROM `__no_such_table`;'
          )
        )
      ).toThrow();
      expect(readBack()).toEqual(before);
      expect(columns()).not.toContain('request_id');
      expect(readMigrationState(db).pending).toEqual(ledger.pending);
    });
  });

  describe('down', () => {
    it('tells the sqlite3 shell to stop at the first error', () => {
      expect(readFileSync(DOWN, 'utf8').split('\n')[0]).toBe('.bail on');
    });

    it('puts every row back in the old table, and lets the migration run again', () => {
      const before = readBack();
      migrateThrough(idx());
      runDown();
      expect(readBack()).toEqual(before);
      expect(columns()).toEqual([...OLD_COLUMNS]);
      expect(indexes()).toEqual([
        'connection_grant_changes_actor_idx',
        'connection_grant_changes_connection_idx',
      ]);
      expect(() => insert({ ...ROWS[0], id: '02A', kind: 'approve_read' })).toThrow(/CHECK/);
      expect(readMigrationState(db).pending[0]).toBe(TAG);
      migrateThrough(idx());
      expect(readBack()).toEqual(before);
    });

    it('refuses, changing nothing, while an approve_read row exists: it never drops one', () => {
      migrateThrough(idx());
      insert({ ...ROWS[0], id: '02A', kind: 'approve_read', request_id: 'request-1' });
      const before = readBack();
      // The guard refuses first, by name: not the old CHECK failing halfway through the copy.
      expect(runDown).toThrow(/CHECK constraint failed: refusals$/);
      if (db.$client.inTransaction) db.$client.exec('ROLLBACK');
      expect(readBack()).toEqual(before);
      expect(columns()).toContain('request_id');
    });

    it('refuses, changing nothing, once a later migration has run', () => {
      migrateThrough(idx());
      const before = readBack();
      db.$client
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        .run('later', Number.MAX_SAFE_INTEGER);
      // The guard refuses first, by name: not the old CHECK failing halfway through the copy.
      expect(runDown).toThrow(/CHECK constraint failed: refusals$/);
      if (db.$client.inTransaction) db.$client.exec('ROLLBACK');
      expect(readBack()).toEqual(before);
      expect(columns()).toContain('request_id');
    });
  });
});
