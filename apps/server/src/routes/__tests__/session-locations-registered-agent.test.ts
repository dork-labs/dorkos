/** Registered-agent birth through the person front door, live Mesh and real settings writes. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  agents,
  eq,
  sessionBirthAllocations,
  sessionDraftSources,
  sessionMessageQueue,
  sessionMetadata,
  sessionNativeBindings,
} from '@dorkos/db';
import { MeshCore } from '@dorkos/mesh';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { ulid } from 'ulidx';
import { initBoundary } from '../../lib/boundary.js';
import { configManager } from '../../services/core/config-manager.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  createChatRiseFacts,
  setChatRiseFacts,
} from '../../services/core/turn-power/chat-rise-facts.js';
import { OpenCodeRuntime } from '../../services/runtimes/opencode/opencode-runtime.js';
import { OpenCodeSessionMap } from '../../services/runtimes/opencode/sessions/session-map.js';
import {
  onDispatchLifecycle,
  resetMessageDispatcher,
} from '../../services/session/message-dispatcher.js';
import {
  MessageQueueStore,
  setMessageQueueStore,
} from '../../services/session/message-queue-store.js';
import { disposeProjector } from '../../services/session/session-state-projector.js';
import {
  createWorkspaceSubsystem,
  setWorkspaceManager,
  type WorkspaceSubsystem,
} from '../../services/workspace/index.js';
import { createSessionLocationsRoutes } from '../session-locations.js';
import { createSessionRoutes } from '../sessions.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const projectKey = 'registered-agent';
const workspaceKey = 'ready-checkout';
const replacementGeneration = '2026-11-19T00:00:00.000Z';
let root: string;
let project: string;
let agentHome: string;
let outsideHome: string;
let dorkHome: string;
let mesh: MeshCore | undefined;
let workspaces: WorkspaceSubsystem;
const ids = new Set<string>();
const mintChatId = vi.fn((): string => randomUUID());
const scripted = new FakeAgentRuntime('test-mode');
const sidecar = vi.fn(async () => {
  throw new Error('The prepared settings test must not open a sidecar');
});

async function* reply(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'Registered agent fixture reply' } };
  yield { type: 'done', data: {} };
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'registered-agent-chat-')));
  project = join(root, 'project');
  agentHome = join(project, projectKey);
  outsideHome = join(root, 'outside-agent');
  dorkHome = join(root, 'dork-home');
  const home = join(root, 'home');
  await Promise.all(
    [agentHome, outsideHome, home, dorkHome].map((path) =>
      mkdir(path, { mode: 0o700, recursive: true })
    )
  );
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('DORK_HOME', dorkHome);
  vi.stubEnv('BETTER_AUTH_SECRET', undefined);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  await initBoundary(project);
});

const harness = frontDoorStepUpHarness(() => {
  const db = harness.db();
  mesh = new MeshCore({ db, defaultScanRoot: root });
  workspaces = createWorkspaceSubsystem({
    db,
    dorkHome,
    // The interactive launch checks the managed checkout against the project boundary.
    config: { ...configManager.get('workspace'), rootPath: join(project, 'workspaces') },
  });
  setWorkspaceManager(workspaces.service);
  const runtime = new OpenCodeRuntime({
    modelDirectory: agentHome,
    sessionMap: new OpenCodeSessionMap(db),
    provider: { getClient: sidecar, peekClient: () => null },
  });
  runtimeRegistry.setDb(db);
  runtime.setSessionSettings(runtimeRegistry);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault('opencode');
  scripted.getInternalSessionId.mockReturnValue(undefined);
  scripted.withScenarios([reply, reply, reply]);
  runtimeRegistry.register(scripted);
  setChatRiseFacts(createChatRiseFacts(db));
  setMessageQueueStore(new MessageQueueStore(db));
  return [
    {
      path: '/api/session-locations',
      routes: createSessionLocationsRoutes(db, { meshCore: mesh, mintChatId }),
    },
    { path: '/api/sessions', routes: createSessionRoutes({ personBirthDb: db, meshCore: mesh }) },
  ];
});

afterAll(async () => {
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  setChatRiseFacts(null);
  for (const id of ids) disposeProjector(id);
  mesh?.close();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

async function register(path = agentHome) {
  if (!mesh) throw new Error('Expected the live fixture Mesh');
  const agent = await mesh.registerByPath(path, { name: 'Fixture agent', runtime: 'opencode' });
  expect(mesh.getProjectPath(agent.id)).toBe(path);
  return agent;
}

function acknowledge(agentId: string, extras: Record<string, unknown> = {}) {
  return harness
    .call('post', '/api/session-locations/chats')
    .send({ kind: 'registered-agent', agentId, ...extras });
}

async function allocate(agentId: string): Promise<string> {
  const response = await acknowledge(agentId);
  expect(response.status).toBe(201);
  expect(response.body).toEqual({ sessionId: expect.any(String) });
  return response.body.sessionId;
}

function read(id: string) {
  const db = harness.db();
  return {
    allocation: db
      .select()
      .from(sessionBirthAllocations)
      .where(eq(sessionBirthAllocations.sessionId, id))
      .get(),
    metadata: db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get(),
    draft: db.select().from(sessionDraftSources).where(eq(sessionDraftSources.sessionId, id)).get(),
    native: db
      .select()
      .from(sessionNativeBindings)
      .where(eq(sessionNativeBindings.sessionId, id))
      .all(),
    queue: db.select().from(sessionMessageQueue).where(eq(sessionMessageQueue.sessionId, id)).all(),
  };
}

function patch(id: string, settings = { fastMode: false }, cwd = agentHome) {
  return harness.call('patch', `/api/sessions/${id}?cwd=${encodeURIComponent(cwd)}`).send(settings);
}

type FixtureSendOptions = { workspaceKey?: string; agentPath?: string | undefined };

function send(id: string, options: FixtureSendOptions = {}) {
  ids.add(id);
  return harness.call('post', `/api/sessions/${id}/messages`).send({
    create: true,
    content: 'Owned registered-agent fixture turn',
    runtime: 'test-mode',
    agentPath: agentHome,
    cwd: agentHome,
    ...options,
  });
}

function setRegistration(id: string, registeredAt: string): void {
  harness.db().update(agents).set({ registeredAt }).where(eq(agents.id, id)).run();
}

function changeRegistrationDuringWrite(
  id: string,
  agentId: string,
  write: 'INSERT' | 'UPDATE OF runtime'
) {
  const client = harness.db().$client;
  const reached = vi.fn(() => 1);
  client.function('record_registered_agent_write', reached);
  client.exec(`
    CREATE TEMP TRIGGER change_registration_during_write AFTER ${write} ON session_metadata
    WHEN NEW.session_id = '${id}'
    BEGIN
      SELECT record_registered_agent_write();
      UPDATE agents SET registered_at = '${replacementGeneration}' WHERE id = '${agentId}';
    END
  `);
  return { reached, drop: () => client.exec('DROP TRIGGER change_registration_during_write') };
}

async function sendAndSettle(id: string, options?: FixtureSendOptions) {
  const settled = vi.fn();
  const stop = onDispatchLifecycle((event) => {
    if (event.phase === 'settled' && event.sessionId === id) settled();
  });
  try {
    const response = await send(id, options);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ sessionId: id });
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  } finally {
    stop();
  }
}

it('acknowledges a registered home outside the saved-folder boundary without starting work', async () => {
  const agent = await register(outsideHome);
  expect(
    (await harness.call('post', '/api/session-locations').send({ cwd: outsideHome })).status
  ).toBe(403);
  expect((await acknowledge(agent.id, { cwd: outsideHome })).status).toBe(400);
  expect((await acknowledge(ulid())).status).toBe(404);
  const [first, second] = await Promise.all([allocate(agent.id), allocate(agent.id)]);
  expect(first).not.toBe(second);
  const firstAllocation = read(first).allocation;
  mintChatId.mockReturnValueOnce(first);
  expect((await acknowledge(agent.id)).status).toBe(409);
  expect(read(first).allocation).toEqual(firstAllocation);
  for (const id of [first, second]) {
    expect(read(id)).toMatchObject({
      allocation: {
        sessionId: id,
        ownerId: expect.any(String),
        sourceKind: 'person-agent',
        registeredAgentId: agent.id,
        recordedRegisteredPath: outsideHome,
        locationId: null,
        internalSource: null,
      },
      metadata: undefined,
      draft: undefined,
      native: [],
      queue: [],
    });
  }
  expect(scripted.sendMessage).not.toHaveBeenCalled();
  expect(sidecar).not.toHaveBeenCalled();
});

it('rolls back a reached first settings write when the observed registration is replaced', async () => {
  const agent = await register();
  const id = await allocate(agent.id);
  const before = read(id);
  const probe = changeRegistrationDuringWrite(id, agent.id, 'INSERT');
  try {
    expect((await patch(id)).status).toBe(404);
    expect(probe.reached).toHaveBeenCalledTimes(1);
    expect(read(id)).toEqual(before);
    expect(mesh?.get(agent.id)?.registeredAt).toBe(agent.registeredAt);
    expect(sidecar).not.toHaveBeenCalled();
  } finally {
    probe.drop();
  }

  // The acknowledgement holds the registered ID and path. Until a write
  // records a generation, rediscovering the same ID/path uses current Mesh.
  setRegistration(agent.id, replacementGeneration);
  try {
    expect((await patch(id)).status).toBe(200);
    expect(read(id)).toMatchObject({
      allocation: undefined,
      metadata: { runtime: null, modelLaunchState: 'pending-v1', fastMode: false },
      draft: {
        sessionId: id,
        sourceKind: 'person-agent',
        registeredAgentId: agent.id,
        sourcePath: agentHome,
        sourceCreatedAt: replacementGeneration,
      },
      native: [],
      queue: [],
    });
  } finally {
    setRegistration(agent.id, agent.registeredAt);
  }
});

it('refuses a stale draft, then claims the same id in its ordinary managed workspace', async () => {
  const agent = await register();
  const id = await allocate(agent.id);
  expect((await patch(id)).status).toBe(200);
  const original = read(id);
  expect((await patch(id, { fastMode: true })).status).toBe(200);
  const before = read(id);
  expect(before).toEqual({ ...original, metadata: { ...original.metadata, fastMode: true } });
  if (!before.draft) throw new Error('Expected a durable draft owner');
  const db = harness.db();
  const otherOwnerId = 'other-fixture-owner';
  db.update(sessionDraftSources)
    .set({ ownerId: otherOwnerId })
    .where(eq(sessionDraftSources.sessionId, id))
    .run();
  const turns = scripted.sendMessage.mock.calls.length;
  try {
    expect((await patch(id)).status).toBe(404);
    expect((await send(id)).status).toBe(404);
    expect(read(id)).toEqual({ ...before, draft: { ...before.draft, ownerId: otherOwnerId } });
    expect(scripted.sendMessage).toHaveBeenCalledTimes(turns);
  } finally {
    db.update(sessionDraftSources)
      .set({ ownerId: before.draft.ownerId })
      .where(eq(sessionDraftSources.sessionId, id))
      .run();
  }
  setRegistration(agent.id, replacementGeneration);
  try {
    expect((await patch(id)).status).toBe(404);
    expect((await send(id)).status).toBe(404);
    expect(read(id)).toEqual(before);
    expect(scripted.sendMessage).toHaveBeenCalledTimes(turns);
  } finally {
    setRegistration(agent.id, agent.registeredAt);
  }
  expect((await send(id, { agentPath: outsideHome })).status).toBe(404);

  const probe = changeRegistrationDuringWrite(id, agent.id, 'UPDATE OF runtime');
  try {
    expect((await send(id)).status).toBe(404);
    expect(probe.reached).toHaveBeenCalledTimes(1);
    expect(mesh?.get(agent.id)?.registeredAt).toBe(agent.registeredAt);
    expect(read(id)).toEqual(before);
    expect(scripted.sendMessage).toHaveBeenCalledTimes(turns);
  } finally {
    probe.drop();
  }

  const workspacePath = workspaces.store.checkoutPath(projectKey, workspaceKey);
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  await workspaces.store.write({
    id: randomUUID(),
    projectKey,
    key: workspaceKey,
    path: workspacePath,
    source: agentHome,
    branch: null,
    provider: 'worktree',
    status: 'ready',
    portBase: 42000,
    portBlockSize: 10,
    hostname: null,
    url: null,
    pinned: false,
    owner: null,
    createdAt: agent.registeredAt,
    lastUsedAt: agent.registeredAt,
  });
  await sendAndSettle(id, { workspaceKey, agentPath: undefined });
  expect(scripted.sendMessage).toHaveBeenCalledTimes(turns + 1);
  expect(scripted.sendMessage).toHaveBeenLastCalledWith(
    id,
    'Owned registered-agent fixture turn',
    expect.objectContaining({ cwd: workspacePath, forAgent: agentHome })
  );
  expect(read(id)).toMatchObject({
    allocation: undefined,
    draft: undefined,
    metadata: {
      runtime: 'test-mode',
      launchOrigin: 'interactive',
      modelLaunchState: 'pending-v1',
      agentPath: agentHome,
      fastMode: true,
    },
  });
  expect(sidecar).not.toHaveBeenCalled();
});

it('keeps legacy agent sends and binds the acknowledged owner when first send omits its path', async () => {
  const agent = await register();
  const legacyId = randomUUID();
  await sendAndSettle(legacyId);
  expect(read(legacyId).metadata).toMatchObject({
    agentPath: agentHome,
    runtime: 'test-mode',
    modelLaunchState: null,
  });

  const id = await allocate(agent.id);
  await sendAndSettle(id, { agentPath: undefined });
  expect(read(id)).toMatchObject({
    allocation: undefined,
    draft: undefined,
    metadata: {
      agentPath: agentHome,
      runtime: 'test-mode',
      launchOrigin: 'interactive',
      modelLaunchState: 'pending-v1',
    },
  });
});
