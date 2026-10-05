import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  authors,
  rooms,
  browserAttachments,
  browserInstances,
  browserProfiles,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { AuthorRegistry } from '../../../rooms/author-registry.js';
import { createBrowserOwnerScopeResolver } from '../owner-scope.js';
import { BrowserRegistryConflict, createBrowserRegistryStore } from '../registry-store.js';

const state = vi.hoisted(() => ({
  ownerId: 'account-one',
  registry: null as AuthorRegistry | null,
}));
vi.mock('../../config-manager.js', () => ({ configManager: { get: () => ({ enabled: true }) } }));
vi.mock('../../auth/index.js', () => ({ readOwnerAccount: () => ({ id: state.ownerId }) }));
vi.mock('../../capabilities/index.js', () => ({ APPROVAL_TOKEN_HEADER: 'x-dorkos-approval' }));
vi.mock('../../agent-identity/agent-identity-service.js', () => ({
  agentTokenDigestPrefix: () => 'test',
  getAgentIdentityService: () => undefined,
}));
vi.mock('../../../rooms/index.js', () => ({
  getRoomService: () => ({ authorRegistry: state.registry }),
}));
const id = (letter: string) => letter.repeat(22);
let db: Db;
let resolver: ReturnType<typeof createBrowserOwnerScopeResolver>;
let store: ReturnType<typeof createBrowserRegistryStore>;
function scope(account = 'account-one') {
  state.ownerId = account;
  return resolver.resolve(
    { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as Request,
    { locals: { user: { userId: account, credential: 'cookie' } } } as unknown as Response
  );
}
beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  state.registry = new AuthorRegistry(db);
  resolver = createBrowserOwnerScopeResolver();
  store = createBrowserRegistryStore(db, resolver);
});
afterEach(() => {
  if (db?.$client.open) db.$client.close();
});
function profile() {
  return store.createProfile(scope(), { profileId: id('p'), label: 'Named profile' });
}
function reserve(browserId = id('b')) {
  return store.reserveInstance(scope(), {
    browserId,
    browserGeneration: 2,
    bootId: id('o'),
    mode: 'persistent',
    profileId: id('p'),
    expectedProfileRevision: 0,
  });
}

