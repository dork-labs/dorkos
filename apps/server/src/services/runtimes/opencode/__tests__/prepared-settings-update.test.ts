/** Actual local registries, durable mapping and SQLite birth. No sidecar or inference is started. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, sessionBirthAllocations, sessionLocations, sessionMetadata } from '@dorkos/db';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { readDraftSource } from '../../../core/runtime-seam/person-draft-settings.js';
import {
  runPreparedDraftSettingsMutation,
  runPreparedSettingsMutation,
} from '../../../core/runtime-seam/prepared-settings-write.js';
import type { SessionBirthWriteContext } from '../../../core/runtime-seam/session-birth-write.js';
import { OpenCodeRuntime } from '../opencode-runtime.js';
import { OpenCodeSessionRegistry } from '../sessions/session-registry.js';
import { OpenCodeSessionMapper, type OpenCodeClientProvider } from '../sessions/session-mapper.js';
import { OpenCodeSessionMap } from '../sessions/session-map.js';
import { prepareOpenCodeSettingsUpdate } from '../sessions/prepared-settings-update.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let db: ReturnType<typeof createTestDb>;
let settings: RuntimeRegistry;
let local: OpenCodeSessionRegistry;
let mapper: OpenCodeSessionMapper;
let map: OpenCodeSessionMap;
let provider: OpenCodeClientProvider;
let birth: SessionBirthWriteContext;
const id = 'allocated-opencode';
const stamp = '2026-11-19T00:00:00.000Z';
const row = () => db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get();
const allocations = () => db.select().from(sessionBirthAllocations).all();
beforeEach(() => {
  db = createTestDb();
  settings = new RuntimeRegistry();
  settings.setDb(db);
  local = new OpenCodeSessionRegistry();
  provider = {
    getClient: vi.fn(async () => {
      throw new Error('Unexpected sidecar access');
    }),
    peekClient: vi.fn(() => null),
  };
  map = new OpenCodeSessionMap(db);
  mapper = new OpenCodeSessionMapper(provider, map);
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
    ownerId: 'person',
    locationId: 'location',
    cwd: '/project',
    allocationCreatedAt: stamp,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  db.$client.close();
});
const ownsUnboundIdentity = () => mapper.getOpenCodeSessionId(id) === undefined;

it('actual runtime cold settings scope commits once without native work or storing unsupported effort', async () => {
  const runtime = new OpenCodeRuntime({ provider, sessionMap: map });
  runtime.setSessionSettings(settings);
  await expect(
    runPreparedSettingsMutation(id, birth, () =>
      runtime.updateSession(id, {
        permissionMode: 'plan',
        model: 'chosen',
        fastMode: false,
        effort: 'high',
      })
    )
  ).resolves.toEqual({ updated: true });
  expect(runtime.hasSession(id)).toBe(true);
  expect(row()).toMatchObject({
    runtime: null,
    modelLaunchState: 'pending-v1',
    permissionMode: 'plan',
    model: 'chosen',
    fastMode: false,
    effort: null,
  });
  expect(allocations()).toEqual([]);
  expect(provider.getClient).not.toHaveBeenCalled();
});

it('publishes the real cwd-qualified list event only after the actual commit', async () => {
  const events = local.subscribe();
  const next = events.next();
  const save = settings.saveSessionSettings.bind(settings);
  vi.spyOn(settings, 'saveSessionSettings').mockImplementation((...args) => {
    expect(local.has(id)).toBe(false);
    const result = save(...args);
    expect(row()).toMatchObject({ modelLaunchState: 'pending-v1', model: 'chosen' });
    expect(local.get(id)).toMatchObject({
      id,
      cwd: '/project',
      model: 'chosen',
      permissionMode: 'default',
    });
    return result;
  });
  try {
    await runPreparedSettingsMutation(id, birth, async () => {
      await prepareOpenCodeSettingsUpdate(
        local,
        id,
        { cwd: '/project', model: 'chosen' },
        settings,
        ownsUnboundIdentity
      );
      await settings.saveSessionSettings(id, { model: 'chosen' });
    });
    expect((await next).value).toMatchObject({
      type: 'session_upserted',
      session: { id, cwd: '/project', model: 'chosen' },
    });
    expect(allocations()).toEqual([]);
  } finally {
    await events.return?.();
  }
});

it('keeps a current unknown mode using actual owner evidence rather than get-copy identity', async () => {
  local.register(id, { cwd: '/project', permissionMode: 'future-mode', model: 'old' });
  expect(local.get(id)).not.toBe(local.get(id));
  const events = local.subscribe();
  try {
    await events.next();
    const next = events.next();
    await runPreparedSettingsMutation(id, birth, async () => {
      await prepareOpenCodeSettingsUpdate(
        local,
        id,
        { model: 'chosen' },
        settings,
        ownsUnboundIdentity
      );
      await settings.saveSessionSettings(id, { model: 'chosen' });
    });
    expect(local.get(id)).toMatchObject({ permissionMode: 'future-mode', model: 'chosen' });
    expect((await next).value).toMatchObject({
      session: { permissionMode: 'future-mode', model: 'chosen' },
    });
    expect(row()).toMatchObject({
      permissionMode: null,
      model: 'chosen',
      modelLaunchState: 'pending-v1',
    });
  } finally {
    await events.return?.();
  }
});

it('refuses a real same-record update before SQL and retains the competing local settings', async () => {
  local.register(id, { cwd: '/project', permissionMode: 'default', model: 'old' });
  const beforeAllocation = allocations();
  const save = settings.saveSessionSettings.bind(settings);
  vi.spyOn(settings, 'saveSessionSettings').mockImplementation((...args) => {
    local.register(id, { permissionMode: 'acceptEdits', model: 'winner' });
    return save(...args);
  });
  await expect(
    runPreparedSettingsMutation(id, birth, async () => {
      await prepareOpenCodeSettingsUpdate(
        local,
        id,
        { model: 'stale' },
        settings,
        ownsUnboundIdentity
      );
      await settings.saveSessionSettings(id, { model: 'stale' });
    })
  ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(local.get(id)).toMatchObject({ permissionMode: 'acceptEdits', model: 'winner' });
  expect(row()).toBeUndefined();
  expect(allocations()).toEqual(beforeAllocation);
});

it('preserves a real settings-first winner while a cold actual hydration read is paused', async () => {
  const entered = deferred();
  const release = deferred();
  const get = settings.getSessionSettings.bind(settings);
  vi.spyOn(settings, 'getSessionSettings').mockImplementation(async (sessionId) => {
    const result = await get(sessionId);
    entered.resolve();
    await release.promise;
    return result;
  });
  const pending = runPreparedSettingsMutation(id, birth, async () => {
    await prepareOpenCodeSettingsUpdate(
      local,
      id,
      { model: 'stale' },
      settings,
      ownsUnboundIdentity
    );
    await settings.saveSessionSettings(id, { model: 'stale' });
  });
  await entered.promise;
  await settings.saveSessionSettings(id, { model: 'winner' }, birth);
  const winner = row();
  release.resolve();
  await expect(pending).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(local.has(id)).toBe(false);
  expect(row()).toEqual(winner);
  expect(allocations()).toEqual([]);
});

it('refuses an actual durable native association without publishing a fresh birth', async () => {
  map.bind(id, 'actual-recorded-native-id');
  const runtime = new OpenCodeRuntime({ provider, sessionMap: map });
  runtime.setSessionSettings(settings);
  const beforeAllocation = allocations();
  await expect(
    runPreparedSettingsMutation(id, birth, () => runtime.updateSession(id, { model: 'fresh' }))
  ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(runtime.hasSession(id)).toBe(false);
  expect(row()).toBeUndefined();
  expect(allocations()).toEqual(beforeAllocation);
  expect(map.listAll()).toEqual([{ sessionId: id, ocSessionId: 'actual-recorded-native-id' }]);
  expect(provider.getClient).not.toHaveBeenCalled();
});

it('never reapplies an older patch after a real list-event consumer publishes its successor', async () => {
  const events = local.subscribe();
  const successor = events.next().then(async (event) => {
    expect(event).toMatchObject({
      done: false,
      value: {
        type: 'session_upserted',
        session: { id, cwd: '/project', model: 'first' },
      },
    });
    const firstRow = row();
    expect(firstRow).toMatchObject({
      runtime: null,
      modelLaunchState: 'pending-v1',
      model: 'first',
    });
    const source = readDraftSource(db, id);
    if (source?.sourceKind !== 'person-location' || !source.locationId)
      throw new Error('The first publication must expose a committed saved-location draft.');

    // The first transaction consumed the allocation. A later PATCH uses the
    // current draft witness and publishes through the adapter after its own commit.
    await runPreparedDraftSettingsMutation(
      id,
      { ...source, sourceKind: 'person-location', locationId: source.locationId },
      async () => {
        await prepareOpenCodeSettingsUpdate(
          local,
          id,
          { model: 'successor' },
          settings,
          ownsUnboundIdentity
        );
        await settings.saveSessionSettings(id, { model: 'successor' });
      }
    );
    return { firstRow, source };
  });

  const save = settings.saveSessionSettings.bind(settings);
  vi.spyOn(settings, 'saveSessionSettings').mockImplementation(async (...args) => {
    await save(...args);
    // Hold the older caller at the port boundary until the real subscriber's
    // write completes, so any replay after that await would overwrite its winner.
    if (args[1].model === 'first') await successor;
  });
  try {
    const first = runPreparedSettingsMutation(id, birth, async () => {
      await prepareOpenCodeSettingsUpdate(
        local,
        id,
        { cwd: '/project', model: 'first' },
        settings,
        ownsUnboundIdentity
      );
      await settings.saveSessionSettings(id, { model: 'first' });
    });
    const [, { firstRow, source }] = await Promise.all([first, successor]);
    expect((await events.next()).value).toMatchObject({
      type: 'session_upserted',
      session: { id, cwd: '/project', model: 'successor' },
    });
    await expect(save(id, { model: 'unprepared' })).rejects.toMatchObject({
      code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE',
    });
    expect(row()).toEqual({ ...firstRow, model: 'successor' });
    expect(local.get(id)?.model).toBe('successor');
    expect(readDraftSource(db, id)).toEqual(source);
    expect(allocations()).toEqual([]);
    expect(provider.getClient).not.toHaveBeenCalled();
  } finally {
    await events.return?.();
  }
});

it('refuses a durable binding written by another store after this runtime hydrated', async () => {
  const runtime = new OpenCodeRuntime({ provider, sessionMap: map });
  runtime.setSessionSettings(settings);
  const beforeAllocation = allocations();
  new OpenCodeSessionMap(db).bind(id, 'late-durable-native');
  expect(mapper.getOpenCodeSessionId(id)).toBeUndefined();
  await expect(
    runPreparedSettingsMutation(id, birth, () => runtime.updateSession(id, { model: 'fresh' }))
  ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(row()).toBeUndefined();
  expect(allocations()).toEqual(beforeAllocation);
  expect(runtime.hasSession(id)).toBe(false);
  expect(map.readBinding(id)).toEqual({ ocSessionId: 'late-durable-native' });
  expect(provider.getClient).not.toHaveBeenCalled();
});

it('rechecks durable absence after an actual hydration await without publishing a birth', async () => {
  const runtime = new OpenCodeRuntime({ provider, sessionMap: map });
  runtime.setSessionSettings(settings);
  const get = settings.getSessionSettings.bind(settings);
  const beforeAllocation = allocations();
  vi.spyOn(settings, 'getSessionSettings').mockImplementation(async (sessionId) => {
    const result = await get(sessionId);
    new OpenCodeSessionMap(db).bind(id, 'during-hydration-native');
    return result;
  });
  await expect(
    runPreparedSettingsMutation(id, birth, () => runtime.updateSession(id, { model: 'fresh' }))
  ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(row()).toBeUndefined();
  expect(allocations()).toEqual(beforeAllocation);
  expect(runtime.hasSession(id)).toBe(false);
  expect(mapper.getOpenCodeSessionId(id)).toBeUndefined();
  expect(map.readBinding(id)).toEqual({ ocSessionId: 'during-hydration-native' });
  expect(provider.getClient).not.toHaveBeenCalled();
});

it('refuses a replaced settings port before either actual writer changes the row, then accepts a new original-port attempt', async () => {
  const runtime = new OpenCodeRuntime({ provider, sessionMap: map });
  runtime.setSessionSettings(settings);
  const replacement = new RuntimeRegistry();
  replacement.setDb(db);
  const replacementWrite = vi.spyOn(replacement, 'saveSessionSettings');
  const beforeAllocation = allocations();
  const beforeRow = row();
  const get = settings.getSessionSettings.bind(settings);
  const load = vi.spyOn(settings, 'getSessionSettings').mockImplementation(async (sessionId) => {
    const result = await get(sessionId);
    runtime.setSessionSettings(replacement);
    return result;
  });
  await expect(
    runPreparedSettingsMutation(id, birth, () => runtime.updateSession(id, { model: 'stale-port' }))
  ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
  expect(replacementWrite).not.toHaveBeenCalled();
  expect(row()).toEqual(beforeRow);
  expect(allocations()).toEqual(beforeAllocation);
  expect(runtime.hasSession(id)).toBe(false);
  expect(provider.getClient).not.toHaveBeenCalled();
  load.mockRestore();
  runtime.setSessionSettings(settings);
  // This is a separate intentional attempt with the still-current original port and allocation.
  await expect(
    runPreparedSettingsMutation(id, birth, () =>
      runtime.updateSession(id, { model: 'new-attempt' })
    )
  ).resolves.toEqual({ updated: true });
  expect(row()).toMatchObject({ model: 'new-attempt', modelLaunchState: 'pending-v1' });
  expect(allocations()).toEqual([]);
  expect(runtime.hasSession(id)).toBe(true);
  expect(replacementWrite).not.toHaveBeenCalled();
  expect(provider.getClient).not.toHaveBeenCalled();
});
