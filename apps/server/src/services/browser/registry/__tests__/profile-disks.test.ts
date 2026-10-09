import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authors,
  browserProfileDisks,
  browserProfiles,
  createDb,
  runMigrations,
  eq,
  type Db,
} from '@dorkos/db';
import { BrowserRegistryStore } from '../store.js';

const handles: Db[] = [],
  homes: string[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function open(file = ':memory:') {
  const db = createDb(file);
  handles.push(db);
  runMigrations(db);
  db.insert(authors)
    .values(
      ['alice', 'bob'].map((id) => ({
        id,
        kind: 'human',
        naturalKey: `user:${id}`,
        displayName: id,
        createdAt: '2026-10-09T00:00:00.000Z',
      }))
    )
    .onConflictDoNothing()
    .run();
  return db;
}
function birth(store: BrowserRegistryStore, profileId: string, browserId = 'A'.repeat(22)) {
  store.birth('alice', { mode: 'persistent', profileId }, browserId, 0);
  return browserId;
}

it('persists one disk selection across exact re-issuance and a real database/server restart', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'browser-disk-generation-'));
  homes.push(home);
  const file = path.join(home, 'registry.sqlite');
  const db = open(file),
    store = new BrowserRegistryStore(db, 'first');
  const profile = store.createProfile('alice', 'Named');
  const browser = birth(store, profile.profileId);
  const disk = store.reserveProfileDisk('alice', browser, 0);
  expect(disk).toMatchObject({
    profileId: profile.profileId,
    backend: 'qemu-hvf',
    formatVersion: 1,
  });
  expect(disk.generation).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  expect(Object.isFrozen(disk)).toBe(true);
  expect(store.reserveProfileDisk('alice', browser, 0)).toEqual(disk);
  expect(db.select().from(browserProfileDisks).all()).toHaveLength(1);
  // This explicit metadata transition models the existing separately proven original closure.
  // The disk descriptor itself has no closure, recovery, or liveness capability.
  store.transition(store.instance('alice', browser, 0), 'stopped');
  db.$client.close();
  const reopened = open(file),
    restarted = new BrowserRegistryStore(reopened, 'second');
  const next = birth(restarted, profile.profileId, 'B'.repeat(22));
  expect(restarted.reserveProfileDisk('alice', next, 0)).toEqual(disk);
  expect(reopened.select().from(browserProfileDisks).all()).toHaveLength(1);
  expect(Object.keys(restarted.profiles('alice')[0]).sort()).toEqual([
    'label',
    'profileId',
    'revision',
    'status',
  ]);
});

it('refuses foreign owner, unknown or wrong instance generation without creating a row', () => {
  const db = open(),
    store = new BrowserRegistryStore(db, 'boot');
  const profile = store.createProfile('alice', 'Named'),
    browser = birth(store, profile.profileId);
  for (const [owner, id, generation] of [
    ['bob', browser, 0],
    ['alice', 'X'.repeat(22), 0],
    ['alice', browser, 1],
  ] as const)
    expect(() => store.reserveProfileDisk(owner, id, generation)).toThrow('inaccessible');
  expect(db.select().from(browserProfileDisks).all()).toEqual([]);
});

it('does not recover an earlier boot opening reservation or an uncertain profile from metadata', () => {
  const db = open(),
    first = new BrowserRegistryStore(db, 'first');
  const profile = first.createProfile('alice', 'Named'),
    browser = birth(first, profile.profileId);
  const second = new BrowserRegistryStore(db, 'second');
  expect(() => second.reserveProfileDisk('alice', browser, 0)).toThrow('staleBinding');
  first.transition(first.instance('alice', browser, 0), 'uncertain');
  expect(() => first.reserveProfileDisk('alice', browser, 0)).toThrow('staleBinding');
  expect(() => birth(second, profile.profileId, 'B'.repeat(22))).toThrow('profileUncertain');
  expect(db.select().from(browserProfileDisks).all()).toEqual([]);
});

it('requires a busy persistent opening profile and withholds pending/failed import disks', () => {
  const db = open(),
    store = new BrowserRegistryStore(db, 'boot');
  store.birth('alice', { mode: 'ephemeral' }, 'E'.repeat(22), 0);
  expect(() => store.reserveProfileDisk('alice', 'E'.repeat(22), 0)).toThrow('inaccessible');
  const imported = store.beginProfileImport('alice', 'Pending');
  const browser = birth(store, imported.profileId);
  expect(() => store.reserveProfileDisk('alice', browser, 0)).toThrow('profileInUse');
  store.finishProfileImport('alice', imported.profileId, false);
  expect(() => store.reserveProfileDisk('alice', browser, 0)).toThrow('profileUncertain');
  const another = store.createProfile('alice', 'Available');
  const next = birth(store, another.profileId, 'B'.repeat(22));
  db.update(browserProfiles)
    .set({ status: 'available' })
    .where(eq(browserProfiles.profileId, another.profileId))
    .run();
  expect(() => store.reserveProfileDisk('alice', next, 0)).toThrow('profileInUse');
  expect(db.select().from(browserProfileDisks).all()).toEqual([]);
});

it.each([
  ['backend', 'legacy-native'],
  ['format_version', 2],
  ['generation', 'invalid'],
] as const)(
  'refuses retained mismatched %s instead of rotating or rewriting its generation',
  (column, value) => {
    const db = open(),
      store = new BrowserRegistryStore(db, 'boot');
    const profile = store.createProfile('alice', 'Named'),
      browser = birth(store, profile.profileId);
    store.reserveProfileDisk('alice', browser, 0);
    // Simulate an unsupported/corrupted persisted database, rather than granting an override
    // through the production API. SQL identifiers come from the fixed table above.
    db.$client.pragma('ignore_check_constraints = ON');
    try {
      db.$client
        .prepare(`UPDATE browser_profile_disks SET ${column} = ? WHERE profile_id = ?`)
        .run(value, profile.profileId);
    } finally {
      db.$client.pragma('ignore_check_constraints = OFF');
    }
    const before = db.$client.prepare('SELECT * FROM browser_profile_disks').all();
    expect(() => store.reserveProfileDisk('alice', browser, 0)).toThrow('profileUncertain');
    expect(db.$client.prepare('SELECT * FROM browser_profile_disks').all()).toEqual(before);
  }
);

it('rolls back a failed original disk insert without releasing the opening reservation', () => {
  const db = open(),
    store = new BrowserRegistryStore(db, 'boot');
  const profile = store.createProfile('alice', 'Named'),
    browser = birth(store, profile.profileId);
  db.$client.exec(
    "CREATE TRIGGER refuse_disk BEFORE INSERT ON browser_profile_disks BEGIN SELECT RAISE(ABORT, 'original-disk-insert-refused'); END"
  );
  expect(() => store.reserveProfileDisk('alice', browser, 0)).toThrow(
    'original-disk-insert-refused'
  );
  expect(store.instance('alice', browser, 0).status).toBe('opening');
  expect(store.profiles('alice')[0].status).toBe('inUse');
  expect(db.select().from(browserProfileDisks).all()).toEqual([]);
  db.$client.exec('DROP TRIGGER refuse_disk');
  expect(store.reserveProfileDisk('alice', browser, 0).generation).toMatch(/^[A-Za-z0-9_-]{22}$/u);
});