describe('owner-qualified browser metadata on real SQLite', () => {
  it('isolates owner reads and CAS writes, with the matched owner succeeding', () => {
    profile();
    expect(store.listProfiles(scope('account-two'))).toEqual([]);
    expect(() =>
      store.renameProfile(scope('account-two'), {
        profileId: id('p'),
        expectedRevision: 0,
        label: 'Wrong owner',
      })
    ).toThrow(BrowserRegistryConflict);
    expect(store.listProfiles(scope())[0]?.label).toBe('Named profile');
    expect(
      store.renameProfile(scope(), { profileId: id('p'), expectedRevision: 0, label: 'Renamed' })
    ).toMatchObject({ label: 'Renamed', revision: 1 });
    expect(() =>
      store.renameProfile(scope(), { profileId: id('p'), expectedRevision: 0, label: 'Stale' })
    ).toThrow(BrowserRegistryConflict);
    expect(store.listProfiles(scope())[0]?.label).toBe('Renamed');
  });
  it('consumes genuine scopes once and refuses foreign and copied scopes', () => {
    const once = scope();
    store.createProfile(once, { profileId: id('p'), label: 'Profile' });
    expect(() => store.listProfiles(once)).toThrow(BrowserRegistryConflict);
    expect(() =>
      store.listProfiles({ ...scope() } as NonNullable<ReturnType<typeof scope>>)
    ).toThrow(BrowserRegistryConflict);
    const foreign = createBrowserRegistryStore(db, createBrowserOwnerScopeResolver());
    expect(() => foreign.listProfiles(scope())).toThrow(BrowserRegistryConflict);
    expect(store.listProfiles(scope())).toHaveLength(1);
  });
  it('reserves persistent metadata atomically and does not reuse an occupied profile', () => {
    profile();
    reserve();
    expect(store.listProfiles(scope())[0]).toMatchObject({ status: 'inUse', revision: 1 });
    expect(() =>
      store.reserveInstance(scope(), {
        browserId: id('c'),
        browserGeneration: 3,
        bootId: id('o'),
        mode: 'persistent',
        profileId: id('p'),
        expectedProfileRevision: 1,
      })
    ).toThrow(BrowserRegistryConflict);
    expect(db.select().from(browserInstances).all()).toHaveLength(1);
  });
  it('rolls back profile reservation if an existing browser identity conflicts', () => {
    profile();
    store.reserveInstance(scope(), {
      browserId: id('b'),
      browserGeneration: 0,
      mode: 'ephemeral',
      bootId: id('o'),
    });
    expect(() => reserve()).toThrow();
    expect(store.listProfiles(scope())[0]).toMatchObject({ status: 'available', revision: 0 });
    expect(db.select().from(browserInstances).all()).toHaveLength(1);
  });
  it('requires the profile revision and owner before reserving, with a healthy peer', () => {
    profile();
    expect(() =>
      store.reserveInstance(scope(), {
        browserId: id('b'),
        browserGeneration: 0,
        mode: 'persistent',
        bootId: id('o'),
        profileId: id('p'),
        expectedProfileRevision: 1,
      })
    ).toThrow(BrowserRegistryConflict);
    expect(() =>
      store.reserveInstance(scope('account-two'), {
        browserId: id('b'),
        browserGeneration: 0,
        mode: 'persistent',
        bootId: id('o'),
        profileId: id('p'),
        expectedProfileRevision: 0,
      })
    ).toThrow(BrowserRegistryConflict);
    expect(store.listProfiles(scope())[0]?.status).toBe('available');
    reserve();
    expect(store.listProfiles(scope())[0]?.status).toBe('inUse');
  });
  it('keeps clean metadata independent and never projects stored active status as liveness', () => {
    profile();
    store.reserveInstance(scope(), {
      browserId: id('b'),
      browserGeneration: 1,
      mode: 'ephemeral',
      bootId: id('o'),
    });
    expect(store.listProfiles(scope())[0]).toMatchObject({ status: 'available', revision: 0 });
    expect(store.listInstances(scope())).toEqual([
      { browserId: id('b'), browserGeneration: 1, mode: 'ephemeral', status: 'uncertain' },
    ]);
    expect(Object.isFrozen(store.listInstances(scope())[0])).toBe(true);
  });
  it('guards attachment generation and revision; detach does not stop or release the profile', () => {
    profile();
    reserve();
    const attach = {
      attachmentId: id('a'),
      browserId: id('b'),
      browserGeneration: 2,
      expectedInstanceRevision: 0,
      attachment: { kind: 'session' as const, sessionId: id('s') },
    };
    expect(() => store.attach(scope(), { ...attach, browserGeneration: 3 })).toThrow(
      BrowserRegistryConflict
    );
    expect(() => store.attach(scope('account-two'), attach)).toThrow(BrowserRegistryConflict);
    expect(store.attach(scope(), attach)).toMatchObject({
      attachment: attach.attachment,
      revision: 0,
    });
    expect(() => store.attach(scope(), { ...attach, attachmentId: id('x') })).toThrow(
      BrowserRegistryConflict
    );
    expect(() =>
      store.detach(scope('account-two'), { attachmentId: id('a'), expectedRevision: 0 })
    ).toThrow(BrowserRegistryConflict);
    expect(store.detach(scope(), { attachmentId: id('a'), expectedRevision: 0 })).toMatchObject({
      revision: 1,
    });
    expect(() => store.detach(scope(), { attachmentId: id('a'), expectedRevision: 0 })).toThrow(
      BrowserRegistryConflict
    );
    expect(db.select().from(browserInstances).get()?.status).toBe('opening');
    expect(store.listProfiles(scope())[0]?.status).toBe('inUse');
    expect(db.select().from(browserAttachments).get()?.detachedAt).not.toBeNull();
  });
  it('rolls back attachment CAS on duplicate target and room deletion removes only metadata', () => {
    profile();
    reserve();
    db.insert(rooms)
      .values({
        id: id('r'),
        kind: 'channel',
        slug: 'browser-fixture',
        title: 'Fixture',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      })
      .run();
    const input = {
      attachmentId: id('a'),
      browserId: id('b'),
      browserGeneration: 2,
      expectedInstanceRevision: 0,
      attachment: { kind: 'room' as const, roomId: id('r') },
    };
    store.attach(scope(), input);
    expect(() =>
      store.attach(scope(), { ...input, attachmentId: id('x'), expectedInstanceRevision: 1 })
    ).toThrow();
    expect(db.select().from(browserInstances).get()?.revision).toBe(1);
    db.delete(rooms)
      .where(eq(rooms.id, id('r')))
      .run();
    expect(db.select().from(browserAttachments).all()).toEqual([]);
    expect(db.select().from(browserInstances).get()?.status).toBe('opening');
    expect(store.listProfiles(scope())[0]?.status).toBe('inUse');
  });
  it('fails counter exhaustion without wrapping a revision or modifying metadata', () => {
    profile();
    db.update(browserProfiles)
      .set({ revision: Number.MAX_SAFE_INTEGER })
      .where(eq(browserProfiles.profileId, id('p')))
      .run();
    expect(() =>
      store.renameProfile(scope(), {
        profileId: id('p'),
        expectedRevision: Number.MAX_SAFE_INTEGER,
        label: 'Overflow',
      })
    ).toThrow(BrowserRegistryConflict);
    expect(store.listProfiles(scope())[0]?.label).toBe('Named profile');
  });
  it('requires a real human author row, not just possession of a namespace snapshot', () => {
    const scoped = scope();
    const author = db.select().from(authors).get()!;
    db.update(authors).set({ kind: 'agent' }).where(eq(authors.id, author.id)).run();
    expect(() => store.listProfiles(scoped)).toThrow(BrowserRegistryConflict);
    db.update(authors).set({ kind: 'human' }).where(eq(authors.id, author.id)).run();
    expect(store.listProfiles(scope())).toEqual([]);
  });
});
