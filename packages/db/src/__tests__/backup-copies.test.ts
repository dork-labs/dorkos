/**
 * The person's Settings → Backups actions (DOR-4253): list writer-named copies,
 * and remove or move only older `dork-` copies, never a symlink, a look-alike or
 * a copy DorkOS manages. Real files in a temp folder; made-up data only.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBackupCopies, moveOlderBackupCopy, removeOlderBackupCopy } from '../backup-copies.js';

let root: string;
let dir: string;
let elsewhere: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backup-copies-')));
  dir = path.join(root, 'backups');
  elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(dir);
  fs.mkdirSync(elsewhere);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A real, small SQLite copy. */
function sqliteCopy(file: string): void {
  const db = new Database(file);
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  db.prepare('INSERT INTO notes (body) VALUES (?)').run('made-up row');
  db.close();
}

const OLDER_DAILY = 'dork-20260901-daily.db';
const OLDER_PRE = 'dork-20260815-101500-pre-0042_add_notes.db';
const MANAGED_DAILY = 'dork-auto-20261119-daily.db';
const MANAGED_PRE = 'dork-auto-20261118-090000-pre-0043_more_notes.db';

describe('listBackupCopies', () => {
  it('lists every writer-named copy, newest first, with kind, management and total size', () => {
    for (const name of [OLDER_DAILY, OLDER_PRE, MANAGED_DAILY, MANAGED_PRE])
      sqliteCopy(path.join(dir, name));
    const { copies, totalBytes } = listBackupCopies(dir);

    expect(copies.map((c) => [c.name, c.kind, c.managed])).toEqual([
      [MANAGED_DAILY, 'daily', true],
      [MANAGED_PRE, 'pre-upgrade', true],
      [OLDER_DAILY, 'daily', false],
      [OLDER_PRE, 'pre-upgrade', false],
    ]);
    expect(copies[2]?.createdAt).toBe('2026-09-01T00:00:00.000Z');
    expect(copies[3]?.createdAt).toBe('2026-08-15T10:15:00.000Z');
    expect(totalBytes).toBe(copies.reduce((sum, c) => sum + c.sizeBytes, 0));
    expect(totalBytes).toBeGreaterThan(0);
  });

  it('skips look-alikes, partials, other files and symlinks', () => {
    sqliteCopy(path.join(dir, OLDER_DAILY));
    for (const name of [
      'dork-20260901-daily.db.partial',
      'dork-20261301-daily.db', // no such month
      'dork-20260901-weekly.db',
      'notes.db',
      'store-20260901-101500-pre-v2.db',
    ])
      fs.writeFileSync(path.join(dir, name), 'x');
    sqliteCopy(path.join(elsewhere, 'target.db'));
    fs.symlinkSync(path.join(elsewhere, 'target.db'), path.join(dir, 'dork-20260902-daily.db'));

    expect(listBackupCopies(dir).copies.map((c) => c.name)).toEqual([OLDER_DAILY]);
  });

  it('marks a copy with a write in progress as busy', () => {
    sqliteCopy(path.join(dir, OLDER_DAILY));
    fs.writeFileSync(path.join(dir, `${OLDER_DAILY}-journal`), '');
    expect(listBackupCopies(dir).copies[0]?.busy).toBe(true);
  });

  it('lists nothing for a missing folder or a symlinked one', () => {
    expect(listBackupCopies(path.join(root, 'missing'))).toEqual({ copies: [], totalBytes: 0 });
    sqliteCopy(path.join(elsewhere, OLDER_DAILY));
    const linked = path.join(root, 'linked-backups');
    fs.symlinkSync(elsewhere, linked);
    expect(listBackupCopies(linked)).toEqual({ copies: [], totalBytes: 0 });
  });
});

