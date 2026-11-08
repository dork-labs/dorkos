/**
 * No database snapshot keeps recorded turn text (DOR-4001): both kinds of
 * `dork.db` snapshot come out with the text gone, byte for byte, and the
 * hashes, sizes and token counts still there.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../index.js';
import { snapshotDaily, snapshotSqlite } from '../backup.js';
import { scrubSnapshot } from '../snapshot-scrub.js';

/** Made-up memory, long enough to find in raw file bytes. */
const SECRET_TEXT = 'Made-up memory: the launch moved to Tuesday, and oat milk only.';
const HASH = 'a'.repeat(64);

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snapshot-scrub-'));
  db = createDb(join(dir, 'dork.db'));
  runMigrations(db);
  const created = '2026-11-08T00:00:00.000Z';
  db.$client
    .prepare('INSERT INTO turn_context_bodies (hash, body, created_at) VALUES (?, ?, ?)')
    .run(HASH, SECRET_TEXT, created);
  db.$client
    .prepare(
      `INSERT INTO turn_contexts (id, session_id, runtime, place, system_sent_this_turn, created_at)
       VALUES ('t1', 's1', 'claude-code', 'chat', 1, ?)`
    )
    .run(created);
  db.$client
    .prepare(
      `INSERT INTO turn_context_parts (turn_context_id, position, slot, body_hash, bytes, tokens_estimate, redacted)
       VALUES ('t1', 0, 'prompt', ?, 64, 16, 0)`
    )
    .run(HASH);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

/** What a snapshot file holds of the record, read straight from it. */
function readSnapshot(file: string): { bodies: number; parts: unknown[]; rawHasText: boolean } {
  const copy = new Database(file, { readonly: true });
  try {
    return {
      bodies: (copy.prepare('SELECT count(*) AS n FROM turn_context_bodies').get() as { n: number })
        .n,
      parts: copy.prepare('SELECT body_hash, bytes, tokens_estimate FROM turn_context_parts').all(),
      rawHasText: readFileSync(file).includes(Buffer.from('oat milk only')),
    };
  } finally {
    copy.close();
  }
}

describe('snapshots keep no recorded turn text', () => {
  it('the live database holds the text (so the checks below can see it go)', () => {
    db.$client.pragma('wal_checkpoint(TRUNCATE)');
    expect(readFileSync(join(dir, 'dork.db')).includes(Buffer.from('oat milk only'))).toBe(true);
  });

  it('a pre-migration snapshot (VACUUM INTO) comes out empty of text, counts kept', () => {
    const file = join(dir, 'backups', 'dork-20261108-000000-pre-x.db');
    snapshotSqlite(db.$client, file);
    expect(readSnapshot(file)).toEqual({
      bodies: 0,
      parts: [{ body_hash: HASH, bytes: 64, tokens_estimate: 16 }],
      rawHasText: false,
    });
  });

  it('a daily snapshot (online backup) comes out empty of text, counts kept', async () => {
    const written = await snapshotDaily(db, {
      dir: join(dir, 'backups'),
      now: new Date('2026-11-08T12:00:00Z'),
    });
    expect(readSnapshot(written!)).toEqual({
      bodies: 0,
      parts: [{ body_hash: HASH, bytes: 64, tokens_estimate: 16 }],
      rawHasText: false,
    });
  });

  it('leaves the live database untouched', () => {
    snapshotSqlite(db.$client, join(dir, 'backups', 'one.db'));
    expect(
      db.$client.prepare('SELECT body FROM turn_context_bodies').get() as { body: string }
    ).toEqual({ body: SECRET_TEXT });
  });

  it('leaves a snapshot with no such table exactly as it was', () => {
    const other = new Database(join(dir, 'store.db'));
    other.exec("CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('kept')");
    other.close();
    scrubSnapshot(join(dir, 'store.db'));
    const reopened = new Database(join(dir, 'store.db'), { readonly: true });
    expect(reopened.prepare('SELECT text FROM notes').all()).toEqual([{ text: 'kept' }]);
    reopened.close();
  });
});

describe('nothing around a snapshot keeps the text either', () => {
  it('leaves no WAL or journal beside it, and no free pages inside it', async () => {
    const pre = join(dir, 'backups', 'dork-20261108-000000-pre-x.db');
    snapshotSqlite(db.$client, pre);
    const daily = (await snapshotDaily(db, {
      dir: join(dir, 'backups'),
      now: new Date('2026-11-08T12:00:00Z'),
    }))!;
    for (const file of [pre, daily]) {
      for (const sidecar of ['-wal', '-shm', '-journal', '.partial']) {
        expect(existsSync(`${file}${sidecar}`), `${file}${sidecar}`).toBe(false);
      }
      const copy = new Database(file, { readonly: true });
      try {
        expect(copy.pragma('freelist_count', { simple: true })).toBe(0);
        expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
      } finally {
        copy.close();
      }
    }
  });

  it('removes a copy a process died while emptying, before writing the next snapshot', async () => {
    const backups = join(dir, 'backups');
    snapshotSqlite(db.$client, join(backups, 'first.db'));
    // What a process killed between the copy and the scrub would leave: a
    // `.partial` that still holds the text, and its journal.
    const stale = join(backups, 'dork-20261101-000000-pre-y.db.partial');
    writeFileSync(stale, readFileSync(join(dir, 'dork.db')));
    writeFileSync(`${stale}-journal`, 'made-up journal');

    await snapshotDaily(db, { dir: backups, now: new Date('2026-11-08T12:00:00Z') });
    expect(readdirSync(backups).filter((name) => name.includes('.partial'))).toEqual([]);

    writeFileSync(stale, readFileSync(join(dir, 'dork.db')));
    snapshotSqlite(db.$client, join(backups, 'second.db'));
    expect(readdirSync(backups).filter((name) => name.includes('.partial'))).toEqual([]);
    for (const name of readdirSync(backups)) {
      expect(readFileSync(join(backups, name)).includes(Buffer.from('oat milk only')), name).toBe(
        false
      );
    }
  });

  it('still refuses to write over an existing snapshot, and leaves it alone', () => {
    const file = join(dir, 'backups', 'taken.db');
    snapshotSqlite(db.$client, file);
    const before = readFileSync(file);
    expect(() => snapshotSqlite(db.$client, file)).toThrow(/already exists/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});
