import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  openExtensionDb,
  ensureMeta,
  getSchemaVersion,
  setSchemaVersion,
  measureBytes,
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

  it('creates the database file on disk', () => {
    // Opening a fresh path materializes store.db.
    const p = dbPath();
    const db = openExtensionDb(p);
    db.close();
    expect(fs.existsSync(p)).toBe(true);
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

  it('is idempotent (a second call does not throw)', () => {
    const db = openExtensionDb(dbPath());
    try {
      ensureMeta(db);
      expect(() => ensureMeta(db)).not.toThrow();
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

  it('returns 0 after ensureMeta but before any version is set', () => {
    const db = openExtensionDb(dbPath());
    try {
      ensureMeta(db);
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

describe('measureBytes', () => {
  it('grows after inserting rows', () => {
    // page_count * page_size increases as data is written.
    const db = openExtensionDb(dbPath());
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)');
      const before = measureBytes(db);
      const insert = db.prepare('INSERT INTO t (blob) VALUES (?)');
      const big = 'x'.repeat(10_000);
      for (let i = 0; i < 200; i++) insert.run(big);
      const after = measureBytes(db);
      expect(after).toBeGreaterThan(before);
    } finally {
      db.close();
    }
  });
});

describe('ExtensionDbCache', () => {
  it('returns the same handle for repeated gets of one path', () => {
    const cache = new ExtensionDbCache(4);
    try {
      const a = cache.get(dbPath());
      const b = cache.get(dbPath());
      expect(a).toBe(b);
      expect(cache.size).toBe(1);
    } finally {
      cache.closeAll();
    }
  });

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

  it('keeps a recently-used handle and evicts the truly-oldest', () => {
    // Re-getting 'a' before overflowing marks it MRU, so 'b' is evicted instead.
    const cache = new ExtensionDbCache(2);
    try {
      const a = cache.get(dbPath('a.db'));
      const b = cache.get(dbPath('b.db'));
      cache.get(dbPath('a.db')); // touch a → a is now MRU, b is LRU
      cache.get(dbPath('c.db')); // overflow → evict b
      expect(() => a.prepare('SELECT 1').get()).not.toThrow();
      expect(() => b.prepare('SELECT 1').get()).toThrow(/database connection is not open/i);
    } finally {
      cache.closeAll();
    }
  });

  it('close(dbPath) closes and forgets a single handle', () => {
    const cache = new ExtensionDbCache(4);
    const handle = cache.get(dbPath());
    cache.close(dbPath());
    expect(cache.size).toBe(0);
    expect(() => handle.prepare('SELECT 1').get()).toThrow(/database connection is not open/i);
  });

  it('closeAll closes every cached handle', () => {
    const cache = new ExtensionDbCache(4);
    const a = cache.get(dbPath('a.db'));
    const b = cache.get(dbPath('b.db'));
    cache.closeAll();
    expect(cache.size).toBe(0);
    expect(() => a.prepare('SELECT 1').get()).toThrow(/database connection is not open/i);
    expect(() => b.prepare('SELECT 1').get()).toThrow(/database connection is not open/i);
  });
});
