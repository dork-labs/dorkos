import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSupportedDatabaseUpgrade,
  DatabasePreflightError,
  DatabaseUpgradeRequiredError,
  MINIMUM_DATABASE_UPGRADE_TIMESTAMP as FLOOR,
} from '../upgrade-floor.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A crash-like synthetic WAL fixture: never copy a person's database. */
function fixture(main: number, wal?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-db-floor-'));
  roots.push(root);
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const file = path.join(source, 'dork.db');
  const builder = path.join(root, 'builder.db');
  const db = new Database(builder);
  try {
    db.pragma('journal_mode = WAL');
    db.exec(
      `CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER); CREATE TABLE fixture_data(value TEXT); INSERT INTO fixture_data VALUES ('unchanged')`
    );
    db.prepare('INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)').run(
      'fixture-main',
      main
    );
    db.pragma('wal_checkpoint(TRUNCATE)');
    if (wal !== undefined)
      db.prepare('INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)').run(
        'fixture-wal',
        wal
      );
    fs.copyFileSync(builder, file);
    if (wal !== undefined) fs.copyFileSync(`${builder}-wal`, `${file}-wal`);
  } finally {
    db.close();
  }
  return { source, file };
}

/** Full source listing and every file hash, including SQLite sidecars. */
function inventory(dir: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(dir, name)))
          .digest('hex'),
      ])
  );
}

function receipt(
  name: string,
  before: Record<string, string>,
  after: Record<string, string>,
  sizes?: Record<string, number>
) {
  console.info(JSON.stringify({ case: name, before, after, sizes }));
}

function unchangedData(before: Record<string, string>, after: Record<string, string>) {
  for (const name of Object.keys(before).filter((name) => !name.endsWith('-shm')))
    expect(after[name]).toBe(before[name]);
  expect(Object.keys(after).filter((name) => !(name in before))).toEqual(['dork.db-shm']);
}

describe('database upgrade floor, after the instance lock', () => {
  it('keeps the floor timestamp in the shipped migration journal', () => {
    const journal = JSON.parse(
      fs.readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')
    ) as { entries: Array<{ when: number }> };
    expect(journal.entries.some((entry) => entry.when === FLOOR)).toBe(true);
  });
  it('case 1: supported immutable main proceeds with zero new files, even with pending WAL', () => {
    const { source, file } = fixture(FLOOR, FLOOR + 1);
    const before = inventory(source);
    const normal = vi.spyOn(Database.prototype, 'prepare');
    assertSupportedDatabaseUpgrade(file);
    expect(normal).not.toHaveBeenCalled();
    const after = inventory(source);
    receipt('1', before, after);
    expect(after).toEqual(before);
  });

  it.each(['missing', 'empty'])(
    'case 2: old main with %s WAL refuses with identical files',
    (kind) => {
      const { source, file } = fixture(FLOOR - 1);
      if (kind === 'empty') fs.writeFileSync(`${file}-wal`, '');
      const before = inventory(source);
      const normal = vi.spyOn(Database.prototype, 'prepare');
      expect(() => assertSupportedDatabaseUpgrade(file)).toThrow(DatabaseUpgradeRequiredError);
      expect(normal).not.toHaveBeenCalled();
      const after = inventory(source);
      receipt(`2-${kind}`, before, after);
      expect(after).toEqual(before);
    }
  );

  it.each([FLOOR - 1, FLOOR])(
    'case 3: old main with pending WAL trusts the read-only watermark %s',
    (wal) => {
      const { source, file } = fixture(FLOOR - 2, wal);
      const before = inventory(source);
      if (wal >= FLOOR) expect(() => assertSupportedDatabaseUpgrade(file)).not.toThrow();
      else expect(() => assertSupportedDatabaseUpgrade(file)).toThrow(DatabaseUpgradeRequiredError);
      const after = inventory(source);
      receipt(`3-${wal}`, before, after);
      unchangedData(before, after);
    }
  );

  it.each([FLOOR - 1, FLOOR])(
    'case 4: immutable error uses read-only and trusts watermark %s',
    (wal) => {
      const { source, file } = fixture(FLOOR - 2, wal);
      const before = inventory(source);
      vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementationOnce(() => {
        throw new Error('fixture checkpoint race');
      });
      if (wal >= FLOOR) expect(() => assertSupportedDatabaseUpgrade(file)).not.toThrow();
      else expect(() => assertSupportedDatabaseUpgrade(file)).toThrow(DatabaseUpgradeRequiredError);
      const after = inventory(source);
      receipt(`4-${wal}`, before, after);
      unchangedData(before, after);
    }
  );

  it.each([FLOOR - 1, FLOOR])(
    'case 4: without WAL, keeps empty WAL and SHM after watermark %s is checked',
    (main) => {
      const { source, file } = fixture(main);
      const before = inventory(source);
      expect(Object.keys(before)).toEqual(['dork.db']);
      vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementationOnce(() => {
        throw new Error('fixture checkpoint race without WAL');
      });
      if (main >= FLOOR) expect(() => assertSupportedDatabaseUpgrade(file)).not.toThrow();
      else expect(() => assertSupportedDatabaseUpgrade(file)).toThrow(DatabaseUpgradeRequiredError);

      // Inspect AFTER the return/refusal: neither outcome may clean up SQLite metadata.
      expect(fs.existsSync(`${file}-wal`)).toBe(true);
      expect(fs.existsSync(`${file}-shm`)).toBe(true);
      const after = inventory(source);
      const sizes = Object.fromEntries(
        Object.keys(after).map((name) => [name, fs.statSync(path.join(source, name)).size])
      );
      receipt(`4-no-wal-${main >= FLOOR ? 'proceed' : 'refuse'}`, before, after, sizes);
      expect(after['dork.db']).toBe(before['dork.db']);
      expect(Object.keys(after)).toEqual(['dork.db', 'dork.db-shm', 'dork.db-wal']);
      expect(sizes['dork.db-wal']).toBe(0);
      expect(sizes['dork.db-shm']).toBeGreaterThan(0);
    }
  );

  it('does not create a missing database or any source files', () => {
    const { source, file } = fixture(FLOOR);
    fs.rmSync(file);
    const before = inventory(source);
    assertSupportedDatabaseUpgrade(file);
    expect(inventory(source)).toEqual(before);
  });

  it('fails closed on an unreadable database without recovering or rewriting it', () => {
    const { source, file } = fixture(FLOOR);
    fs.writeFileSync(file, 'not a SQLite database');
    const before = inventory(source);
    expect(() => assertSupportedDatabaseUpgrade(file)).toThrow(DatabasePreflightError);
    expect(inventory(source)).toEqual(before);
  });
});
