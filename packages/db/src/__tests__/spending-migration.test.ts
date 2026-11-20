/**
 * The monthly spend limit's tables (DOR-4204). Up adds three new tables and
 * touches no existing row; down drops them and the ledger row, and refuses,
 * changing nothing, once a later migration has run.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../index.js';

const TAG = '20261116184410_dor4204_spending';
const WHEN = 1794854650053;
const TABLES = ['spending_prices', 'spending_runs', 'spending_settings'];
const MIGRATIONS = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const DOWN = fileURLToPath(new URL(`../down/${TAG}.down.sql`, import.meta.url));

let directory: string;
let db: Db;

/**
 * Apply every migration up to and including this one, and none after it: the
 * down file refuses once a later migration has run, so the real head would
 * stop it from coming off as soon as anything lands on top.
 */
function migrateThroughThis(): void {
  const data = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const own = data.entries.find((entry) => entry.tag === TAG);
  expect(own).toMatchObject({ when: WHEN });
  const entries = data.entries.filter((entry) => entry.idx <= own!.idx);
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  }
  writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ ...data, entries }));
  migrate(db, { migrationsFolder: directory });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spending-migration-'));
  mkdirSync(join(directory, 'meta'));
  db = createDb(':memory:');
  migrateThroughThis();
});

afterEach(() => {
  if (db.$client.open) db.$client.close();
  rmSync(directory, { recursive: true, force: true });
});

function tables(): string[] {
  return (
    db.$client
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'spending_%'`)
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .sort();
}

function ledger(): number {
  return (
    db.$client
      .prepare('SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at = ?')
      .get(WHEN) as { n: number }
  ).n;
}

/** Run the down file as the sqlite3 shell would, minus its dot-commands. */
function runDown(): void {
  db.$client.exec(
    readFileSync(DOWN, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('.'))
      .join('\n')
  );
}

describe('spending tables', () => {
  it('adds the three spending tables', () => {
    expect(tables()).toEqual(TABLES);
  });

  it('holds at most one settings row, and no limit of zero', () => {
    const insert = db.$client.prepare(
      'INSERT INTO spending_settings (id, limit_micro, updated_at) VALUES (?, ?, ?)'
    );
    insert.run(1, null, '2026-11-16T00:00:00.000Z');
    expect(() => insert.run(2, null, '2026-11-16T00:00:00.000Z')).toThrow();
    expect(() =>
      db.$client.prepare('UPDATE spending_settings SET limit_micro = 0 WHERE id = 1').run()
    ).toThrow();
  });

  it('tells the sqlite3 shell to stop at the first error', () => {
    expect(readFileSync(DOWN, 'utf8').split('\n')[0]).toBe('.bail on');
  });

  it('comes off with its ledger row, and the migration runs again', () => {
    expect(ledger()).toBe(1);
    runDown();
    expect(tables()).toEqual([]);
    expect(ledger()).toBe(0);
    migrateThroughThis();
    expect(tables()).toEqual(TABLES);
  });

  it('refuses, changing nothing, once a later migration has run', () => {
    db.$client
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('later', WHEN + 1);
    expect(() => runDown()).toThrow();
    db.$client.exec('ROLLBACK');
    expect(tables()).toEqual(TABLES);
    expect(ledger()).toBe(1);
  });
});
