/**
 * The "opened by an app" column on canvas documents (DOR-3293). Up adds one
 * nullable column and keeps every row; down removes it and its ledger row, and
 * refuses, changing nothing, once a later migration has run.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../index.js';

const TAG = '20261116015205_canvas_opened_by';
const WHEN = 1794793925059;
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
    entries: Array<{ idx: number; tag: string }>;
  };
  const own = data.entries.find((entry) => entry.tag === TAG);
  expect(own).toBeDefined();
  const entries = data.entries.filter((entry) => entry.idx <= own!.idx);
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  }
  writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ ...data, entries }));
  migrate(db, { migrationsFolder: directory });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-opened-by-migration-'));
  mkdirSync(join(directory, 'meta'));
  db = createDb(':memory:');
  migrateThroughThis();
});

afterEach(() => {
  if (db.$client.open) db.$client.close();
  rmSync(directory, { recursive: true, force: true });
});

function columns(): string[] {
  return (
    db.$client.prepare(`PRAGMA table_info('canvas_documents')`).all() as { name: string }[]
  ).map((column) => column.name);
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

describe('canvas_documents.opened_by_extension_id', () => {
  it('is a nullable column every existing row starts without', () => {
    const column = (
      db.$client.prepare(`PRAGMA table_info('canvas_documents')`).all() as {
        name: string;
        notnull: number;
      }[]
    ).find((entry) => entry.name === 'opened_by_extension_id');
    expect(column).toMatchObject({ notnull: 0 });
  });

  it('tells the sqlite3 shell to stop at the first error', () => {
    expect(readFileSync(DOWN, 'utf8').split('\n')[0]).toBe('.bail on');
  });

  it('comes off with its ledger row, and the migration runs again', () => {
    expect(ledger()).toBe(1);
    runDown();
    expect(columns()).not.toContain('opened_by_extension_id');
    expect(ledger()).toBe(0);
    migrateThroughThis();
    expect(columns()).toContain('opened_by_extension_id');
  });

  it('refuses, changing nothing, once a later migration has run', () => {
    db.$client
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('later', WHEN + 1);
    expect(() => runDown()).toThrow();
    db.$client.exec('ROLLBACK');
    expect(columns()).toContain('opened_by_extension_id');
    expect(ledger()).toBe(1);
  });
});
