/**
 * The access-change ledger keeps the approving agent as it looked then, and finds an approval by
 * its request (Security M1 on #3575). Up adds one nullable column and one index and keeps every
 * row as it was. Down removes both, and refuses, changing nothing, while any row keeps a snapshot
 * or once a later migration has run.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../index.js';

const TAG = '20261109025955_connection_grant_approver_snapshot';
const MIGRATIONS = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const DOWN = fileURLToPath(new URL(`../down/${TAG}.down.sql`, import.meta.url));

/** An approval, and a refused narrowing with awkward text. */
const ROWS: Record<string, unknown>[] = [
  {
    id: '01A',
    kind: 'approve_read',
    outcome: 'applied',
    refusal_code: null,
    actor_kind: 'agent',
    actor_id: 'pm',
    actor_session_id: 's1',
    target_agent_id: 'newbie',
    connection_id: 'c1',
    before_json: null,
    after_json: '{"level":"read","revisionIds":["r"],"excluded":false}',
    reason: null,
    request_id: 'req-1',
    undo_of: null,
    undone_by: null,
    created_at: '2026-11-09T01:00:00.000Z',
  },
  {
    id: '01B',
    kind: 'narrow_other',
    outcome: 'refused',
    refusal_code: 'GRANT_MARKED_TURN',
    actor_kind: 'agent',
    actor_id: 'pm',
    actor_session_id: 's1',
    target_agent_id: 'birch',
    connection_id: 'c1',
    before_json: null,
    after_json: null,
    reason: 'It wasn’t using it — "really".',
    request_id: null,
    undo_of: null,
    undone_by: null,
    created_at: '2026-11-09T01:01:00.000Z',
  },
];

describe('the access-change ledger keeps who approved', () => {
  let directory: string;
  let db: ReturnType<typeof createDb>;

  function journal() {
    return JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
  }

  function entry() {
    const found = journal().entries.find((e) => e.tag === TAG);
    expect(found).toBeDefined();
    return found!;
  }

  function migrateThrough(lastIdx: number) {
    const data = journal();
    const entries = data.entries.filter((e) => e.idx <= lastIdx);
    for (const e of entries)
      copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(directory, `${e.tag}.sql`));
    writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ ...data, entries }));
    migrate(db, { migrationsFolder: directory });
  }

  function rows() {
    return db.$client.prepare('SELECT * FROM connection_grant_changes ORDER BY id').all();
  }

  function columns() {
    return (
      db.$client.prepare(`PRAGMA table_info('connection_grant_changes')`).all() as {
        name: string;
      }[]
    ).map((c) => c.name);
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

  function runDown() {
    const sql = readFileSync(DOWN, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('.'))
      .join('\n');
    db.$client.exec(sql);
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'grant-approver-snapshot-migration-'));
    mkdirSync(join(directory, 'meta'));
    db = createDb(':memory:');
    migrateThrough(entry().idx - 1);
    for (const row of ROWS) {
      const cols = Object.keys(row);
      db.$client
        .prepare(
          `INSERT INTO connection_grant_changes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
        )
        .run(...Object.values(row));
    }
  });

  afterEach(() => {
    if (db.$client.open) db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('up adds the snapshot column and the request index, and keeps every row as it was', () => {
    const before = rows();
    const oldColumns = columns();
    migrateThrough(entry().idx);
    expect(columns()).toEqual([...oldColumns, 'actor_snapshot_json']);
    expect(indexes()).toContain('connection_grant_changes_request_idx');
    expect(rows()).toEqual(
      before.map((row) => ({ ...(row as object), actor_snapshot_json: null }))
    );
  });

  it('down puts the table back, and up again works', () => {
    const before = rows();
    const oldColumns = columns();
    const oldIndexes = indexes();
    migrateThrough(entry().idx);
    runDown();
    expect(columns()).toEqual(oldColumns);
    expect(indexes()).toEqual(oldIndexes);
    expect(rows()).toEqual(before);
    migrateThrough(entry().idx);
    expect(columns()).toContain('actor_snapshot_json');
  });

  it('down refuses, changing nothing, while a row keeps a snapshot', () => {
    migrateThrough(entry().idx);
    db.$client
      .prepare(`UPDATE connection_grant_changes SET actor_snapshot_json = ? WHERE id = '01A'`)
      .run('{"displayName":"DorkOS PM"}');
    expect(() => runDown()).toThrow(/CHECK constraint failed: refusals$/);
    db.$client.exec('ROLLBACK');
    expect(columns()).toContain('actor_snapshot_json');
    expect(indexes()).toContain('connection_grant_changes_request_idx');
  });

  it('down refuses, changing nothing, once a later migration has run', () => {
    migrateThrough(entry().idx);
    db.$client
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('later', entry().when + 1);
    expect(() => runDown()).toThrow(/CHECK constraint failed: refusals$/);
    db.$client.exec('ROLLBACK');
    expect(columns()).toContain('actor_snapshot_json');
  });
});
