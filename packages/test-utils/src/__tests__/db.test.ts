import { afterEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import type { Db } from '@dorkos/db';
import { createTestDb } from '../db.js';

/**
 * Every readable pragma that is per-connection or lives in the file header.
 * The per-connection ones are what a copied image does NOT carry, so each must
 * come out of `createDbFromImage` exactly as `createDb` sets it.
 */
const PRAGMAS = [
  'journal_mode',
  'synchronous',
  'busy_timeout',
  'foreign_keys',
  'recursive_triggers',
  'secure_delete',
  'defer_foreign_keys',
  'ignore_check_constraints',
  'trusted_schema',
  'cell_size_check',
  'query_only',
  'legacy_alter_table',
  'automatic_index',
  'reverse_unordered_selects',
  'temp_store',
  'locking_mode',
  'cache_size',
  'cache_spill',
  'journal_size_limit',
  'mmap_size',
  'page_size',
  'auto_vacuum',
  'encoding',
  'user_version',
  'application_id',
] as const;

/** The database `createTestDb` used to return: a full migration replay. */
function createReplayedDb(): Db {
  const db = createDb(':memory:');
  runMigrations(db);
  return db;
}

function pragmaValues(db: Db): Record<string, unknown> {
  return Object.fromEntries(
    PRAGMAS.map((name) => [name, db.$client.pragma(name, { simple: true })])
  );
}

function tableNames(db: Db): string[] {
  return db.$client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .pluck()
    .all() as string[];
}

describe('createTestDb', () => {
  const opened: Db[] = [];
  const track = (db: Db): Db => {
    opened.push(db);
    return db;
  };

  afterEach(() => {
    for (const db of opened.splice(0)) db.$client.close();
  });

  it('has every pragma equal to a database migrated the old way', () => {
    const replayed = track(createReplayedDb());
    const copy = track(createTestDb());

    expect(pragmaValues(copy)).toEqual(pragmaValues(replayed));
    // The two the message-search index and erasure depend on, stated outright
    // so a regression in both paths at once still fails here.
    expect(copy.$client.pragma('recursive_triggers', { simple: true })).toBe(1);
    expect(copy.$client.pragma('secure_delete', { simple: true })).toBe(1);
    expect(copy.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('has the same schema and migration history as a replayed database', () => {
    const replayed = track(createReplayedDb());
    const copy = track(createTestDb());

    const schemaSql = (db: Db) =>
      db.$client
        .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
        .all();
    const migrations = (db: Db) =>
      db.$client.prepare('SELECT hash FROM __drizzle_migrations ORDER BY id').pluck().all();

    expect(schemaSql(copy)).toEqual(schemaSql(replayed));
    expect(migrations(copy)).toEqual(migrations(replayed));
    expect(Object.keys(copy.query).sort()).toEqual(Object.keys(replayed.query).sort());
  });

  it('returns independent copies: a write to one reaches neither another copy nor the template', () => {
    const first = track(createTestDb());
    const second = track(createTestDb());

    first.$client.exec('CREATE TABLE scratch (v TEXT)');
    first.$client.prepare('INSERT INTO scratch (v) VALUES (?)').run('only-in-first');
    first.$client.prepare('DELETE FROM __drizzle_migrations').run();

    expect(tableNames(first)).toContain('scratch');
    expect(tableNames(second)).not.toContain('scratch');
    expect(
      second.$client.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get()
    ).toBeGreaterThan(0);

    // A copy made after the write comes from the untouched template.
    const third = track(createTestDb());
    expect(tableNames(third)).not.toContain('scratch');
    expect(
      third.$client.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get()
    ).toBeGreaterThan(0);
  });

  it('closing one copy leaves the others usable', () => {
    const first = createTestDb();
    const second = track(createTestDb());
    first.$client.close();

    expect(second.$client.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(track(createTestDb()).$client.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});
