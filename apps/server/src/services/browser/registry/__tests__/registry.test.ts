import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authors,
  browserAttachments,
  browserInstances,
  rooms,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type { PrivateBrowserRetirementReceiver } from '@dorkos/browser/server-owner';
import { BrowserRegistryStore } from '../store.js';
import { BrowserRegistry } from '../registry.js';

it('keeps an import busy through native stop and never releases a failed import on a later observed stop', () => {
  const { store, registry } = fixture();
  const existing = store.createProfile('alice', 'Existing');
  const profile = store.beginProfileImport('alice', 'Imported');
  expect(profile.profileId).not.toBe(existing.profileId);
  expect(profile.status).toBe('inUse');
  expect(store.profiles('bob')).toEqual([]);
  expect(() =>
    store.birth(
      'bob',
      { mode: 'persistent', profileId: profile.profileId },
      'browser_foreign_0000000001',
      0
    )
  ).toThrow();
  expect(() => store.finishProfileImport('bob', profile.profileId, true)).toThrow();
  store.birth(
    'alice',
    { mode: 'persistent', profileId: profile.profileId },
    'browser_imported_0000000001',
    0
  );
  expect(registry.instances('alice')).toEqual([]);
  expect(() => registry.instance('alice', 'browser_imported_0000000001', 0)).toThrow(
    'inaccessible'
  );
  const row = store.instance('alice', 'browser_imported_0000000001', 0);
  store.transition(row, 'uncertain');
  expect(store.finishProfileImport('alice', profile.profileId, false).status).toBe('quarantined');
  store.transition(row, 'stopped');
  expect(
    store.profiles('alice').find((value) => value.profileId === profile.profileId)?.status
  ).toBe('quarantined');
  expect(store.profiles('alice').find((value) => value.profileId === existing.profileId)).toEqual(
    existing
  );
});
it('publishes the imported profile only after the original generation stopped', () => {
  const { store } = fixture();
  const profile = store.beginProfileImport('alice', 'Imported');
  store.birth(
    'alice',
    { mode: 'persistent', profileId: profile.profileId },
    'browser_imported_0000000001',
    0
  );
  store.transition(store.instance('alice', 'browser_imported_0000000001', 0), 'stopped');
  expect(store.profiles('alice')[0].status).toBe('inUse');
  expect(store.finishProfileImport('alice', profile.profileId, true).status).toBe('available');
  expect(store.isProfileImport('alice', profile.profileId)).toBe(false);
});
it.each(['failed', 'abandoned'] as const)(
  'retains %s import quarantine across original database close/reopen and later stopped reconciliation',
  (kind) => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'browser-import-restart-'));
    folders.push(folder);
    const file = path.join(folder, 'registry.sqlite');
    const original = fixture(database(file));
    const profile = original.store.beginProfileImport('alice', 'Imported');
    original.store.birth(
      'alice',
      { mode: 'persistent', profileId: profile.profileId },
      'browser_imported_restart_00001',
      0
    );
    const row = original.store.instance('alice', 'browser_imported_restart_00001', 0);
    original.store.transition(row, 'uncertain');
    if (kind === 'failed') original.store.finishProfileImport('alice', profile.profileId, false);
    original.db.$client.close();
    const reopened = fixture(database(file), 'boot-two');
    expect(reopened.store.isProfileImport('alice', profile.profileId)).toBe(false);
    expect(reopened.store.profiles('alice')[0].status).toBe('quarantined');
    reopened.store.transition(reopened.store.instance('alice', row.browserId, 0), 'stopped');
    expect(reopened.store.profiles('alice')[0].status).toBe('quarantined');
    expect(() =>
      reopened.store.birth(
        'alice',
        { mode: 'persistent', profileId: profile.profileId },
        'browser_after_import_restart_01',
        1
      )
    ).toThrow('profileUncertain');
    expect(() => original.store.finishProfileImport('alice', profile.profileId, true)).toThrow();
  }
);
const handles: Db[] = [],
  folders: string[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function database(file = ':memory:') {
  const db = createDb(file);
  handles.push(db);
  runMigrations(db);
  db.insert(authors)
    .values(
      ['alice', 'bob'].map((id) => ({
        id,
        kind: 'human' as const,
        naturalKey: `fixture:${id}`,
        displayName: id,
        createdAt: new Date().toISOString(),
      }))
    )
    .onConflictDoNothing()
    .run();
  return db;
}
function fixture(
  db = database(),
  boot = 'boot-one',
  authorize: (owner: string) => boolean = (owner) => owner === 'alice'
) {
  const store = new BrowserRegistryStore(db, boot);
  const registry = new BrowserRegistry(store, authorize);
  return { db, store, registry };
}
function original(browserId = 'browser-one_____________', browserGeneration = 1) {
  let complete!: (value: Awaited<PrivateBrowserRetirementReceiver['observation']>) => void;
  const observation = new Promise<Awaited<PrivateBrowserRetirementReceiver['observation']>>(
    (resolve) => {
      complete = resolve;
    }
  );
  const state = { ready: false, ordinary: true, retirements: 0, persistenceFailures: 0 };
  const receiver: PrivateBrowserRetirementReceiver = {
    browserId,
    browserGeneration,
    acquisition: Object.freeze({ mode: 'ephemeral' }),
    observation,
    isOrdinary: () => state.ordinary,
    isAuthorityCurrent: () => state.ready,
    authorityRevoked: () => {
      state.retirements++;
      state.ordinary = false;
      return observation;
    },
    persistenceFailure: () => {
      state.persistenceFailures++;
      state.ordinary = false;
      return observation;
    },
    disabled: () => observation,
    navigateInitial: async () => {
      throw new Error('Not used by metadata controls');
    },
    verifiedBrowserAdminEndpoint: () => null,
    verifiedRuntimeBinding: () => null,
    generationReturned: async () => null,
    consumeGenerationReturn: () => false,
  };
  const finish = async (observed: boolean) => {
    complete({
      cleanup: observed
        ? { state: 'settled', coverage: 'closed', pending: false, uncertainty: [] }
        : { state: 'unverified', coverage: 'unavailable', pending: true, uncertainty: [] },
      owners: [],
      terminal: observed
        ? { cleanup: 'observed' }
        : { cleanup: 'unverified', reason: 'observationUnavailable' },
      firstCause: 'authorityRevoked',
      uncertainty: [],
    });
    await observation;
    await Promise.resolve();
  };
  return { receiver, state, finish };
}
function birth(f: ReturnType<typeof fixture>, o: ReturnType<typeof original>, profileId?: string) {
  // Unit subject receives the exact requested metadata before its callback.
  o.receiver = {
    ...o.receiver,
    acquisition: Object.freeze(
      profileId ? { mode: 'persistent' as const, profileId } : { mode: 'ephemeral' as const }
    ),
  };
  f.registry
    .birthOwner('alice', profileId ? { mode: 'persistent', profileId } : { mode: 'ephemeral' })
    .registerBirth(o.receiver);
}

describe('owner-qualified registry with real migrated SQLite and original receiver controls', () => {
  it('refuses mode and profile substitutions before any metadata reservation', () => {
    const f = fixture(),
      a = f.store.createProfile('alice', 'A'),
      b = f.store.createProfile('alice', 'B');
    const persistentOwner = f.registry.birthOwner('alice', {
      mode: 'persistent',
      profileId: a.profileId,
    });
    const ephemeral = original();
    expect(() => persistentOwner.registerBirth(ephemeral.receiver)).toThrow('inaccessible');
    const otherProfile = original('different-profile_______');
    otherProfile.receiver = {
      ...otherProfile.receiver,
      acquisition: Object.freeze({ mode: 'persistent', profileId: b.profileId }),
    };
    expect(() => persistentOwner.registerBirth(otherProfile.receiver)).toThrow('inaccessible');
    expect(() =>
      f.registry.birthOwner('alice', { mode: 'ephemeral' }).registerBirth(otherProfile.receiver)
    ).toThrow('inaccessible');
    expect(f.store.rows()).toEqual([]);
    expect(f.store.profiles('alice').map((profile) => profile.status)).toEqual([
      'available',
      'available',
    ]);
    expect(ephemeral.state.retirements).toBe(0);
  });
  it('admits independently authorized room associations and refuses unauthorized targets', () => {
    const f = fixture(),
      o = original();
    const roomId = 'fixture-room____________';
    f.db
      .insert(rooms)
      .values({
        id: roomId,
        kind: 'channel',
        slug: 'fixture',
        title: 'Fixture',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      })
      .run();
    birth(f, o);
    o.state.ready = true;
    const id = f.registry.attach('alice', o.receiver.browserId, 1, { kind: 'room', roomId });
    expect(f.db.select().from(browserAttachments).get()?.roomId).toBe(roomId);
    f.registry.detach('alice', id);
    expect(o.state.retirements).toBe(0);
    const other = fixture(database(), 'other-boot', () => false),
      denied = original();
    birth(other, denied);
    denied.state.ready = true;
    expect(() =>
      other.registry.attach('alice', denied.receiver.browserId, 1, {
        kind: 'session',
        sessionId: 'fixture-session_________',
      })
    ).toThrow('inaccessible');
    expect(other.db.select().from(browserAttachments).all()).toHaveLength(0);
  });

  it('rolls back profile reservations and preserves a primary birth failure', () => {
    const f = fixture(),
      profile = f.store.createProfile('alice', 'Fixture'),
      o = original();
    f.db.$client.exec(
      "CREATE TRIGGER fail_birth BEFORE INSERT ON browser_instances BEGIN SELECT RAISE(ABORT, 'fixture-write-refused'); END"
    );
    o.receiver.persistenceFailure = () => {
      throw new Error('secondary-retirement-failure');
    };
    expect(() => birth(f, o, profile.profileId)).toThrow('fixture-write-refused');
    expect(f.store.profiles('alice')[0].status).toBe('available');
    expect(f.store.rows()).toEqual([]);
  });

  it('a failed lifecycle write fences the original without claiming running or releasing storage', () => {
    const f = fixture(),
      profile = f.store.createProfile('alice', 'Fixture'),
      o = original();
    birth(f, o, profile.profileId);
    o.state.ready = true;
    f.db.$client.exec(
      "CREATE TRIGGER fail_running BEFORE UPDATE ON browser_instances WHEN NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'fixture-status-refused'); END"
    );
    expect(() => f.registry.instance('alice', o.receiver.browserId, 1)).toThrow(
      'fixture-status-refused'
    );
    expect(o.state.retirements).toBe(1);
    expect(f.store.profiles('alice')[0].status).toBe('inUse');
    expect(() => f.registry.instance('alice', o.receiver.browserId, 1)).toThrow('profileUncertain');
  });

  it('reconciliation preserves genuinely stopped identities and admits only a fresh browser ID', async () => {
    const f = fixture(),
      profile = f.store.createProfile('alice', 'Fixture'),
      o = original();
    birth(f, o, profile.profileId);
    await o.finish(true);
    const restarted = fixture(f.db, 'new-boot');
    expect(restarted.registry.instance('alice', o.receiver.browserId, 1).status).toBe('stopped');
    expect(restarted.store.profiles('alice')[0].status).toBe('available');
    expect(() => birth(restarted, original(o.receiver.browserId, 2), profile.profileId)).toThrow(
      'staleBinding'
    );
    birth(restarted, original('fresh-browser___________', 2), profile.profileId);
    expect(restarted.registry.instance('alice', 'fresh-browser___________', 2).status).toBe(
      'opening'
    );
  });

  it('uses original authority rather than durable running or attachment possession', () => {
    const f = fixture(),
      o = original();
    birth(f, o);
    expect(f.registry.instance('alice', 'browser-one_____________', 1).status).toBe('opening');
    f.db.update(browserInstances).set({ status: 'running' }).run();
    // Corrupted metadata cannot turn an opening engine into a running authority.
    expect(() =>
      f.registry.attach('alice', 'browser-one_____________', 1, {
        kind: 'session',
        sessionId: 'session-one_____________',
      })
    ).toThrow('stopped');
    o.state.ready = true;
    expect(f.registry.instance('alice', 'browser-one_____________', 1).status).toBe('running');
    const attachment = f.registry.attach('alice', 'browser-one_____________', 1, {
      kind: 'session',
      sessionId: 'session-one_____________',
    });
    expect(() => f.registry.instance('bob', 'browser-one_____________', 1)).toThrow('inaccessible');
    expect(() => f.registry.detach('bob', attachment)).toThrow('inaccessible');
    expect(() => f.registry.stop('bob', 'browser-one_____________', 1)).toThrow('inaccessible');
  });

  it('detaches independently, then explicit stop waits for original observed cleanup', async () => {
    const f = fixture(),
      profile = f.store.createProfile('alice', 'Fixture'),
      o = original();
    birth(f, o, profile.profileId);
    o.state.ready = true;
    const attachment = f.registry.attach('alice', 'browser-one_____________', 1, {
      kind: 'session',
      sessionId: 'session-one_____________',
    });
    f.registry.detach('alice', attachment);
    f.registry.detach('alice', attachment);
    expect(o.state.retirements).toBe(0);
    expect(f.registry.instance('alice', 'browser-one_____________', 1).status).toBe('running');
    expect(f.store.profiles('alice')[0].status).toBe('inUse');
    f.registry.stop('alice', 'browser-one_____________', 1);
    expect(o.state.retirements).toBe(1);
    expect(f.registry.instance('alice', 'browser-one_____________', 1).status).toBe('stopping');
    expect(f.store.profiles('alice')[0].status).toBe('inUse');
    await o.finish(true);
    expect(f.registry.instance('alice', 'browser-one_____________', 1).status).toBe('stopped');
    expect(f.store.profiles('alice')[0].status).toBe('available');
    expect(() => birth(f, original('browser-one_____________', 2), profile.profileId)).toThrow(
      'staleBinding'
    );
    birth(f, original('browser-fresh___________', 2), profile.profileId);
  });

  it('uncertain cleanup quarantines retained storage and cannot admit another profile owner', async () => {
    const f = fixture(),
      profile = f.store.createProfile('alice', 'Retained'),
      o = original();
    birth(f, o, profile.profileId);
    await o.finish(false);
    expect(f.registry.instance('alice', 'browser-one_____________', 1).status).toBe('uncertain');
    expect(f.store.profiles('alice')[0].status).toBe('quarantined');
    expect(() => birth(f, original('browser-two_____________'), profile.profileId)).toThrow(
      'profileUncertain'
    );
    const foreign = original('browser-bob_____________');
    foreign.receiver = {
      ...foreign.receiver,
      acquisition: Object.freeze({ mode: 'persistent', profileId: profile.profileId }),
    };
    expect(() =>
      f.registry
        .birthOwner('bob', { mode: 'persistent', profileId: profile.profileId })
        .registerBirth(foreign.receiver)
    ).toThrow('inaccessible');
    expect(f.store.profiles('bob')).toEqual([]);
  });

  it('clean metadata is independent and never acquires or changes a retained profile reservation', () => {
    const f = fixture(),
      profile = f.store.createProfile('alice', 'Retained'),
      before = f.store.profiles('alice');
    const clean = original();
    birth(f, clean);
    clean.state.ready = true;
    expect(f.registry.instance('alice', 'browser-one_____________', 1)).toEqual({
      browserId: 'browser-one_____________',
      browserGeneration: 1,
      mode: 'ephemeral',
      status: 'running',
    });
    expect(f.store.profiles('alice')).toEqual(before);
    birth(f, original('retained-browser________'), profile.profileId);
    expect(() => birth(f, original('competing-browser_______'), profile.profileId)).toThrow(
      'profileInUse'
    );
  });

  it('reopens the actual file without reviving old IDs, grants or attachment authority', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'browser-registry-'));
    folders.push(folder);
    const file = path.join(folder, 'metadata.sqlite'),
      f = fixture(database(file));
    const profile = f.store.createProfile('alice', 'Retained'),
      o = original();
    birth(f, o, profile.profileId);
    o.state.ready = true;
    f.registry.attach('alice', 'browser-one_____________', 1, {
      kind: 'session',
      sessionId: 'session-one_____________',
    });
    f.db.$client.close();
    const restarted = fixture(database(file), 'boot-two');
    expect(restarted.registry.instance('alice', 'browser-one_____________', 1).status).toBe(
      'uncertain'
    );
    expect(restarted.store.profiles('alice')[0].status).toBe('quarantined');
    expect(restarted.db.select().from(browserAttachments).get()?.detachedAt).not.toBeNull();
    expect(() => restarted.registry.stop('alice', 'browser-one_____________', 1)).toThrow(
      'profileUncertain'
    );
    expect(() => birth(restarted, original('browser-one_____________', 2))).toThrow('staleBinding');
    birth(restarted, original('fresh-clean_____________'));
    expect(restarted.registry.instance('alice', 'fresh-clean_____________', 1).status).toBe(
      'opening'
    );
  });

  it('captures the original predicates and rechecks after reentrant attachment authorization', () => {
    const f = fixture(),
      o = original();
    birth(f, o);
    o.state.ready = true;
    expect(f.registry.instance('alice', 'browser-one_____________', 1).status).toBe('running');
    o.receiver.isAuthorityCurrent = () => true;
    o.state.ready = false;
    expect(f.registry.instance('alice', 'browser-one_____________', 1).status).toBe('uncertain');
    expect(o.state.retirements).toBe(1);
    const db = database(),
      store = new BrowserRegistryStore(db, 'boot'),
      peer = original('reentrant_______________');
    const registry = new BrowserRegistry(store, () => {
      registry.stop('alice', 'reentrant_______________', 1);
      return true;
    });
    registry.birthOwner('alice', { mode: 'ephemeral' }).registerBirth(peer.receiver);
    peer.state.ready = true;
    expect(() =>
      registry.attach('alice', 'reentrant_______________', 1, {
        kind: 'session',
        sessionId: 'session_________________',
      })
    ).toThrow('stopped');
    expect(db.select().from(browserAttachments).all()).toHaveLength(0);
  });
});
