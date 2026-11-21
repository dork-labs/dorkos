/** First send through the real person cookie, saved-location route and runtime binder. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  eq,
  sessionBirthAllocations,
  sessionLocations,
  sessionMessageQueue,
  sessionMetadata,
  sessionNativeBindings,
} from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { initBoundary } from '../../lib/boundary.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { SessionBirthWriteError } from '../../services/core/runtime-seam/session-birth-write.js';
import {
  onDispatchLifecycle,
  resetMessageDispatcher,
} from '../../services/session/message-dispatcher.js';
import {
  MessageQueueStore,
  setMessageQueueStore,
} from '../../services/session/message-queue-store.js';
import { disposeProjector } from '../../services/session/session-state-projector.js';
import { createSessionLocationsRoutes } from '../session-locations.js';
import { createSessionRoutes } from '../sessions.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

let root: string | undefined;
let cwd: string;
const ids = new Set<string>();
const runtime = new FakeAgentRuntime('opencode');
const mintChatId = vi.fn(() => randomUUID());
async function* reply(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'Owned fixture reply' } };
  yield { type: 'done', data: {} };
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'person-location-first-send-')));
  cwd = join(root, 'project');
  const home = join(root, 'home');
  const dorkHome = join(root, 'dork-home');
  await Promise.all([cwd, home, dorkHome].map((dir) => mkdir(dir, { mode: 0o700 })));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('DORK_HOME', dorkHome);
  vi.stubEnv('BETTER_AUTH_SECRET', undefined);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  await initBoundary(root);
});

const harness = frontDoorStepUpHarness(() => {
  const db = harness.db();
  runtime.withScenarios([reply, reply]);
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault('opencode');
  setMessageQueueStore(new MessageQueueStore(db));
  return [
    { path: '/api/session-locations', routes: createSessionLocationsRoutes(db, { mintChatId }) },
    { path: '/api/sessions', routes: createSessionRoutes({ personBirthDb: db }) },
  ];
});

afterAll(async () => {
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  for (const id of ids) disposeProjector(id);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

function row(id: string) {
  return harness.db().select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get();
}

function send(id: string) {
  ids.add(id);
  return harness
    .call('post', `/api/sessions/${id}/messages`)
    .send({ content: 'Owned first-send fixture', create: true, cwd, runtime: 'opencode' });
}

it('binds the acknowledged person location on the first authenticated send', async () => {
  const location = await harness.call('post', '/api/session-locations').send({ cwd });
  expect(location.status).toBe(201);
  const ownedLocation = harness
    .db()
    .select()
    .from(sessionLocations)
    .where(eq(sessionLocations.id, location.body.id))
    .get();
  expect(ownedLocation).toMatchObject({ cwd, ownerId: expect.any(String) });
  if (!ownedLocation) throw new Error('Expected an actual owned location');
  const settled = vi.fn();
  const stop = onDispatchLifecycle((event) => {
    if (event.phase === 'settled') settled(event);
  });
  try {
    const legacy = randomUUID();
    const legacyReply = await send(legacy);
    expect(legacyReply.status).toBe(202);
    expect(legacyReply.body).toMatchObject({
      sessionId: legacy,
      outcome: { requested: 'queue', applied: 'queue' },
    });
    await vi.waitFor(() =>
      expect(settled).toHaveBeenCalledWith(expect.objectContaining({ sessionId: legacy }))
    );
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    const legacyRow = row(legacy);
    expect(legacyRow).toMatchObject({
      runtime: 'opencode',
      launchOrigin: 'interactive',
      modelLaunchState: null,
    });
    if (!legacyRow) throw new Error('Expected the ordinary runtime bind');

    const ack = await harness
      .call('post', `/api/session-locations/${location.body.id}/chats`)
      .send({});
    expect(ack.status).toBe(201);
    expect(ack.body).toEqual({ sessionId: expect.any(String), launchRef: location.body.id });
    const acknowledged = ack.body.sessionId as string;
    expect(row(acknowledged)).toBeUndefined();
    const bind = runtimeRegistry.persistSessionRuntime.bind(runtimeRegistry);
    let refusal: string | undefined;
    const probe = vi
      .spyOn(runtimeRegistry, 'persistSessionRuntime')
      .mockImplementationOnce(async (...args) => {
        try {
          return await bind(...args);
        } catch (error) {
          if (error instanceof SessionBirthWriteError) refusal = error.reason;
          throw error;
        }
      });

    const result = await send(acknowledged);
    expect(probe).toHaveBeenCalledTimes(1);
    const currentAllocation = harness
      .db()
      .select()
      .from(sessionBirthAllocations)
      .where(eq(sessionBirthAllocations.sessionId, acknowledged))
      .get();
    expect({
      status: result.status,
      refusal,
      runtimeCallsOnRefusal: refusal ? runtime.sendMessage.mock.calls.length : undefined,
      stillAllocated: currentAllocation !== undefined,
      modelLaunchState: row(acknowledged)?.modelLaunchState,
    }).toEqual({
      status: 202,
      refusal: undefined,
      runtimeCallsOnRefusal: undefined,
      stillAllocated: false,
      modelLaunchState: 'pending-v1',
    });
    expect(result.body).toMatchObject({
      sessionId: acknowledged,
      outcome: { requested: 'queue', applied: 'queue' },
    });
    await vi.waitFor(() =>
      expect(settled).toHaveBeenCalledWith(expect.objectContaining({ sessionId: acknowledged }))
    );
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(row(acknowledged)).toMatchObject({
      runtime: legacyRow.runtime,
      agentPath: legacyRow.agentPath,
      launchOrigin: legacyRow.launchOrigin,
      permissionMode: legacyRow.permissionMode,
      model: legacyRow.model,
      effort: legacyRow.effort,
      fastMode: legacyRow.fastMode,
    });
  } finally {
    stop();
  }
});

it('allocates distinct inert chats from one authenticated saved folder', async () => {
  if (!root) throw new Error('Expected the owned test root');
  const folder = join(root, 'allocator-project');
  await mkdir(folder, { mode: 0o700 });
  const created = await harness.call('post', '/api/session-locations').send({ cwd: folder });
  expect(created.status).toBe(201);
  expect(created.body).toEqual({
    id: expect.stringMatching(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
  });
  const ref = created.body.id;
  const repeated = await harness.call('post', '/api/session-locations').send({ cwd: folder });
  expect(repeated.status).toBe(200);
  expect(repeated.body).toEqual(created.body);
  const lookup = await harness.call('get', `/api/session-locations/${ref}`);
  expect(lookup.status).toBe(200);
  expect(lookup.body).toEqual({ cwd: folder });

  const db = harness.db();
  const location = db.select().from(sessionLocations).where(eq(sessionLocations.id, ref)).get();
  if (!location) throw new Error('Expected the real saved location');
  const allocate = (body: object) =>
    harness.call('post', `/api/session-locations/${ref}/chats`).send(body);
  const state = () => ({
    metadata: db.select().from(sessionMetadata).all(),
    native: db.select().from(sessionNativeBindings).all(),
    queue: db.select().from(sessionMessageQueue).all(),
    calls: runtime.sendMessage.mock.calls.length,
  });
  const before = state();
  const first = await allocate({});
  expect(first.status).toBe(201);
  const concurrent = await Promise.all([allocate({}), allocate({})]);
  const acknowledgements = [first, ...concurrent];
  const chatIds = acknowledgements.map(({ status, body }) => {
    expect(status).toBe(201);
    expect(body).toEqual({
      sessionId: expect.stringMatching(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
      launchRef: ref,
    });
    expect(body.sessionId).not.toBe(ref);
    return body.sessionId;
  });
  expect(new Set(chatIds).size).toBe(3);

  const allocations = () =>
    db
      .select()
      .from(sessionBirthAllocations)
      .where(eq(sessionBirthAllocations.locationId, ref))
      .all();
  const createdAllocations = allocations();
  expect(createdAllocations).toHaveLength(3);
  for (const sessionId of chatIds) {
    expect(createdAllocations.find((entry) => entry.sessionId === sessionId)).toMatchObject({
      sessionId,
      ownerId: location.ownerId,
      locationId: ref,
      sourceKind: 'person-location',
      version: 1,
      createdAt: expect.any(String),
      registeredAgentId: null,
      recordedRegisteredPath: null,
      internalSource: null,
    });
  }
  const extra = await allocate({ sessionId: randomUUID(), runtime: 'opencode' });
  expect(extra.status).toBe(400);
  expect(allocations()).toEqual(createdAllocations);
  expect(state()).toEqual(before);
  expect(db.select().from(sessionLocations).where(eq(sessionLocations.id, ref)).get()).toEqual(
    location
  );
  const after = await harness.call('get', `/api/session-locations/${ref}`);
  expect(after.status).toBe(200);
  expect(after.body).toEqual(lookup.body);
});

it('preserves the winning allocation and refuses inaccessible saved folders', async () => {
  if (!root) throw new Error('Expected the owned test root');
  const folder = join(root, 'allocator-refusal-project');
  await mkdir(folder, { mode: 0o700 });
  const saved = await harness.call('post', '/api/session-locations').send({ cwd: folder });
  expect(saved.status).toBe(201);
  const ref = saved.body.id;
  const db = harness.db();
  const location = db.select().from(sessionLocations).where(eq(sessionLocations.id, ref)).get();
  if (!location) throw new Error('Expected the actual saved location');
  const winner = randomUUID();
  db.insert(sessionBirthAllocations)
    .values({
      sessionId: winner,
      sourceKind: 'person-location',
      ownerId: location.ownerId,
      locationId: location.id,
      version: 1,
      createdAt: location.createdAt,
    })
    .run();
  const allocations = () => db.select().from(sessionBirthAllocations).all();
  const before = allocations();
  const foreign = randomUUID();
  db.insert(sessionLocations)
    .values({
      id: foreign,
      ownerId: 'other-fixture-owner',
      cwd: folder,
      createdAt: location.createdAt,
    })
    .run();
  const allocate = (id: string) =>
    harness.call('post', `/api/session-locations/${id}/chats`).send({});
  mintChatId.mockClear();
  expect((await allocate(foreign)).status).toBe(404);
  await initBoundary(cwd);
  try {
    expect((await allocate(ref)).status).toBe(403);
  } finally {
    await initBoundary(root);
  }
  expect(mintChatId).not.toHaveBeenCalled();

  mintChatId.mockReturnValueOnce(winner);
  const refused = await allocate(ref);
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ code: 'SESSION_ID_CONFLICT' });
  expect(refused.body).not.toHaveProperty('sessionId');
  expect(mintChatId).toHaveBeenCalledTimes(1);
  expect(allocations()).toEqual(before);
  expect(row(winner)).toBeUndefined();
});
