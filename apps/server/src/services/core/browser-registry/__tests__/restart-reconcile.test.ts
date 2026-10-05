import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authors,
  browserAttachments,
  browserInstances,
  browserProfiles,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { quarantineBrowserRegistryAfterRestart } from '../restart-reconcile.js';

const handles: Db[] = [],
  directories: string[] = [];
const id = (letter: string) => letter.repeat(22);
const stamp = '2026-10-03T00:00:00.000Z';
afterEach(() => {
  for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function open(filename: string) {
  const db = createDb(filename);
  handles.push(db);
  runMigrations(db);
  return db;
}
function seed(db: Db) {
  db.insert(authors)
    .values({
      id: 'human-owner',
      kind: 'human',
      naturalKey: 'local',
      displayName: 'Owner',
      createdAt: stamp,
    })
    .run();
  db.insert(browserProfiles)
    .values([
      {
        profileId: id('p'),
        ownerAuthorId: 'human-owner',
        label: 'Reserved',
        mode: 'persistent',
        metadataVersion: 1,
        revision: 1,
        status: 'inUse',
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        profileId: id('u'),
        ownerAuthorId: 'human-owner',
        label: 'Unused',
        mode: 'persistent',
        metadataVersion: 1,
        revision: 0,
        status: 'available',
        createdAt: stamp,
        updatedAt: stamp,
      },
    ])
    .run();
  db.insert(browserInstances)
    .values([
      {
        browserId: id('b'),
        ownerAuthorId: 'human-owner',
        profileId: id('p'),
        mode: 'persistent',
        browserGeneration: 7,
        revision: 3,
        metadataVersion: 1,
        status: 'running',
        bootId: id('o'),
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        browserId: id('e'),
        ownerAuthorId: 'human-owner',
        profileId: null,
        mode: 'ephemeral',
        browserGeneration: 1,
        revision: 0,
        metadataVersion: 1,
        status: 'opening',
        bootId: id('o'),
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        browserId: id('t'),
        ownerAuthorId: 'human-owner',
        profileId: null,
        mode: 'ephemeral',
        browserGeneration: 2,
        revision: 0,
        metadataVersion: 1,
        status: 'stopping',
        bootId: id('o'),
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        browserId: id('s'),
        ownerAuthorId: 'human-owner',
        profileId: null,
        mode: 'ephemeral',
        browserGeneration: 0,
        revision: 0,
        metadataVersion: 1,
        status: 'stopped',
        bootId: id('o'),
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        browserId: id('c'),
        ownerAuthorId: 'human-owner',
        profileId: null,
        mode: 'ephemeral',
        browserGeneration: 0,
        revision: 0,
        metadataVersion: 1,
        status: 'opening',
        bootId: id('n'),
        createdAt: stamp,
        updatedAt: stamp,
      },
    ])
    .run();
  db.insert(browserAttachments)
    .values({
      attachmentId: id('a'),
      ownerAuthorId: 'human-owner',
      browserId: id('b'),
      browserGeneration: 7,
      revision: 0,
      kind: 'session',
      sessionId: id('z'),
      roomId: null,
      attachedAt: stamp,
      detachedAt: null,
    })
    .run();
}

describe('restart quarantine on real SQLite', () => {
  it('reopens disk metadata as uncertain, never rebinds old identities, and preserves unused profiles', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'dorkos-browser-restart-'));
    directories.push(directory);
    const filename = path.join(directory, 'registry.db');
    const first = open(filename);
    seed(first);
    first.$client.close();
    const db = open(filename);
    expect(quarantineBrowserRegistryAfterRestart(db, id('n'))).toEqual({ quarantinedInstances: 3 });
    for (const browserId of [id('b'), id('e'), id('t')])
      expect(
        db.select().from(browserInstances).where(eq(browserInstances.browserId, browserId)).get()
          ?.status
      ).toBe('uncertain');
    expect(
      db
        .select()
        .from(browserInstances)
        .where(eq(browserInstances.browserId, id('b')))
        .get()
    ).toMatchObject({ browserGeneration: 7, bootId: id('o'), revision: 4 });
    expect(
      db
        .select()
        .from(browserProfiles)
        .where(eq(browserProfiles.profileId, id('p')))
        .get()
    ).toMatchObject({ status: 'quarantined', revision: 2 });
    expect(
      db
        .select()
        .from(browserProfiles)
        .where(eq(browserProfiles.profileId, id('u')))
        .get()
    ).toMatchObject({ status: 'available', revision: 0 });
    expect(
      db
        .select()
        .from(browserInstances)
        .where(eq(browserInstances.browserId, id('s')))
        .get()
    ).toMatchObject({ status: 'stopped', revision: 0 });
    expect(
      db
        .select()
        .from(browserInstances)
        .where(eq(browserInstances.browserId, id('c')))
        .get()
    ).toMatchObject({ status: 'opening', revision: 0 });
    expect(db.select().from(browserAttachments).get()).toMatchObject({
      browserId: id('b'),
      browserGeneration: 7,
      revision: 1,
    });
    expect(db.select().from(browserAttachments).get()?.detachedAt).not.toBeNull();
    expect(db.select().from(browserInstances).all()).toHaveLength(5);
    const before = db.select().from(browserInstances).all();
    expect(quarantineBrowserRegistryAfterRestart(db, id('n'))).toEqual({ quarantinedInstances: 0 });
    expect(db.select().from(browserInstances).all()).toEqual(before);
    expect(
      db
        .select()
        .from(browserProfiles)
        .where(eq(browserProfiles.profileId, id('p')))
        .get()?.status
    ).toBe('quarantined');
    expect(db.select().from(browserAttachments).get()?.revision).toBe(1);
  });
  it('rolls back the complete fence when a revision cannot advance', () => {
    const db = open(':memory:');
    seed(db);
    db.update(browserInstances)
      .set({ revision: Number.MAX_SAFE_INTEGER })
      .where(eq(browserInstances.browserId, id('t')))
      .run();
    const instances = db.select().from(browserInstances).all(),
      profiles = db.select().from(browserProfiles).all();
    expect(() => quarantineBrowserRegistryAfterRestart(db, id('n'))).toThrow();
    expect(db.select().from(browserInstances).all()).toEqual(instances);
    expect(db.select().from(browserProfiles).all()).toEqual(profiles);
    expect(db.select().from(browserAttachments).get()?.detachedAt).toBeNull();
  });
  it('quarantines previously uncertain profiles without healing or repeatedly advancing them', () => {
    const db = open(':memory:');
    seed(db);
    db.update(browserInstances)
      .set({ status: 'uncertain' })
      .where(eq(browserInstances.browserId, id('b')))
      .run();
    quarantineBrowserRegistryAfterRestart(db, id('n'));
    expect(
      db
        .select()
        .from(browserInstances)
        .where(eq(browserInstances.browserId, id('b')))
        .get()?.revision
    ).toBe(3);
    expect(
      db
        .select()
        .from(browserProfiles)
        .where(eq(browserProfiles.profileId, id('p')))
        .get()?.status
    ).toBe('quarantined');
    quarantineBrowserRegistryAfterRestart(db, id('n'));
    expect(
      db
        .select()
        .from(browserProfiles)
        .where(eq(browserProfiles.profileId, id('p')))
        .get()?.revision
    ).toBe(2);
  });
});
