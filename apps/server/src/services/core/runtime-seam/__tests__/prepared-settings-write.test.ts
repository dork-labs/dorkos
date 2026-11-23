/** Actual SQLite birth checks and Claude owner publication; only SDK ACK/read timing is scripted. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../runtimes/claude-code/agent-types.js';
import { eq, sessionBirthAllocations, sessionLocations, sessionMetadata } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { RuntimeRegistry } from '../../runtime-registry.js';
import { SessionStore } from '../../../runtimes/claude-code/sessions/session-store.js';
import { setChosenMode } from '../../../runtimes/claude-code/turn-permission.js';
import { prepareClaudeSettingsUpdate } from '../../../runtimes/claude-code/sessions/settings/prepared-update.js';
import { bindSessionWrite } from '../bind-session-write.js';
import { readDraftSource } from '../person-draft-settings.js';
import {
  runPreparedDraftSettingsMutation,
  runPreparedSettingsMutation,
  SettingsPublicationError,
} from '../prepared-settings-write.js';
import type { SessionBirthWriteContext } from '../session-birth-write.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let db: ReturnType<typeof createTestDb>;
let registry: RuntimeRegistry;
let store: SessionStore;
const id = 'prepared-chat';
const stamp = '2026-11-19T00:00:00.000Z';
let birth: SessionBirthWriteContext;
const row = () => db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get();
const allocation = () => db.select().from(sessionBirthAllocations).all();

/** The saved-location witness created by the actual first commit in this fixture. */
function currentLocationDraft() {
  const source = readDraftSource(db, id);
  if (source?.sourceKind !== 'person-location' || !source.locationId)
    throw new Error('Expected a committed saved-location draft.');
  return { ...source, sourceKind: 'person-location' as const, locationId: source.locationId };
}

