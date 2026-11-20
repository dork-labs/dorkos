import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneSnapshots } from '../backup.js';

const DAILY = /^dork-\d{8}-daily\.db$/;
const PRE = /^dork-\d{8}-\d{6}-pre-(?:\d{4}|\d{14})_[a-z0-9_]+\.db$/;
let home: string;
let backups: string;
const log = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-snapshot-retention-'));
  backups = path.join(home, 'backups');
  fs.mkdirSync(backups);
  vi.stubEnv('DORK_HOME', home);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A completed, tiny SQLite snapshot, with no live DorkOS data. */
function plant(name: string, dir = backups): string {
  const file = path.join(dir, name);
  const db = new Database(file);
  try {
    db.exec('CREATE TABLE made_up (id INTEGER PRIMARY KEY)');
  } finally {
    db.close();
  }
  return file;
}

describe('bounded snapshot retention', () => {
  it('prunes the oldest completed copies, logs each deletion, and is idempotent', () => {
    for (let day = 1; day <= 5; day++) plant(`dork-2026110${day}-daily.db`);
    const newest = fs.readFileSync(path.join(backups, 'dork-20261105-daily.db'));

    expect(pruneSnapshots(backups, DAILY, 3, { log })).toEqual([
      'dork-20261101-daily.db',
      'dork-20261102-daily.db',
    ]);
    expect(fs.readdirSync(backups).sort()).toEqual([
      'dork-20261103-daily.db',
      'dork-20261104-daily.db',
      'dork-20261105-daily.db',
    ]);
    expect(fs.readFileSync(path.join(backups, 'dork-20261105-daily.db'))).toEqual(newest);
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info.mock.calls.flat().join('\n')).toContain('dork-20261101-daily.db');
    expect(pruneSnapshots(backups, DAILY, 3, { log })).toEqual([]);
    expect(log.info).toHaveBeenCalledTimes(2);
  });

  it('never deletes the newest name, including an unreadable newest copy and a zero limit', () => {
    plant('dork-20261101-daily.db');
    plant('dork-20261102-daily.db');
    const newest = path.join(backups, 'dork-20261103-daily.db');
    fs.writeFileSync(newest, '');

    pruneSnapshots(backups, DAILY, 0, { log });

    expect(fs.existsSync(newest)).toBe(true);
    expect(fs.readFileSync(newest)).toEqual(Buffer.alloc(0));
    expect(fs.existsSync(path.join(backups, 'dork-20261102-daily.db'))).toBe(true);
  });

  it('leaves foreign files, directories and partial writes alone even with a broad caller pattern', () => {
    plant('dork-20261101-daily.db');
    plant('dork-20261102-daily.db');
    const foreign = ['notes.txt', 'dork-20261101-120000-pre-personal.db', 'dork-20261301-daily.db'];
    const partials = ['dork-20261103-daily.db.partial', 'dork-20261103-daily.db.partial-journal'];
    for (const name of [...foreign, ...partials])
      fs.writeFileSync(path.join(backups, name), 'keep');
    fs.mkdirSync(path.join(backups, 'dork-20261001-daily.db'));

    pruneSnapshots(backups, /.*/, 1, { log });

    for (const name of [...foreign, ...partials]) {
      expect(fs.readFileSync(path.join(backups, name), 'utf8')).toBe('keep');
    }
    expect(fs.statSync(path.join(backups, 'dork-20261001-daily.db')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(backups, 'dork-20261101-daily.db'))).toBe(false);
  });

  it('refuses a snapshot symlink, without counting it as a retained copy', () => {
    const outside = plant('outside.db', home);
    const bytes = fs.readFileSync(outside);
    const link = path.join(backups, 'dork-20261103-daily.db');
    fs.symlinkSync(outside, link);
    plant('dork-20261101-daily.db');
    plant('dork-20261102-daily.db');

    expect(pruneSnapshots(backups, DAILY, 1, { log })).toEqual(['dork-20261101-daily.db']);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside)).toEqual(bytes);
    expect(fs.existsSync(path.join(backups, 'dork-20261102-daily.db'))).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });

  it('refuses a symlinked backups directory', () => {
    const actual = path.join(home, 'actual');
    fs.mkdirSync(actual);
    plant('dork-20261101-daily.db', actual);
    plant('dork-20261102-daily.db', actual);
    const link = path.join(home, 'linked-backups');
    fs.symlinkSync(actual, link, 'dir');

    expect(pruneSnapshots(link, DAILY, 1, { log })).toEqual([]);
    expect(fs.readdirSync(actual)).toHaveLength(2);
    expect(log.warn).toHaveBeenCalled();
  });

  it('keeps seven days of pre-migration history with an exact cutoff and a count ceiling', () => {
    const oldest = 'dork-20261101-120000-pre-0001_made_up.db';
    plant(oldest);
    plant('dork-20261113-115959-pre-0001_made_up.db');
    plant('dork-20261113-120000-pre-0001_made_up.db');
    plant('dork-20261120-120000-pre-0001_made_up.db');
    const options = { log, now: new Date('2026-11-20T12:00:00Z'), maxAgeDays: 7 };

    expect(pruneSnapshots(backups, PRE, 3, options)).toEqual([
      oldest,
      'dork-20261113-115959-pre-0001_made_up.db',
    ]);
    expect(fs.readdirSync(backups).sort()).toEqual([
      'dork-20261113-120000-pre-0001_made_up.db',
      'dork-20261120-120000-pre-0001_made_up.db',
    ]);
    for (let second = 1; second <= 12; second++) {
      plant(`dork-20261120-1200${String(second).padStart(2, '0')}-pre-0001_made_up.db`);
    }
    pruneSnapshots(backups, PRE, 3, options);
    expect(fs.readdirSync(backups)).toHaveLength(3);
    expect(fs.readdirSync(backups).sort()[0]).toBe('dork-20261120-120010-pre-0001_made_up.db');
  });

  it('keeps the newest recovery copy even when every copy has aged out', () => {
    plant('dork-20261101-120000-pre-0001_made_up.db');
    const newest = plant('dork-20261102-120000-pre-0001_made_up.db');

    pruneSnapshots(backups, PRE, 3, {
      log,
      now: new Date('2026-11-20T12:00:00Z'),
      maxAgeDays: 7,
    });

    expect(fs.readdirSync(backups)).toEqual([path.basename(newest)]);
  });

  it('bounds copies named for a timestamp migration from the shipped journal', () => {
    const journal = JSON.parse(
      fs.readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')
    ) as { entries: { tag: string }[] };
    const tag = journal.entries.at(-1)!.tag;
    expect(tag).toMatch(/^\d{14}_/);
    for (let second = 1; second <= 12; second++) {
      plant(`dork-20261120-1200${String(second).padStart(2, '0')}-pre-${tag}.db`);
    }

    expect(pruneSnapshots(backups, PRE, 3, { log })).toEqual(
      Array.from(
        { length: 9 },
        (_, index) => `dork-20261120-1200${String(index + 1).padStart(2, '0')}-pre-${tag}.db`
      )
    );
    expect(fs.readdirSync(backups)).toHaveLength(3);
  });

  it('leaves a locked recovery copy alone when no journal has been written', () => {
    const oldest = plant('dork-20261101-daily.db');
    plant('dork-20261102-daily.db');
    const lock = new Database(oldest);
    lock.exec('BEGIN EXCLUSIVE');
    try {
      expect(fs.existsSync(`${oldest}-journal`)).toBe(false);
      expect(pruneSnapshots(backups, DAILY, 1, { log })).toEqual([]);
      expect(fs.existsSync(oldest)).toBe(true);
      expect(log.warn).toHaveBeenCalled();
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
  });

  it('protects the just-written snapshot if the clock moved backwards', () => {
    const current = plant('dork-20261101-daily.db');
    plant('dork-20261102-daily.db');
    plant('dork-20261103-daily.db');
    plant('dork-20261104-daily.db');

    pruneSnapshots(backups, DAILY, 3, { log, protectedPath: current });

    expect(fs.readdirSync(backups).sort()).toEqual([
      'dork-20261101-daily.db',
      'dork-20261103-daily.db',
      'dork-20261104-daily.db',
    ]);
  });

  it('leaves a completed file with a partial sibling alone', () => {
    const writing = plant('dork-20261101-daily.db');
    fs.writeFileSync(`${writing}.partial`, 'in progress');
    plant('dork-20261102-daily.db');
    plant('dork-20261103-daily.db');

    pruneSnapshots(backups, DAILY, 1, { log });

    expect(fs.existsSync(writing)).toBe(true);
    expect(fs.readFileSync(`${writing}.partial`, 'utf8')).toBe('in progress');
    expect(fs.existsSync(path.join(backups, 'dork-20261102-daily.db'))).toBe(false);
  });

  it('reports a failed deletion and continues without blocking the snapshot caller', () => {
    plant('dork-20261101-daily.db');
    plant('dork-20261102-daily.db');
    const remove = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw new Error('made-up filesystem refusal');
    });

    expect(pruneSnapshots(backups, DAILY, 1, { log })).toEqual([]);

    expect(fs.readdirSync(backups)).toHaveLength(2);
    expect(log.warn).toHaveBeenCalled();
    remove.mockRestore();
  });

  it('leaves a copy alone if its identity changes during inspection', () => {
    const oldest = plant('dork-20261101-daily.db');
    plant('dork-20261102-daily.db');
    const originalStat = fs.statSync;
    let replaced = false;
    vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike) => {
      if (file === oldest && !replaced) {
        replaced = true;
        fs.renameSync(oldest, path.join(home, 'parked.db'));
        fs.writeFileSync(oldest, 'changed during inspection');
      }
      return originalStat(file);
    }) as typeof fs.statSync);

    expect(pruneSnapshots(backups, DAILY, 1, { log })).toEqual([]);

    expect(replaced).toBe(true);
    expect(fs.readFileSync(oldest, 'utf8')).toBe('changed during inspection');
    expect(fs.existsSync(path.join(home, 'parked.db'))).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });
});