describe('removeOlderBackupCopy', () => {
  it('removes an older copy', () => {
    sqliteCopy(path.join(dir, OLDER_DAILY));
    expect(removeOlderBackupCopy(dir, OLDER_DAILY)).toBe('removed');
    expect(fs.existsSync(path.join(dir, OLDER_DAILY))).toBe(false);
  });

  it('refuses a copy DorkOS manages', () => {
    sqliteCopy(path.join(dir, MANAGED_DAILY));
    expect(removeOlderBackupCopy(dir, MANAGED_DAILY)).toBe('managed');
    expect(fs.existsSync(path.join(dir, MANAGED_DAILY))).toBe(true);
  });

  it('never follows a symlink, and never leaves the folder', () => {
    sqliteCopy(path.join(elsewhere, 'target.db'));
    fs.symlinkSync(path.join(elsewhere, 'target.db'), path.join(dir, OLDER_DAILY));
    expect(removeOlderBackupCopy(dir, OLDER_DAILY)).toBe('not_found');
    expect(fs.existsSync(path.join(elsewhere, 'target.db'))).toBe(true);
    for (const name of ['../elsewhere/target.db', 'dork-20260901-daily.db/../x', 'notes.db'])
      expect(removeOlderBackupCopy(dir, name)).toBe('not_found');
    expect(fs.existsSync(path.join(elsewhere, 'target.db'))).toBe(true);
  });

  it('refuses inside a symlinked backup folder', () => {
    sqliteCopy(path.join(elsewhere, OLDER_DAILY));
    const linked = path.join(root, 'linked-backups');
    fs.symlinkSync(elsewhere, linked);
    expect(removeOlderBackupCopy(linked, OLDER_DAILY)).toBe('not_found');
    expect(fs.existsSync(path.join(elsewhere, OLDER_DAILY))).toBe(true);
  });

  it('leaves a busy copy alone', () => {
    sqliteCopy(path.join(dir, OLDER_DAILY));
    fs.writeFileSync(path.join(dir, `${OLDER_DAILY}-wal`), '');
    expect(removeOlderBackupCopy(dir, OLDER_DAILY)).toBe('busy');
    expect(fs.existsSync(path.join(dir, OLDER_DAILY))).toBe(true);
  });
});

describe('moveOlderBackupCopy', () => {
  it('copies, checks, then removes the original', async () => {
    sqliteCopy(path.join(dir, OLDER_PRE));
    const before = fs.readFileSync(path.join(dir, OLDER_PRE));
    const result = await moveOlderBackupCopy(dir, OLDER_PRE, elsewhere);

    expect(result).toEqual({ status: 'moved', destinationPath: path.join(elsewhere, OLDER_PRE) });
    expect(fs.existsSync(path.join(dir, OLDER_PRE))).toBe(false);
    expect(fs.readFileSync(path.join(elsewhere, OLDER_PRE)).equals(before)).toBe(true);
  });

  it('keeps the original when the copy fails its integrity check', async () => {
    fs.writeFileSync(path.join(dir, OLDER_DAILY), 'not a database at all');
    expect(await moveOlderBackupCopy(dir, OLDER_DAILY, elsewhere)).toEqual({
      status: 'verify_failed',
    });
    expect(fs.existsSync(path.join(dir, OLDER_DAILY))).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, OLDER_DAILY))).toBe(false);
  });

  it('a copy that cannot be written leaves nothing behind and keeps the original', async () => {
    sqliteCopy(path.join(dir, OLDER_DAILY));
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked, { mode: 0o555 });
    try {
      expect(await moveOlderBackupCopy(dir, OLDER_DAILY, locked)).toEqual({
        status: 'destination_not_writable',
      });
      expect(fs.readdirSync(locked)).toEqual([]);
      expect(fs.existsSync(path.join(dir, OLDER_DAILY))).toBe(true);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it('never overwrites a file already in the destination', async () => {
    sqliteCopy(path.join(dir, OLDER_DAILY));
    fs.writeFileSync(path.join(elsewhere, OLDER_DAILY), 'theirs');
    expect(await moveOlderBackupCopy(dir, OLDER_DAILY, elsewhere)).toEqual({
      status: 'destination_exists',
    });
    expect(fs.readFileSync(path.join(elsewhere, OLDER_DAILY), 'utf8')).toBe('theirs');
    expect(fs.existsSync(path.join(dir, OLDER_DAILY))).toBe(true);
  });

  it('refuses a managed copy, a missing destination and the backup folder itself', async () => {
    sqliteCopy(path.join(dir, MANAGED_DAILY));
    sqliteCopy(path.join(dir, OLDER_DAILY));
    expect((await moveOlderBackupCopy(dir, MANAGED_DAILY, elsewhere)).status).toBe('managed');
    expect((await moveOlderBackupCopy(dir, OLDER_DAILY, path.join(root, 'nope'))).status).toBe(
      'destination_invalid'
    );
    expect((await moveOlderBackupCopy(dir, OLDER_DAILY, 'relative/folder')).status).toBe(
      'destination_invalid'
    );
    expect((await moveOlderBackupCopy(dir, OLDER_DAILY, dir)).status).toBe(
      'destination_is_backups'
    );
    expect(fs.existsSync(path.join(dir, OLDER_DAILY))).toBe(true);
  });

  it('never moves a symlinked entry', async () => {
    sqliteCopy(path.join(elsewhere, 'target.db'));
    fs.symlinkSync(path.join(elsewhere, 'target.db'), path.join(dir, OLDER_DAILY));
    const out = path.join(root, 'out');
    fs.mkdirSync(out);
    expect((await moveOlderBackupCopy(dir, OLDER_DAILY, out)).status).toBe('not_found');
    expect(fs.readdirSync(out)).toEqual([]);
  });
});
