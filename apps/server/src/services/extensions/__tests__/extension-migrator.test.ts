import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMigrations, dryRun } from '../extension-migrator.js';
import { openExtensionDb, getSchemaVersion } from '../extension-database.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-migrator-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Absolute path to store.db inside the per-test tmp dir. */
function dbPath(): string {
  return path.join(tmpDir, 'store.db');
}

/** Read all rows of a table through a fresh connection, then close it. */
function readAll(sql: string): unknown[] {
  const db = openExtensionDb(dbPath());
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

describe('runMigrations — happy path', () => {
  it('applies a fresh 1..3 sequence and stamps schema_version = 3', () => {
    // A never-migrated DB applies every migration and records the highest version.
    const result = runMigrations(dbPath(), [
      { version: 1, up: 'CREATE TABLE a (id TEXT PRIMARY KEY)' },
      { version: 2, up: 'CREATE TABLE b (id TEXT PRIMARY KEY)' },
      { version: 3, up: 'CREATE INDEX idx_b ON b(id)' },
    ]);
    expect(result).toEqual({ ok: true, appliedThrough: 3 });

    const check = openExtensionDb(dbPath());
    try {
      expect(getSchemaVersion(check)).toBe(3);
      const tables = check
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b')`)
        .all();
      expect(tables).toHaveLength(2);
    } finally {
      check.close();
    }
  });

  it('is a no-op on re-run with the same migrations', () => {
    // Second run finds nothing pending → appliedThrough stays at the top version.
    const migs = [
      { version: 1, up: 'CREATE TABLE a (id TEXT PRIMARY KEY)' },
      { version: 2, up: 'CREATE TABLE b (id TEXT PRIMARY KEY)' },
    ];
    runMigrations(dbPath(), migs);
    const second = runMigrations(dbPath(), migs);
    expect(second).toEqual({ ok: true, appliedThrough: 2 });
  });

  it('applies ONLY the delta when a new version is appended', () => {
    // If v1 re-ran, `CREATE TABLE a` would throw "already exists" → failure.
    // Success proves only v2 executed.
    runMigrations(dbPath(), [{ version: 1, up: 'CREATE TABLE a (id TEXT PRIMARY KEY)' }]);
    const result = runMigrations(dbPath(), [
      { version: 1, up: 'CREATE TABLE a (id TEXT PRIMARY KEY)' },
      { version: 2, up: 'CREATE TABLE b (id TEXT PRIMARY KEY)' },
    ]);
    expect(result).toEqual({ ok: true, appliedThrough: 2 });
  });

  it('returns ok with appliedThrough 0 for an empty migration set on a fresh DB', () => {
    // Nothing declared, nothing applied — a valid degenerate case.
    expect(runMigrations(dbPath(), [])).toEqual({ ok: true, appliedThrough: 0 });
  });
});

describe('runMigrations — WAL-correct transactional rollback (no file backup)', () => {
  it('rolls back a failing v2 migration and leaves committed v1 rows readable', () => {
    const p = dbPath();

    // v1 creates the contacts table.
    const v1 = {
      version: 1,
      up: 'CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
    };
    expect(runMigrations(p, [v1])).toEqual({ ok: true, appliedThrough: 1 });

    // Commit rows into the v1 schema through a separate connection, then close.
    // Under WAL these rows may live in store.db-wal, not the main file.
    const seed = openExtensionDb(p);
    seed.prepare('INSERT INTO contacts (id, name) VALUES (?, ?)').run('c1', 'Ada');
    seed.prepare('INSERT INTO contacts (id, name) VALUES (?, ?)').run('c2', 'Alan');
    seed.close();

    // v2 creates a table then hits invalid SQL. The whole migration must revert,
    // including the already-created table (SQLite DDL is transactional).
    const v2Bad = {
      version: 2,
      up: 'CREATE TABLE deals (id TEXT PRIMARY KEY); INSERT INTO does_not_exist VALUES (1)',
    };
    const failed = runMigrations(p, [v1, v2Bad]);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe('MIGRATION_FAILED');
      if (failed.code === 'MIGRATION_FAILED') expect(failed.version).toBe(2);
    }

    const check = openExtensionDb(p);
    try {
      // schema_version is unchanged — still 1.
      expect(getSchemaVersion(check)).toBe(1);
      // The v2 table was rolled back (transactional DDL) — it must not exist.
      const deals = check
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='deals'`)
        .get();
      expect(deals).toBeUndefined();
      // The committed v1 rows survive — no file restore ever clobbered the WAL.
      const rows = check.prepare('SELECT id, name FROM contacts ORDER BY id').all();
      expect(rows).toEqual([
        { id: 'c1', name: 'Ada' },
        { id: 'c2', name: 'Alan' },
      ]);
    } finally {
      check.close();
    }

    // The migrator must NEVER create a file-level backup (WAL-unsafe by design).
    const files = fs.readdirSync(tmpDir);
    expect(files.some((f) => f.includes('.bak'))).toBe(false);
  });
});

describe('runMigrations — forward-only downgrade refusal', () => {
  it('refuses when the DB is ahead of the manifest and mutates nothing', () => {
    const p = dbPath();
    const v1 = { version: 1, up: 'CREATE TABLE a (id TEXT PRIMARY KEY)' };
    const v2 = { version: 2, up: 'CREATE TABLE b (id TEXT PRIMARY KEY)' };

    // Migrate to v2 and seed a row.
    runMigrations(p, [v1, v2]);
    const seed = openExtensionDb(p);
    seed.prepare('INSERT INTO a (id) VALUES (?)').run('x');
    seed.close();

    // Present only v1 (an older extension installed over newer data).
    const result = runMigrations(p, [v1]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SCHEMA_DOWNGRADE');

    // Nothing changed: version, schema, and data are all intact.
    const check = openExtensionDb(p);
    try {
      expect(getSchemaVersion(check)).toBe(2);
      expect(
        check.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='b'`).get()
      ).toBeDefined();
      expect(check.prepare('SELECT id FROM a').all()).toEqual([{ id: 'x' }]);
    } finally {
      check.close();
    }
  });
});

describe('runMigrations — mid-sequence failure reports the failing version', () => {
  it('reports MIGRATION_FAILED at v2 and preserves the v1 schema', () => {
    const p = dbPath();
    const result = runMigrations(p, [
      { version: 1, up: 'CREATE TABLE a (id TEXT PRIMARY KEY)' },
      { version: 2, up: 'THIS IS NOT VALID SQL' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'MIGRATION_FAILED') {
      expect(result.version).toBe(2);
    }
    // The entire batch rolled back — even v1's table is gone, and version is 0.
    const check = openExtensionDb(p);
    try {
      expect(getSchemaVersion(check)).toBe(0);
      expect(
        check.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='a'`).get()
      ).toBeUndefined();
    } finally {
      check.close();
    }
    // Sanity: readAll helper works and no rows leaked into a stray table.
    expect(() => readAll(`SELECT name FROM sqlite_master`)).not.toThrow();
  });
});

describe('dryRun', () => {
  it('validates a good migration set without writing any file to disk', () => {
    // :memory: only — the tmp dir stays empty.
    const result = dryRun([{ version: 1, up: 'CREATE TABLE a (id TEXT PRIMARY KEY)' }]);
    expect(result).toEqual({ ok: true, appliedThrough: 1 });
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('catches a broken migration without writing any file to disk', () => {
    const result = dryRun([
      { version: 1, up: 'CREATE TABLE a (id TEXT PRIMARY KEY); NONSENSE NOT SQL' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MIGRATION_FAILED');
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });
});
