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
  it('upgrades referenced pre-import profiles through the actual journal with foreign keys on and preserves them across restart', () => {
    const journal = JSON.parse(
      readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
    ) as {
      entries: { idx: number; tag: string }[];
    };
    const position = journal.entries.findIndex((entry) =>
      /ALTER TABLE [`"]?browser_profiles[`"]? ADD [`"]?import_state[`"]?/u.test(
        readFileSync(path.join(directory, `${entry.tag}.sql`), 'utf8')
      )
    );
    expect(position).toBeGreaterThan(0);
    const folder = mkdtempSync(path.join(os.tmpdir(), 'dorkos-browser-import-upgrade-'));
    temporary.push(folder);
    const prior = path.join(folder, 'prior');
    mkdirSync(path.join(prior, 'meta'), { recursive: true });
    const earlier = { ...journal, entries: journal.entries.slice(0, position) };
    writeFileSync(path.join(prior, 'meta/_journal.json'), JSON.stringify(earlier));
    for (const entry of earlier.entries)
      copyFileSync(path.join(directory, `${entry.tag}.sql`), path.join(prior, `${entry.tag}.sql`));
    const file = path.join(folder, 'registry.db');
    const db = createDb(file);
    handles.push(db);
    migrate(db, { migrationsFolder: prior });
    seedAuthors(db);
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
    const sql = db.$client;
    const insertProfile = sql.prepare(`INSERT INTO browser_profiles
      (profile_id,owner_author_id,label,mode,metadata_version,revision,status,created_at,updated_at)
      VALUES (?,?,?,'persistent',1,?,?,?,?)`);
    const insertInstance = sql.prepare(`INSERT INTO browser_instances
      (browser_id,owner_author_id,profile_id,mode,browser_generation,revision,metadata_version,status,boot_id,created_at,updated_at)
      VALUES (?,?,?,'persistent',?, ?,1,?,'old-boot',?,?)`);
    const insertAttachment = sql.prepare(`INSERT INTO browser_attachments
      (attachment_id,owner_author_id,browser_id,browser_generation,revision,kind,session_id,room_id,attached_at,detached_at)
      VALUES (?,?,?,?,?,'session',?,NULL,?,?)`);
    for (const [index, status] of ['stopped', 'opening', 'uncertain'].entries()) {
      const id = `profile-${index}`;
      insertProfile.run(
        id,
        'a',
        `Existing ${status}`,
        index + 2,
        status === 'stopped' ? 'available' : status === 'opening' ? 'inUse' : 'quarantined',
        stamp,
        stamp
      );
      insertInstance.run(`browser-${index}`, 'a', id, index + 3, index + 4, status, stamp, stamp);
      insertAttachment.run(
        `attachment-${index}`,
        'a',
        `browser-${index}`,
        index + 3,
        index + 5,
        `runtime-session-${index}`,
        stamp,
        index === 0 ? stamp : null
      );
    }
    const snapshot = () =>
      Object.fromEntries(
        ['authors', 'browser_profiles', 'browser_instances', 'browser_attachments'].map((table) => [
          table,
          sql.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
        ])
      );
    const before = snapshot();
    const foreignKeys = () =>
      Object.fromEntries(
        ['browser_profiles', 'browser_instances', 'browser_attachments'].map((table) => [
          table,
          sql.prepare(`PRAGMA foreign_key_list(${table})`).all(),
        ])
      );
    const beforeKeys = foreignKeys();
    const indices = () =>
      sql
        .prepare(
          `SELECT name,sql FROM sqlite_master
      WHERE type='index' AND tbl_name IN ('browser_profiles','browser_instances','browser_attachments')
      ORDER BY name`
        )
        .all();
    const beforeIndices = indices();
    // With populated child references, a table rebuild inside Drizzle's transaction
    // must not rely on an ignored PRAGMA foreign_keys=OFF.
    runMigrations(db);
    runMigrations(db);
    const after = snapshot();
    expect(after).toEqual({
      ...before,
      browser_profiles: (before.browser_profiles as Record<string, unknown>[]).map((row) => ({
        ...row,
        import_state: 'none',
      })),
    });
    expect(foreignKeys()).toEqual(beforeKeys);
    expect(indices()).toEqual(beforeIndices);
    expect(sql.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() =>
      sql.prepare("DELETE FROM browser_profiles WHERE profile_id='profile-0'").run()
    ).toThrow();
    expect(() => sql.prepare("DELETE FROM authors WHERE id='a'").run()).toThrow();
    expect(() =>
      sql
        .prepare("UPDATE browser_instances SET owner_author_id='b' WHERE browser_id='browser-1'")
        .run()
    ).toThrow();
    expect(() =>
      sql
        .prepare(
          "UPDATE browser_attachments SET browser_generation=999 WHERE attachment_id='attachment-1'"
        )
        .run()
    ).toThrow();
    expect(() =>
      sql.prepare("UPDATE browser_profiles SET import_state='invented'").run()
    ).toThrow();
    expect(() => sql.prepare('UPDATE browser_profiles SET revision=-1').run()).toThrow();
    expect(() => sql.prepare("UPDATE browser_profiles SET status='invented'").run()).toThrow();
    expect(() =>
      sql
        .prepare(
          `INSERT INTO browser_instances SELECT 'duplicate',owner_author_id,profile_id,mode,
      browser_generation+1,revision,metadata_version,'opening',boot_id,created_at,updated_at
      FROM browser_instances WHERE browser_id='browser-1'`
        )
        .run()
    ).toThrow();
    const durable = snapshot();
    sql.close();
    const reopened = createDb(file);
    handles.push(reopened);
    runMigrations(reopened);
    expect(reopened.$client.pragma('foreign_keys', { simple: true })).toBe(1);
    for (const [table, rows] of Object.entries(durable))
      expect(reopened.$client.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).toEqual(rows);
    expect(reopened.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // Real durable transitions preserve history and detachments; stopping an original
    // reservation permits a later generation without deleting the referenced profile.
    reopened.$client
      .prepare(
        "UPDATE browser_instances SET status='stopped',revision=revision+1 WHERE browser_id='browser-1'"
      )
      .run();
    reopened.$client
      .prepare(
        `INSERT INTO browser_instances SELECT 'successor',owner_author_id,profile_id,mode,
      browser_generation+1,0,metadata_version,'opening','new-boot',created_at,updated_at
      FROM browser_instances WHERE browser_id='browser-1'`
      )
      .run();
    expect(
      reopened.$client
        .prepare("SELECT status FROM browser_instances WHERE browser_id='browser-1'")
        .get()
    ).toEqual({ status: 'stopped' });
    expect(
      reopened.$client
        .prepare("SELECT boot_id FROM browser_instances WHERE browser_id='successor'")
        .get()
    ).toEqual({ boot_id: 'new-boot' });
    expect(
      reopened.$client.prepare('SELECT COUNT(*) AS count FROM browser_attachments').get()
    ).toEqual({ count: 3 });
    expect(reopened.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

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
    expect(db.select().from(browserProfiles).get()?.importState).toBe('none');
    expect(() =>
      db.$client.prepare("UPDATE browser_profiles SET import_state='invented'").run()
    ).toThrow();
    const columns = db.$client.prepare('PRAGMA table_info(browser_profiles)').all() as {
      name: string;
    }[];
    expect(columns.map((row) => row.name).sort()).toEqual([
      'created_at',
      'import_state',
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
