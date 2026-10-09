import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { authors, browserProfileDisks, createDb, runMigrations, type Db } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(here, '../../drizzle');
const fixture = path.join(here, 'fixtures/published-main148');
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const handles: Db[] = [];
const homes: string[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it('upgrades populated shipped main148 without skipping browser import state or losing session touches', () => {
  type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
  const identity = JSON.parse(readFileSync(path.join(fixture, 'identity.json'), 'utf8')) as {
    commonCount: number;
    commonChainSha256: string;
    entry: Entry;
    sqlSha256: string;
  };
  const journal = JSON.parse(readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: Entry[];
  };
  const common = journal.entries.slice(0, identity.commonCount);
  expect(common).toHaveLength(148);
  const chain = common.map((entry) => ({
    entry,
    sha256: sha256(readFileSync(path.join(directory, `${entry.tag}.sql`))),
  }));
  // This pin binds the real published 0..147 chain, rather than whatever chain a repair produces.
  expect(sha256(JSON.stringify(chain))).toBe(identity.commonChainSha256);
  const publishedSql = readFileSync(path.join(fixture, `${identity.entry.tag}.sql`));
  expect(sha256(publishedSql)).toBe(identity.sqlSha256);
  const home = mkdtempSync(path.join(os.tmpdir(), 'browser-main148-upgrade-'));
  homes.push(home);
  const prior = path.join(home, 'prior');
  mkdirSync(path.join(prior, 'meta'), { recursive: true });
  writeFileSync(
    path.join(prior, 'meta/_journal.json'),
    JSON.stringify({
      ...journal,
      entries: [...common, identity.entry],
    })
  );
  for (const entry of common)
    copyFileSync(path.join(directory, `${entry.tag}.sql`), path.join(prior, `${entry.tag}.sql`));
  writeFileSync(path.join(prior, `${identity.entry.tag}.sql`), publishedSql);
  const db = createDb(':memory:');
  handles.push(db);
  migrate(db, { migrationsFolder: prior });
  const at = '2026-10-09T00:00:00.000Z';
  db.insert(authors)
    .values([
      { id: 'alice', kind: 'human', naturalKey: 'user:alice', displayName: 'Alice', createdAt: at },
      { id: 'bob', kind: 'human', naturalKey: 'user:bob', displayName: 'Bob', createdAt: at },
    ])
    .run();
  const profileId = 'P'.repeat(22);
  // The shipped schema has no import_state. Do not use the current typed table to seed it.
  expect(db.$client.pragma('table_info(browser_profiles)')).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'import_state' })])
  );
  db.$client
    .prepare(
      `INSERT INTO browser_profiles
    (profile_id, owner_author_id, label, mode, metadata_version, revision, status, created_at, updated_at)
    VALUES (?, 'alice', 'Retained', 'persistent', 1, 7, 'quarantined', ?, ?)`
    )
    .run(profileId, at, at);
  db.$client
    .prepare('INSERT INTO session_touches (session_id, opened_at, wrote_at) VALUES (?, ?, ?)')
    .run('retained-session', at, '2026-10-09T00:01:00.000Z');
  const profiles = db.$client.prepare('SELECT * FROM browser_profiles').all();
  const authorRows = db.$client.prepare('SELECT * FROM authors ORDER BY id').all();
  const touches = db.$client.prepare('SELECT * FROM session_touches').all();
  const history = db.$client.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
  expect(history).toHaveLength(149);
  expect(history.at(-1)).toEqual(
    expect.objectContaining({
      created_at: identity.entry.when,
      hash: identity.sqlSha256,
    })
  );
  runMigrations(db);
  const migratedHistory = db.$client
    .prepare('SELECT * FROM __drizzle_migrations ORDER BY id')
    .all();
  runMigrations(db);
  expect(db.$client.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()).toEqual(
    migratedHistory
  );
  expect(migratedHistory.slice(0, history.length)).toEqual(history);
  expect(db.$client.prepare('SELECT * FROM browser_profiles').all()).toEqual(
    profiles.map((row) => ({ ...(row as Record<string, unknown>), import_state: 'none' }))
  );
  expect(db.$client.prepare('SELECT * FROM authors ORDER BY id').all()).toEqual(authorRows);
  expect(db.$client.prepare('SELECT * FROM session_touches').all()).toEqual(touches);
  expect(db.$client.pragma('table_info(browser_profiles)')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'import_state', notnull: 1, dflt_value: "'none'" }),
    ])
  );
  expect(journal.entries[148]).toEqual(identity.entry);
  expect(sha256(readFileSync(path.join(directory, `${identity.entry.tag}.sql`)))).toBe(
    identity.sqlSha256
  );
  expect(db.select().from(browserProfileDisks).all()).toEqual([]);
  const disk = {
    profileId,
    ownerAuthorId: 'alice',
    generation: 'G'.repeat(22),
    backend: 'qemu-hvf' as const,
    formatVersion: 1,
    createdAt: at,
  };
  expect(() =>
    db
      .insert(browserProfileDisks)
      .values({ ...disk, ownerAuthorId: 'bob' })
      .run()
  ).toThrow(/FOREIGN KEY/);
  db.insert(browserProfileDisks).values(disk).run();
  expect(db.select().from(browserProfileDisks).all()).toEqual([disk]);
  expect(() =>
    db.$client.prepare('DELETE FROM browser_profiles WHERE profile_id = ?').run(profileId)
  ).toThrow(/FOREIGN KEY/);
  expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  expect(db.$client.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
});
