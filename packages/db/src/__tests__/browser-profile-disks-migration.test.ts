import { afterEach, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  authors,
  browserProfiles,
  browserInstances,
  browserProfileDisks,
  createDb,
  runMigrations,
  type Db,
} from '../index.js';
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const handles: Db[] = [],
  homes: string[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
it('upgrades the original pre-disk journal without assigning legacy profiles a disk or changing ownership', () => {
  const journal = JSON.parse(readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  const position = journal.entries.findIndex((entry) =>
    /CREATE TABLE [`"]browser_profile_disks[`"]/.test(
      readFileSync(path.join(directory, `${entry.tag}.sql`), 'utf8')
    )
  );
  expect(position).toBeGreaterThan(0);
  expect(journal.entries[position].when).toBeGreaterThan(journal.entries[position - 1].when);
  const home = mkdtempSync(path.join(os.tmpdir(), 'browser-disk-upgrade-'));
  homes.push(home);
  const prior = path.join(home, 'prior');
  mkdirSync(path.join(prior, 'meta'), { recursive: true });
  const earlier = { ...journal, entries: journal.entries.slice(0, position) };
  writeFileSync(path.join(prior, 'meta/_journal.json'), JSON.stringify(earlier));
  for (const entry of earlier.entries)
    copyFileSync(path.join(directory, `${entry.tag}.sql`), path.join(prior, `${entry.tag}.sql`));
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
  db.insert(browserProfiles)
    .values({
      profileId: 'P'.repeat(22),
      ownerAuthorId: 'alice',
      label: 'Legacy',
      mode: 'persistent',
      metadataVersion: 1,
      revision: 3,
      status: 'inUse',
      importState: 'none',
      createdAt: at,
      updatedAt: at,
    })
    .run();
  db.insert(browserInstances)
    .values({
      browserId: 'B'.repeat(22),
      ownerAuthorId: 'alice',
      profileId: 'P'.repeat(22),
      mode: 'persistent',
      browserGeneration: 2,
      revision: 1,
      metadataVersion: 1,
      status: 'uncertain',
      bootId: 'old',
      createdAt: at,
      updatedAt: at,
    })
    .run();
  const profiles = db.select().from(browserProfiles).all(),
    instances = db.select().from(browserInstances).all();
  runMigrations(db);
  runMigrations(db);
  expect(db.select().from(browserProfiles).all()).toEqual(profiles);
  expect(db.select().from(browserInstances).all()).toEqual(instances);
  expect(db.select().from(browserProfileDisks).all()).toEqual([]);
  const disk = {
    profileId: 'P'.repeat(22),
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
  expect(() =>
    db
      .insert(browserProfileDisks)
      .values({ ...disk, generation: '../invalid' })
      .run()
  ).toThrow(/CHECK/);
  expect(() =>
    db
      .insert(browserProfileDisks)
      .values({ ...disk, formatVersion: 2 })
      .run()
  ).toThrow(/CHECK/);
  db.insert(browserProfileDisks).values(disk).run();
  expect(() => db.delete(browserProfiles).run()).toThrow(/FOREIGN KEY/);
});
