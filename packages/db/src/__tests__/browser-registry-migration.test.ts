import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  authors,
  browserProfiles,
  browserInstances,
  browserAttachments,
  createDb,
  runMigrations,
  type Db,
} from '../index.js';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const handles: Db[] = [],
  temporary: string[] = [];
const stamp = '2026-10-03T00:00:00.000Z';
afterEach(() => {
  for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
  for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function open() {
  const db = createDb(':memory:');
  handles.push(db);
  return db;
}
function seedAuthors(db: Db) {
  db.insert(authors)
    .values(
      ['a', 'b'].map((id) => ({
        id,
        kind: 'human',
        naturalKey: `user:${id}`,
        displayName: id,
        createdAt: stamp,
      }))
    )
    .run();
}
function profile(profileId = 'profile', ownerAuthorId = 'a') {
  return {
    profileId,
    ownerAuthorId,
    label: 'Named',
    mode: 'persistent' as const,
    metadataVersion: 1,
    revision: 0,
    status: 'available' as const,
    createdAt: stamp,
    updatedAt: stamp,
  };
}
function instance(browserId = 'browser') {
  return {
    browserId,
    ownerAuthorId: 'a',
    profileId: 'profile',
    mode: 'persistent' as const,
    browserGeneration: 1,
    revision: 0,
    metadataVersion: 1,
    status: 'opening' as const,
    bootId: 'old-boot',
    createdAt: stamp,
    updatedAt: stamp,
  };
}

describe('browser registry migration on real SQLite', () => {
  it('upgrades the actual prior journal, preserves author rows and applies idempotently', () => {
    const journal = JSON.parse(
      readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
    ) as { entries: { idx: number; tag: string }[] };
    // Locate the real allocated migration by its DDL, never invent its index or filename.
    const position = journal.entries.findIndex((entry) =>
      /CREATE TABLE [`"]?browser_profiles[`"]?/u.test(
        readFileSync(path.join(directory, `${entry.tag}.sql`), 'utf8')
      )
    );
    expect(position).toBeGreaterThan(0);
    const folder = mkdtempSync(path.join(os.tmpdir(), 'dorkos-browser-migration-'));
    temporary.push(folder);
    mkdirSync(path.join(folder, 'meta'));
    const earlier = { ...journal, entries: journal.entries.slice(0, position) };
    writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify(earlier));
    for (const entry of earlier.entries)
      copyFileSync(path.join(directory, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
    const db = open();
    migrate(db, { migrationsFolder: folder });
    seedAuthors(db);
    expect(
      db.$client.prepare("SELECT name FROM sqlite_master WHERE name='browser_profiles'").all()
    ).toEqual([]);
    runMigrations(db);
    runMigrations(db);
    expect(db.select().from(authors).all()).toHaveLength(2);
    db.insert(browserProfiles).values(profile()).run();
    expect(db.select().from(browserProfiles).get()?.label).toBe('Named');
    const columns = db.$client.prepare('PRAGMA table_info(browser_profiles)').all() as {
      name: string;
    }[];
    expect(columns.map((row) => row.name).sort()).toEqual([
      'created_at',
      'label',
      'metadata_version',
      'mode',
      'owner_author_id',
      'profile_id',
      'revision',
      'status',
      'updated_at',
    ]);
  });
  it('enforces owner-qualified foreign keys, reservation exclusivity and bounded counters', () => {
    const db = open();
    runMigrations(db);
    seedAuthors(db);
    db.insert(browserProfiles).values(profile()).run();
    expect(() =>
      db
        .insert(browserInstances)
        .values({ ...instance(), ownerAuthorId: 'b' })
        .run()
    ).toThrow();
    expect(() =>
      db
        .insert(browserProfiles)
        .values({ ...profile('missing'), ownerAuthorId: 'absent' })
        .run()
    ).toThrow();
    expect(() =>
      db
        .insert(browserInstances)
        .values({ ...instance(), mode: 'ephemeral' })
        .run()
    ).toThrow();
    expect(() =>
      db
        .insert(browserProfiles)
        .values({ ...profile('bad'), revision: -1 })
        .run()
    ).toThrow();
    expect(() =>
      db
        .insert(browserProfiles)
        .values({ ...profile('fraction'), revision: 0.5 })
        .run()
    ).toThrow();
    db.insert(browserInstances).values(instance()).run();
    expect(() => db.insert(browserInstances).values(instance('second')).run()).toThrow();
    db.insert(browserInstances)
      .values({ ...instance('clean'), mode: 'ephemeral', profileId: null })
      .run();
    expect(db.select().from(browserInstances).all()).toHaveLength(2);
  });
  it('allows runtime-owned session references without a settings row and refuses malformed attachments', () => {
    const db = open();
    runMigrations(db);
    seedAuthors(db);
    db.insert(browserProfiles).values(profile()).run();
    db.insert(browserInstances).values(instance()).run();
    const attachment = {
      attachmentId: 'attachment',
      ownerAuthorId: 'a',
      browserId: 'browser',
      browserGeneration: 1,
      revision: 0,
      kind: 'session' as const,
      sessionId: 'runtime-only-session',
      roomId: null,
      attachedAt: stamp,
      detachedAt: null,
    };
    expect(() =>
      db
        .insert(browserAttachments)
        .values({ ...attachment, ownerAuthorId: 'b' })
        .run()
    ).toThrow();
    expect(() =>
      db
        .insert(browserAttachments)
        .values({ ...attachment, sessionId: null })
        .run()
    ).toThrow();
    expect(() =>
      db
        .insert(browserAttachments)
        .values({ ...attachment, browserGeneration: 2 })
        .run()
    ).toThrow();
    db.insert(browserAttachments).values(attachment).run();
    expect(() =>
      db
        .insert(browserAttachments)
        .values({ ...attachment, attachmentId: 'duplicate' })
        .run()
    ).toThrow();
    expect(db.select().from(browserAttachments).get()?.sessionId).toBe('runtime-only-session');
  });
});
