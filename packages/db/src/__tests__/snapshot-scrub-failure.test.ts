/**
 * A snapshot whose recorded turn text could not be emptied is a failed
 * snapshot (DOR-4001): nothing is left at its name or beside it, for either
 * kind, and the caller hears the failure.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../snapshot-scrub.js', () => ({
  scrubSnapshot: vi.fn(() => {
    throw new Error('made-up scrub failure');
  }),
}));

import { createDb, runMigrations, type Db } from '../index.js';
import { SnapshotFailedError, snapshotDaily, snapshotSqlite } from '../backup.js';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snapshot-scrub-failure-'));
  db = createDb(join(dir, 'dork.db'));
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a scrub that fails', () => {
  it('fails a pre-migration snapshot and leaves no file behind', () => {
    const file = join(dir, 'backups', 'dork-20261108-000000-pre-x.db');
    expect(() => snapshotSqlite(db.$client, file)).toThrow(/made-up scrub failure/);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(join(dir, 'backups'))).toEqual([]);
  });

  it('fails a daily snapshot and leaves no file behind', async () => {
    const backups = join(dir, 'backups');
    await expect(
      snapshotDaily(db, { dir: backups, now: new Date('2026-11-08T12:00:00Z') })
    ).rejects.toBeInstanceOf(SnapshotFailedError);
    expect(readdirSync(backups)).toEqual([]);
  });
});
