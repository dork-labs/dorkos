/** Cold settings through the real owner front door, runtime adapters and SQLite settings writer. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  onDispatchLifecycle,
  resetMessageDispatcher,
} from '../../services/session/message-dispatcher.js';
import {
  MessageQueueStore,
  setMessageQueueStore,
} from '../../services/session/message-queue-store.js';
import { disposeProjector } from '../../services/session/session-state-projector.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  eq,
  sessionBirthAllocations,
  sessionDraftSources,
  sessionLocations,
  sessionMessageQueue,
  sessionMetadata,
  sessionNativeBindings,
} from '@dorkos/db';
import { initBoundary } from '../../lib/boundary.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { SessionBirthWriteError } from '../../services/core/runtime-seam/session-birth-write.js';
import {
  createChatRiseFacts,
  setChatRiseFacts,
} from '../../services/core/turn-power/chat-rise-facts.js';
import { coldSettingsQuery } from '../../services/runtimes/claude-code/__tests__/cold-settings-sdk.js';
import { ClaudeCodeRuntime } from '../../services/runtimes/claude-code/claude-code-runtime.js';
import { OpenCodeRuntime } from '../../services/runtimes/opencode/opencode-runtime.js';
import { OpenCodeSessionMap } from '../../services/runtimes/opencode/sessions/session-map.js';
import { createSessionLocationsRoutes } from '../session-locations.js';
import { createSessionRoutes } from '../sessions.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const query = coldSettingsQuery();
let root: string | undefined;
let cwd: string;
let dorkHome: string;
const dispatchedIds = new Set<string>();
const getClient = vi.fn(async () => {
  throw new Error('Cold settings must not open a sidecar');
});

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'person-location-draft-settings-')));
  cwd = join(root, 'project');
  const home = join(root, 'home');
  dorkHome = join(root, 'dork-home');
  await Promise.all([cwd, home, dorkHome].map((dir) => mkdir(dir, { mode: 0o700 })));
  // Keep real CLI lookup on a non-executable file owned by this fixture.
  const cliPath = join(dorkHome, 'unused-claude-cli');
  await writeFile(cliPath, '', { mode: 0o600 });
  vi.stubEnv('DORKOS_CLAUDE_CLI_PATH', cliPath);
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
  const runtime = new OpenCodeRuntime({
    modelDirectory: cwd,
    sessionMap: new OpenCodeSessionMap(db),
    provider: { getClient, peekClient: () => null },
  });
  runtimeRegistry.setDb(db);
  runtime.setSessionSettings(runtimeRegistry);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault('opencode');
  setChatRiseFacts(createChatRiseFacts(db));
  setMessageQueueStore(new MessageQueueStore(db));
  return [
    { path: '/api/session-locations', routes: createSessionLocationsRoutes(db) },
    { path: '/api/sessions', routes: createSessionRoutes({ personBirthDb: db }) },
  ];
});

afterAll(async () => {
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  for (const id of dispatchedIds) disposeProjector(id);
  setChatRiseFacts(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

function patch(id: string) {
  return harness
    .call('patch', `/api/sessions/${id}?cwd=${encodeURIComponent(cwd)}`)
    .send({ runtime: 'opencode', permissionMode: 'default', fastMode: false, effort: 'high' });
}

function read(id: string) {
  const db = harness.db();
  return {
    metadata:
      db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get() ?? null,
    allocation:
      db
        .select()
        .from(sessionBirthAllocations)
        .where(eq(sessionBirthAllocations.sessionId, id))
        .get() ?? null,
    source:
      db.select().from(sessionDraftSources).where(eq(sessionDraftSources.sessionId, id)).get() ??
      null,
    queue: db.select().from(sessionMessageQueue).where(eq(sessionMessageQueue.sessionId, id)).all(),
    native: db
      .select()
      .from(sessionNativeBindings)
      .where(eq(sessionNativeBindings.sessionId, id))
      .all(),
  };
}

const explicit = {
  permissionMode: 'default',
  permissionModeByPerson: true,
  fastMode: false,
  effort: null,
  model: null,
  runtime: null,
};

it('keeps the ordinary unallocated picker write and its unbound receipt', async () => {
  const id = randomUUID();
  expect(read(id)).toEqual({
    metadata: null,
    allocation: null,
    source: null,
    queue: [],
    native: [],
  });
  const reply = await patch(id);
  expect(reply.status).toBe(200);
  expect(reply.body).toMatchObject({
    id,
    runtime: 'opencode',
    runtimeUnbound: true,
    permissionMode: 'default',
  });
  expect(read(id)).toMatchObject({
    metadata: { ...explicit, modelLaunchState: null },
    allocation: null,
    source: null,
    queue: [],
    native: [],
  });
  expect(getClient).not.toHaveBeenCalled();
});

async function allocateSavedChat() {
  const db = harness.db();
  const location = await harness.call('post', '/api/session-locations').send({ cwd });
  expect([200, 201]).toContain(location.status);
  const saved = db
    .select()
    .from(sessionLocations)
    .where(eq(sessionLocations.id, location.body.id))
    .get();
  if (!saved) throw new Error('Expected a real owner-saved location');
  const ack = await harness.call('post', `/api/session-locations/${saved.id}/chats`).send({});
  expect(ack.status).toBe(201);
  expect(ack.body).toMatchObject({ launchRef: saved.id, sessionId: expect.any(String) });
  const id: string = ack.body.sessionId;
  return { id, saved };
}

it('transfers the acknowledged saved-folder birth on an explicit PATCH before any send', async () => {
  const { id, saved } = await allocateSavedChat();
  expect(read(id)).toMatchObject({
    metadata: null,
    allocation: {
      sessionId: id,
      ownerId: saved.ownerId,
      locationId: saved.id,
      sourceKind: 'person-location',
    },
    source: null,
    queue: [],
    native: [],
  });

  const refusals: string[] = [];
  const save = runtimeRegistry.saveSessionSettings.bind(runtimeRegistry);
  const observe = vi
    .spyOn(runtimeRegistry, 'saveSessionSettings')
    .mockImplementation(async (...args) => {
      try {
        await save(...args);
      } catch (error) {
        if (error instanceof SessionBirthWriteError) refusals.push(error.reason);
        throw error;
      }
    });
  try {
    const reply = await patch(id);
    expect(getClient).not.toHaveBeenCalled();
    expect({ status: reply.status, refusals, state: read(id) }).toMatchObject({
      status: 200,
      refusals: [],
      state: {
        metadata: { ...explicit, modelLaunchState: 'pending-v1' },
        allocation: null,
        source: {
          sessionId: id,
          ownerId: saved.ownerId,
          sourceKind: 'person-location',
          locationId: saved.id,
          registeredAgentId: null,
          sourcePath: saved.cwd,
          sourceCreatedAt: saved.createdAt,
        },
        queue: [],
        native: [],
      },
    });
    expect(reply.body).toMatchObject({
      id,
      runtime: 'opencode',
      runtimeUnbound: true,
      permissionMode: 'default',
    });
  } finally {
    observe.mockRestore();
  }
});

it('updates only explicitly supplied settings on an acknowledged draft without replacing its provenance', async () => {
  const { id } = await allocateSavedChat();
  expect((await patch(id)).status).toBe(200);
  const before = read(id);
  expect(before).toMatchObject({
    metadata: { ...explicit, modelLaunchState: 'pending-v1' },
    allocation: null,
    source: { sourceKind: 'person-location' },
    queue: [],
    native: [],
  });
  const reply = await harness
    .call('patch', `/api/sessions/${id}?cwd=${encodeURIComponent(cwd)}`)
    .send({ fastMode: true });
  expect(reply.status).toBe(200);
  expect(reply.body).toMatchObject({ id, runtime: 'opencode', runtimeUnbound: true });
  expect(read(id)).toEqual({ ...before, metadata: { ...before.metadata, fastMode: true } });
  expect(getClient).not.toHaveBeenCalled();
});

it('refuses a repeat write after the saved location no longer matches its durable generation', async () => {
  const { id, saved } = await allocateSavedChat();
  expect((await patch(id)).status).toBe(200);
  const before = read(id);
  expect(before.source).toMatchObject({ sourceCreatedAt: saved.createdAt });
  // Represent replacement between requests at the actual SQLite source, without
  // inventing a public location-delete API or changing the proven draft.
  harness
    .db()
    .update(sessionLocations)
    .set({ createdAt: '2000-01-01T00:00:00.000Z' })
    .where(eq(sessionLocations.id, saved.id))
    .run();
  try {
    const reply = await harness
      .call('patch', `/api/sessions/${id}?cwd=${encodeURIComponent(cwd)}`)
      .send({ fastMode: true });
    expect(getClient).not.toHaveBeenCalled();
    expect({ refused: reply.status >= 400 && reply.status < 500, state: read(id) }).toEqual({
      refused: true,
      state: before,
    });
  } finally {
    harness
      .db()
      .update(sessionLocations)
      .set({ createdAt: saved.createdAt })
      .where(eq(sessionLocations.id, saved.id))
      .run();
  }
});

it('preserves a mounted draft through a source change during first send and claims it on retry', async () => {
  const { id, saved } = await allocateSavedChat();
  const locationId = saved.id;
  expect((await patch(id)).status).toBe(200);
  const before = read(id);
  expect(before).toMatchObject({
    allocation: null,
    source: { sessionId: id, locationId },
    metadata: { runtime: null, modelLaunchState: 'pending-v1', fastMode: false },
  });

  // The dispatcher, registry, and owned source remain real. Only the model turn is scripted.
  const scripted = new FakeAgentRuntime('test-mode');
  scripted.withScenarios([
    async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'done', data: {} };
    },
  ]);
  scripted.getInternalSessionId.mockReturnValue(undefined);
  runtimeRegistry.register(scripted);
  dispatchedIds.add(id);
  const send = () =>
    harness.call('post', '/api/sessions/' + id + '/messages').send({
      content: 'Owned saved-folder first send',
      create: true,
      runtime: 'test-mode',
    });
  const db = harness.db();
  const seen: { id: string; runtime: string }[] = [];
  db.$client.function('record_saved_folder_claim', (sessionId: string, runtime: string) => {
    seen.push({ id: sessionId, runtime });
    return 1;
  });
  db.$client.exec(`
    CREATE TEMP TRIGGER change_saved_folder_at_claim AFTER UPDATE OF runtime ON session_metadata
    WHEN NEW.session_id = '${id}'
    BEGIN
      SELECT record_saved_folder_claim(NEW.session_id, NEW.runtime);
      UPDATE session_locations SET created_at = 'changed-in-fixture'
      WHERE id = (SELECT location_id FROM session_draft_sources WHERE session_id = NEW.session_id);
    END
  `);
  try {
    const refused = await send();
    expect(seen).toEqual([{ id, runtime: 'test-mode' }]);
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(read(id)).toEqual(before);
    expect(
      db.select().from(sessionLocations).where(eq(sessionLocations.id, locationId)).get()?.createdAt
    ).toBe(before.source?.sourceCreatedAt);
    expect(scripted.sendMessage).not.toHaveBeenCalled();
  } finally {
    db.$client.exec('DROP TRIGGER change_saved_folder_at_claim');
  }

  const settled = vi.fn();
  const stop = onDispatchLifecycle((event) => {
    if (event.phase === 'settled' && event.sessionId === id) settled();
  });
  try {
    const accepted = await send();
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ sessionId: id });
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(scripted.sendMessage).toHaveBeenCalledTimes(1);
    expect(read(id)).toMatchObject({
      allocation: null,
      source: null,
      metadata: {
        runtime: 'test-mode',
        modelLaunchState: 'pending-v1',
        launchOrigin: 'interactive',
        permissionModeByPerson: true,
        fastMode: false,
      },
    });
  } finally {
    stop();
  }
});

it('uses registered Claude for the cold write even when the picker supplies an OpenCode hint', async () => {
  const claude = new ClaudeCodeRuntime(dorkHome, cwd);
  claude.setSessionSettings(runtimeRegistry);
  // These are external transcript observations. Keep the actual registry resolution,
  // Claude settings store and post-write HTTP reply path in the fixture.
  const find = vi.spyOn(claude, 'findSession').mockResolvedValue(null);
  vi.spyOn(claude, 'getSession').mockResolvedValue(null);
  runtimeRegistry.register(claude);

  const legacyId = randomUUID();
  const control = await patch(legacyId);
  expect(control.status).toBe(200);
  expect(control.body).toMatchObject({
    id: legacyId,
    runtime: 'claude-code',
    runtimeUnbound: true,
  });
  const claudeExplicit = { ...explicit, effort: 'high' };
  expect(read(legacyId).metadata).toMatchObject({ ...claudeExplicit, modelLaunchState: null });

  const { id, saved } = await allocateSavedChat();
  const refusals: string[] = [];
  const save = runtimeRegistry.saveSessionSettings.bind(runtimeRegistry);
  const observe = vi
    .spyOn(runtimeRegistry, 'saveSessionSettings')
    .mockImplementation(async (...args) => {
      try {
        await save(...args);
      } catch (error) {
        if (error instanceof SessionBirthWriteError) refusals.push(error.reason);
        throw error;
      }
    });
  try {
    const reply = await patch(id);
    expect(find).toHaveBeenCalledWith(id);
    expect(query).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
    expect({ status: reply.status, refusals, state: read(id) }).toMatchObject({
      status: 200,
      refusals: [],
      state: {
        metadata: { ...claudeExplicit, modelLaunchState: 'pending-v1' },
        allocation: null,
        source: {
          ownerId: saved.ownerId,
          locationId: saved.id,
          sourceCreatedAt: saved.createdAt,
          sourcePath: saved.cwd,
        },
        queue: [],
        native: [],
      },
    });
    expect(reply.body).toMatchObject({ id, runtime: 'claude-code', runtimeUnbound: true });
  } finally {
    observe.mockRestore();
  }
});
