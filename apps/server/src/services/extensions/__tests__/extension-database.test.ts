import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  openExtensionDb,
  ensureMeta,
  getSchemaVersion,
  setSchemaVersion,
  ExtensionDbCache,
} from '../extension-database.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-db-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Absolute path to a fresh store.db inside the per-test tmp dir. */
function dbPath(name = 'store.db'): string {
  return path.join(tmpDir, name);
}

describe('openExtensionDb — house pragmas', () => {
  it('applies WAL, NORMAL sync, 5s busy timeout, and foreign keys on a file DB', () => {
    // All four house pragmas must match @dorkos/db's createDb (asserted via reads).
    const db = openExtensionDb(dbPath());
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL === 1
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1); // ON === 1
    } finally {
      db.close();
    }
  });
});

describe('ensureMeta', () => {
  it('creates the _dork_meta table', () => {
    const db = openExtensionDb(dbPath());
    try {
      ensureMeta(db);
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_dork_meta'`)
        .get();
      expect(row).toBeDefined();
    } finally {
      db.close();
    }
  });
});

describe('getSchemaVersion / setSchemaVersion', () => {
  it('returns 0 on a fresh DB with no meta table', () => {
    // A never-migrated DB is at version 0 even before ensureMeta runs.
    const db = openExtensionDb(dbPath());
    try {
      expect(getSchemaVersion(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('round-trips a version through set → get', () => {
    // setSchemaVersion upserts the schema_version row; getSchemaVersion reads it.
    const db = openExtensionDb(dbPath());
    try {
      ensureMeta(db);
      setSchemaVersion(db, 3);
      expect(getSchemaVersion(db)).toBe(3);
      // Upsert overwrites rather than duplicating.
      setSchemaVersion(db, 5);
      expect(getSchemaVersion(db)).toBe(5);
    } finally {
      db.close();
    }
  });
});

describe('ExtensionDbCache', () => {
  it('evicts and CLOSES the least-recently-used handle past the size bound', () => {
    // maxSize=1 forces the first handle to be evicted when the second opens;
    // the evicted handle must be closed (using it throws).
    const cache = new ExtensionDbCache(1);
    try {
      const first = cache.get(dbPath('a.db'));
      cache.get(dbPath('b.db')); // opening this evicts a.db
      expect(cache.size).toBe(1);
      expect(() => first.prepare('SELECT 1').get()).toThrow(/database connection is not open/i);
    } finally {
      cache.closeAll();
    }
  });
});
