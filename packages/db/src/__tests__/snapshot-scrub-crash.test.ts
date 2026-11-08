/**
 * A process killed in the middle of emptying a snapshot (DOR-4001, Security
 * M1 on #3569): a real child process takes a real snapshot of each kind and is
 * SIGKILLed after the scrub's DELETE has run but before it commits, leaving a
 * hot journal that would roll the text back. Nothing at a snapshot's name may
 * hold the text, then or after, and the next boot's sweep removes the rest.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../index.js';
import { snapshotBeforeMigrations, snapshotDaily } from '../backup.js';

const MARKER = 'made-up-marker-oat-milk-only';
const PACKAGE = resolve(__dirname, '../..');
const TSX = resolve(PACKAGE, '../../node_modules/.bin/tsx');
/** Any file a snapshot is kept under: what a restore, or a person, would trust. */
const SNAPSHOT_NAME = /^(?:dork-\d{8}-\d{6}-pre-.+|dork-\d{8}-daily)\.db$/;

/** The child: take one snapshot, and die the instant the scrub's DELETE has run uncommitted. */
const CHILD = `
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(PACKAGE, 'src/backup.ts'))});
const Database = require('better-sqlite3');
const exec = Database.prototype.exec;
Database.prototype.exec = function (sql) {
  if (/^DELETE FROM turn_context_bodies/.test(sql)) {
    exec.call(this, 'BEGIN');
    exec.call(this, sql);
    process.kill(process.pid, 'SIGKILL');
  }
  return exec.call(this, sql);
};
const [kind, src, dir] = process.argv.slice(2);
const backup = await import(${JSON.stringify(join(PACKAGE, 'src/backup.ts'))});
const sqlite = new Database(src);
if (kind === 'pre') backup.snapshotSqlite(sqlite, dir + '/dork-20261108-000000-pre-x.db');
else await backup.snapshotSqliteInSteps(sqlite, dir + '/dork-20261108-daily.db');
console.log('survived');
`;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snapshot-scrub-crash-'));
  db = createDb(join(dir, 'dork.db'));
  runMigrations(db);
  const insert = db.$client.prepare(
    'INSERT INTO turn_context_bodies (hash, body, created_at) VALUES (?, ?, ?)'
  );
  for (let i = 0; i < 50; i++) insert.run(`h${i}`, `${MARKER} ${i}`, '2026-11-08T00:00:00.000Z');
  db.$client.pragma('wal_checkpoint(TRUNCATE)');
  writeFileSync(join(dir, 'child.mts'), CHILD);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Which files in the folder hold the marker in their raw bytes. */
function holdingMarker(folder: string): string[] {
  return readdirSync(folder).filter((name) =>
    readFileSync(join(folder, name)).includes(Buffer.from(MARKER))
  );
}

describe.each(['pre', 'daily'])('a %s snapshot killed mid-scrub', (kind) => {
  it('leaves no snapshot-named file holding the text, and the next boot removes the rest', async () => {
    const backups = join(dir, 'backups');
    const child = spawnSync(TSX, [join(dir, 'child.mts'), kind, join(dir, 'dork.db'), backups], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    // It really died mid-scrub, not after. Through the tsx wrapper a SIGKILLed
    // child shows as exit 137 (128 + 9); run bare it shows as the signal.
    expect(child.signal === 'SIGKILL' || child.status === 137, child.stderr).toBe(true);
    expect(child.stdout).not.toContain('survived');

    const left = readdirSync(backups);
    expect(left.some((name) => name.endsWith('.partial'))).toBe(true);
    expect(left.filter((name) => SNAPSHOT_NAME.test(name))).toEqual([]);

    // The next boot: the pre-migration check runs, then the day's snapshot.
    snapshotBeforeMigrations(db, { dir: backups });
    await snapshotDaily(db, { dir: backups, now: new Date('2026-11-09T12:00:00Z') });

    expect(readdirSync(backups).filter((name) => name.includes('.partial'))).toEqual([]);
    expect(holdingMarker(backups)).toEqual([]);
  });
});