beforeEach(() => {
  db = createTestDb();
  registry = new RuntimeRegistry();
  registry.setDb(db);
  store = new SessionStore();
  store.configureSettings(registry, 'default');
  db.insert(sessionLocations)
    .values({ id: 'location', ownerId: 'person', cwd: '/project', createdAt: stamp })
    .run();
  db.insert(sessionBirthAllocations)
    .values({
      sessionId: id,
      version: 1,
      createdAt: stamp,
      sourceKind: 'person-location',
      ownerId: 'person',
      locationId: 'location',
    })
    .run();
  birth = {
    kind: 'person-location',
    sessionId: id,
    allocationCreatedAt: stamp,
    ownerId: 'person',
    locationId: 'location',
    cwd: '/project',
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  db.$client.close();
});

/** Pause the genuine durable read without replacing its SQLite result. */
function holdHydration() {
  const entered = deferred<void>();
  const release = deferred<void>();
  const get = registry.getSessionSettings.bind(registry);
  vi.spyOn(registry, 'getSessionSettings').mockImplementation(async (sessionId) => {
    const result = await get(sessionId);
    entered.resolve();
    await release.promise;
    return result;
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

it('publishes the cold owner once after actual commit and before the port continuation', async () => {
  const save = registry.saveSessionSettings.bind(registry);
  vi.spyOn(registry, 'saveSessionSettings').mockImplementation((...args) => {
    const result = save(...args);
    expect(row()).toMatchObject({
      modelLaunchState: 'pending-v1',
      permissionMode: 'plan',
      model: 'chosen',
    });
    expect(allocation()).toEqual([]);
    expect(store.findSession(id)).toMatchObject({
      permissionMode: 'plan',
      model: 'chosen',
      effort: 'high',
      fastMode: false,
      hasStarted: false,
      needsTranscriptCheck: true,
    });
    return result;
  });
  const ensure = vi.spyOn(store, 'ensureSession');
  await expect(
    runPreparedSettingsMutation(id, birth, () =>
      store.updateSession(id, {
        permissionMode: 'plan',
        model: 'chosen',
        effort: 'high',
        fastMode: false,
      })
    )
  ).resolves.toEqual({ updated: true });
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(row()).toMatchObject({ runtime: null, effort: 'high', fastMode: false });
});

it('refuses a cold successor appearing during the real hydration read without writes', async () => {
  const hold = holdHydration();
  const update = runPreparedSettingsMutation(id, birth, () =>
    store.updateSession(id, { permissionMode: 'plan', model: 'stale' })
  );
  await hold.entered;
  store.ensureSession(id, { permissionMode: 'acceptEdits', model: 'successor', fastMode: true });
  const successor = store.findSession(id);
  hold.release();
  await expect(update).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(store.findSession(id)).toBe(successor);
  expect(successor).toMatchObject({
    permissionMode: 'acceptEdits',
    model: 'successor',
    fastMode: true,
  });
  expect(row()).toBeUndefined();
  expect(allocation()).toHaveLength(1);
});

it('retains a real competing first writer and refuses stale hydration without creating memory', async () => {
  const hold = holdHydration();
  const update = runPreparedSettingsMutation(id, birth, () =>
    store.updateSession(id, { permissionMode: 'plan', model: 'stale' })
  );
  await hold.entered;
  await registry.saveSessionSettings(id, { permissionMode: 'acceptEdits', model: 'winner' }, birth);
  const winner = row();
  hold.release();
  await expect(update).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(row()).toEqual(winner);
  expect(store.findSession(id)).toBeUndefined();
  expect(allocation()).toEqual([]);
});

it('rolls back changed durable source without touching the actual warm owner or SDK', async () => {
  store.ensureSession(id, { permissionMode: 'default', model: 'before' });
  const owner = store.findSession(id)!;
  const setPermissionMode = vi.fn().mockResolvedValue(undefined);
  owner.activeQuery = { setPermissionMode } as unknown as NonNullable<AgentSession['activeQuery']>;
  db.update(sessionLocations)
    .set({ ownerId: 'different-person' })
    .where(eq(sessionLocations.id, 'location'))
    .run();
  await expect(
    runPreparedSettingsMutation(id, birth, () =>
      store.updateSession(id, { permissionMode: 'plan', model: 'stale' })
    )
  ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(store.findSession(id)).toBe(owner);
  expect(owner).toMatchObject({ permissionMode: 'default', model: 'before' });
  expect(setPermissionMode).not.toHaveBeenCalled();
  expect(row()).toBeUndefined();
  expect(allocation()).toHaveLength(1);
});

it('detects same-object settings changes before SQL instead of relying on pointer identity', async () => {
  store.ensureSession(id, { permissionMode: 'default', model: 'before' });
  const owner = store.findSession(id)!;
  const save = registry.saveSessionSettings.bind(registry);
  vi.spyOn(registry, 'saveSessionSettings').mockImplementation((...args) => {
    setChosenMode(owner, 'acceptEdits');
    owner.model = 'newer';
    return save(...args);
  });
  await expect(
    runPreparedSettingsMutation(id, birth, () =>
      store.updateSession(id, { permissionMode: 'plan', model: 'stale' })
    )
  ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(owner).toMatchObject({ permissionMode: 'acceptEdits', model: 'newer' });
  expect(row()).toBeUndefined();
  expect(allocation()).toHaveLength(1);
});

it.each(['acked', 'rejected'] as const)(
  'never reapplies fields over a successor after the SDK %s continuation',
  async (ack) => {
    store.ensureSession(id, { permissionMode: 'default', model: 'before' });
    const owner = store.findSession(id)!;
    const entered = deferred<void>();
    const release = deferred<void>();
    const setPermissionMode = vi.fn(async (mode: string) => {
      if (mode !== 'plan') return;
      entered.resolve();
      await release.promise;
      if (ack === 'rejected') throw new Error('Scripted SDK refusal');
    });
    owner.activeQuery = { setPermissionMode } as unknown as NonNullable<
      AgentSession['activeQuery']
    >;
    const update = runPreparedSettingsMutation(id, birth, () =>
      store.updateSession(id, {
        permissionMode: 'plan',
        model: 'committed',
        effort: 'high',
        fastMode: false,
      })
    );
    await entered.promise;
    expect(row()).toMatchObject({
      permissionMode: 'plan',
      model: 'committed',
      effort: 'high',
      fastMode: false,
    });
    expect(owner).toMatchObject({
      permissionMode: 'plan',
      model: 'committed',
      effort: 'high',
      fastMode: false,
    });
    const draft = currentLocationDraft();
    try {
      await expect(
        runPreparedDraftSettingsMutation(id, draft, () =>
          store.updateSession(id, {
            permissionMode: 'acceptEdits',
            model: 'successor',
            effort: 'low',
            fastMode: true,
          })
        )
      ).resolves.toEqual({ updated: true });
      expect(store.findSession(id)).toBe(owner);
    } finally {
      release.resolve();
    }
    await expect(update).resolves.toEqual({
      updated: true,
      permissionModePendingUntilNextTurn: true,
    });
    expect(setPermissionMode.mock.calls).toEqual([['plan'], ['acceptEdits']]);
    expect(owner).toMatchObject({
      permissionMode: 'acceptEdits',
      model: 'successor',
      effort: 'low',
      fastMode: true,
    });
    expect(row()).toMatchObject({
      permissionMode: 'acceptEdits',
      model: 'successor',
      effort: 'low',
      fastMode: true,
    });
    expect(readDraftSource(db, id)).toEqual(draft);
    expect(allocation()).toEqual([]);
  }
);

it.each(['acked', 'rejected'] as const)(
  'keeps the existing warm mode ACK result when the current owner is unchanged (%s)',
  async (ack) => {
    store.ensureSession(id, { permissionMode: 'default', model: 'before' });
    const owner = store.findSession(id)!;
    const setPermissionMode = vi.fn(async () => {
      if (ack === 'rejected') throw new Error('Scripted SDK refusal');
    });
    owner.activeQuery = { setPermissionMode } as unknown as NonNullable<
      AgentSession['activeQuery']
    >;
    await expect(
      runPreparedSettingsMutation(id, birth, () =>
        store.updateSession(id, {
          permissionMode: 'plan',
          model: 'chosen',
          effort: 'high',
          fastMode: false,
        })
      )
    ).resolves.toEqual({
      updated: true,
      ...(ack === 'rejected' ? { permissionModePendingUntilNextTurn: true } : {}),
    });
    expect(setPermissionMode).toHaveBeenCalledExactlyOnceWith('plan');
    expect(store.findSession(id)).toBe(owner);
    expect(owner).toMatchObject({
      permissionMode: 'plan',
      model: 'chosen',
      effort: 'high',
      fastMode: false,
    });
    expect(row()).toMatchObject({
      permissionMode: 'plan',
      model: 'chosen',
      effort: 'high',
      fastMode: false,
      modelLaunchState: 'pending-v1',
    });
    expect(allocation()).toEqual([]);
  }
);

it('refuses a real SDK alias without changing its original owner or either durable identity', async () => {
  await registry.saveSessionSettings('original-chat', { model: 'original-choice' });
  // An ordinary existing in-memory rename can predate settings-port wiring.
  store = new SessionStore();
  store.ensureSession('original-chat', { permissionMode: 'acceptEdits', model: 'original-choice' });
  const original = store.findSession('original-chat')!;
  original.sdkSessionId = id;
  await store.rebindSdkSession('original-chat', id, 'original-chat');
  store.configureSettings(registry, 'default');
  expect(store.findSession(id)).toBe(original);
  expect(store.sessionKeyOf(id)).toBe('original-chat');
  const before = db.select().from(sessionMetadata).all();
  const beforeAllocation = allocation();
  await expect(
    runPreparedSettingsMutation(id, birth, () => store.updateSession(id, { model: 'alias-choice' }))
  ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(store.findSession(id)).toBe(original);
  expect(original).toMatchObject({ permissionMode: 'acceptEdits', model: 'original-choice' });
  expect(db.select().from(sessionMetadata).all()).toEqual(before);
  expect(row()).toBeUndefined();
  expect(allocation()).toEqual(beforeAllocation);
});

it('refuses a map-key birth when its actual native identity has already changed', async () => {
  // The native identity can already have changed before settings-port wiring.
  store = new SessionStore();
  store.ensureSession(id, { permissionMode: 'default', model: 'original-choice' });
  const original = store.findSession(id)!;
  original.sdkSessionId = 'canonical-native';
  await store.rebindSdkSession(id, 'canonical-native', id);
  store.configureSettings(registry, 'default');
  expect(store.sessionKeyOf(id)).toBe(id);
  expect(store.findSession('canonical-native')).toBe(original);
  expect(original.sdkSessionId).toBe('canonical-native');
  const before = db.select().from(sessionMetadata).all();
  const beforeAllocation = allocation();
  const save = vi.spyOn(registry, 'saveSessionSettings');
  await expect(
    runPreparedSettingsMutation(id, birth, () => store.updateSession(id, { model: 'fresh-choice' }))
  ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(save).not.toHaveBeenCalled();
  expect(original.model).toBe('original-choice');
  expect(db.select().from(sessionMetadata).all()).toEqual(before);
  expect(allocation()).toEqual(beforeAllocation);
});

it('refuses scoped publication within an enclosing SQLite transaction without consuming birth', async () => {
  const save = registry.saveSessionSettings.bind(registry);
  vi.spyOn(registry, 'saveSessionSettings').mockImplementation((...args) => {
    let write!: Promise<void>;
    db.transaction(() => {
      write = save(...args);
      // SQLite callbacks stay synchronous. Observe this rejection in the same
      // tick, then return the original promise to the adapter after the callback.
      void write.catch(() => undefined);
    });
    return write;
  });
  await expect(
    runPreparedSettingsMutation(id, birth, () => store.updateSession(id, { model: 'uncommitted' }))
  ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(row()).toBeUndefined();
  expect(store.findSession(id)).toBeUndefined();
  expect(allocation()).toHaveLength(1);
});

it('retains the durable post-commit tag even when an adapter catches publication failure', async () => {
  const ensure = store.ensureSession.bind(store);
  vi.spyOn(store, 'ensureSession').mockImplementation((...args) => {
    ensure(...args);
    throw new Error('Local publication failed');
  });
  await expect(
    runPreparedSettingsMutation(id, birth, async () => {
      try {
        return await store.updateSession(id, { model: 'committed' });
      } catch {
        return { updated: false };
      }
    })
  ).rejects.toMatchObject({ code: 'SETTINGS_PUBLICATION_FAILED', committed: true });
  expect(row()).toMatchObject({ model: 'committed', modelLaunchState: 'pending-v1' });
  expect(allocation()).toEqual([]);
  expect(store.findSession(id)?.model).toBe('committed');
});

it('tags an escaping post-commit continuation failure without claiming rollback', async () => {
  await expect(
    runPreparedSettingsMutation(id, birth, async () => {
      await store.updateSession(id, { model: 'committed' });
      throw new Error('Later continuation failed');
    })
  ).rejects.toBeInstanceOf(SettingsPublicationError);
  expect(row()?.model).toBe('committed');
  expect(allocation()).toEqual([]);
});

it('does not let adapter catches turn a real source refusal into success', async () => {
  db.update(sessionLocations)
    .set({ cwd: '/moved' })
    .where(eq(sessionLocations.id, 'location'))
    .run();
  await expect(
    runPreparedSettingsMutation(id, birth, async () => {
      try {
        return await store.updateSession(id, { model: 'stale' });
      } catch {
        return { updated: false };
      }
    })
  ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(row()).toBeUndefined();
  expect(store.findSession(id)).toBeUndefined();
  expect(allocation()).toHaveLength(1);
});

it('keeps inherited exact-id async work closed after a successful scoped mutation', async () => {
  const release = deferred<void>();
  let escaped!: Promise<unknown>;
  await runPreparedSettingsMutation(id, birth, async () => {
    escaped = release.promise
      .then(() => store.updateSession(id, { model: 'escaped' }))
      .then(
        () => null,
        (error: unknown) => error
      );
    return store.updateSession(id, { model: 'committed' });
  });
  const before = row();
  release.resolve();
  await expect(escaped).resolves.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(row()).toEqual(before);
  expect(store.findSession(id)?.model).toBe('committed');
});

it('latches a caught explicit context disagreement before the real registry write can retry', async () => {
  store.ensureSession(id, { permissionMode: 'default', model: 'before' });
  const owner = store.findSession(id)!;
  const beforeAllocation = allocation();
  const save = registry.saveSessionSettings.bind(registry);
  let firstFailure: unknown;
  vi.spyOn(registry, 'saveSessionSettings').mockImplementation(async (...args) => {
    try {
      await save(args[0], args[1], { ...birth, allocationCreatedAt: 'different-allocation' });
    } catch (error) {
      firstFailure = error;
    }
    // The same actual port receives valid inputs, but this first-write attempt was already denied.
    return save(...args);
  });
  const failure = await runPreparedSettingsMutation(id, birth, () =>
    store.updateSession(id, { permissionMode: 'plan', model: 'retry' })
  ).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(firstFailure).toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(failure).toBe(firstFailure);
  expect(store.findSession(id)).toBe(owner);
  expect(owner).toMatchObject({ permissionMode: 'default', model: 'before' });
  expect(row()).toBeUndefined();
  expect(allocation()).toEqual(beforeAllocation);
});

it('latches duplicate real Claude staging even when its caller catches the refusal', async () => {
  store.ensureSession(id, { permissionMode: 'default', model: 'before' });
  const owner = store.findSession(id)!;
  const beforeAllocation = allocation();
  const save = registry.saveSessionSettings.bind(registry);
  let firstFailure: unknown;
  vi.spyOn(registry, 'saveSessionSettings').mockImplementation(async (...args) => {
    try {
      await prepareClaudeSettingsUpdate(store, id, { model: 'duplicate' }, registry, 'default');
    } catch (error) {
      firstFailure = error;
    }
    return save(...args);
  });
  const failure = await runPreparedSettingsMutation(id, birth, () =>
    store.updateSession(id, { model: 'retry' })
  ).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(firstFailure).toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(failure).toBe(firstFailure);
  expect(store.findSession(id)).toBe(owner);
  expect(owner.model).toBe('before');
  expect(row()).toBeUndefined();
  expect(allocation()).toEqual(beforeAllocation);
});

it('cannot acquire an unstaged first write and then retry it through the actual adapter', async () => {
  const beforeAllocation = allocation();
  let firstFailure: unknown;
  const failure = await runPreparedSettingsMutation(id, birth, async () => {
    try {
      await registry.saveSessionSettings(id, { model: 'unstaged' });
    } catch (error) {
      firstFailure = error;
    }
    return store.updateSession(id, { model: 'retry' });
  }).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(firstFailure).toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(failure).toBe(firstFailure);
  expect(row()).toBeUndefined();
  expect(store.findSession(id)).toBeUndefined();
  expect(allocation()).toEqual(beforeAllocation);
});

it('keeps a later ordinary same-id write available after the protected draft is bound', async () => {
  await runPreparedSettingsMutation(id, birth, async () => {
    await store.updateSession(id, { model: 'first' });
    const committed = row();
    expect(committed).toMatchObject({
      model: 'first',
      runtime: null,
      modelLaunchState: 'pending-v1',
    });
    expect(allocation()).toEqual([]);

    const draft = currentLocationDraft();
    await expect(store.updateSession(id, { model: 'unprepared' })).rejects.toMatchObject({
      code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE',
    });
    expect(row()).toEqual(committed);
    expect(store.findSession(id)?.model).toBe('first');
    expect(readDraftSource(db, id)).toEqual(draft);

    expect(
      bindSessionWrite(
        db,
        id,
        'claude-code',
        { kind: 'interactive' },
        undefined,
        {},
        {},
        undefined,
        undefined,
        draft
      )
    ).toBe(true);
    expect(readDraftSource(db, id)).toBeUndefined();
    return store.updateSession(id, { model: 'later' });
  });
  expect(row()).toMatchObject({
    model: 'later',
    runtime: 'claude-code',
    modelLaunchState: 'pending-v1',
  });
  expect(store.findSession(id)?.model).toBe('later');
  expect(allocation()).toEqual([]);
});

it('leaves unrelated ids ordinary while consuming only the exact scoped allocation', async () => {
  await runPreparedSettingsMutation(id, birth, async () => {
    await store.updateSession('other-chat', { model: 'ordinary' });
    return store.updateSession(id, { model: 'prepared' });
  });
  expect(
    db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, 'other-chat')).get()
  ).toMatchObject({ model: 'ordinary', modelLaunchState: null });
  expect(row()).toMatchObject({ model: 'prepared', modelLaunchState: 'pending-v1' });
});

describe('empty settings remain an explicitly inactive route case', () => {
  it('preserves ordinary title-only adapter hydration and does not consume an allocation', async () => {
    await expect(store.updateSession(id, {})).resolves.toEqual({ updated: true });
    expect(store.findSession(id)).toMatchObject({
      permissionMode: 'default',
      hasStarted: false,
      needsTranscriptCheck: true,
    });
    expect(row()).toBeUndefined();
    expect(allocation()).toHaveLength(1);
  });
  it('does not pretend an unsupported empty scoped mutation committed', async () => {
    await expect(
      runPreparedSettingsMutation(id, birth, () => store.updateSession(id, {}))
    ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
    expect(store.findSession(id)).toBeUndefined();
    expect(row()).toBeUndefined();
    expect(allocation()).toHaveLength(1);
  });
});
