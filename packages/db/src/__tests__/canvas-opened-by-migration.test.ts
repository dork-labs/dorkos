/**
 * The "opened by an app" column on canvas documents (DOR-3293). Up adds one
 * nullable column and keeps every row; down removes it and its ledger row, and
 * refuses, changing nothing, once a later migration has run.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../index.js';

const WHEN = 1794358814627;
const DOWN = fileURLToPath(
  new URL('../down/20261111010014_canvas_opened_by.down.sql', import.meta.url)
);

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
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
    runMigrations(db);
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
