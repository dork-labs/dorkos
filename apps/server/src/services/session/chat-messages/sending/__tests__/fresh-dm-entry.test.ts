/** Fresh DM birth through the normal service, launch, runtime registry and replay owner. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, eq, runMigrations, sessionBirthAllocations, sessionMetadata } from '@dorkos/db';
import { MeshCore } from '@dorkos/mesh';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { initBoundary } from '../../../../../lib/boundary.js';
import { initConfigManager } from '../../../../core/config-manager.js';
import { runtimeRegistry } from '../../../../core/runtime-registry.js';
import {
  homeOf,
  resolveAgentHome,
  setAgentHomeRegistry,
} from '../../../../core/agent-identity/agent-home.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../../core/agent-identity/agent-identity-service.js';
import {
  AgentPauseService,
  initAgentPause,
  resetAgentPause,
} from '../../../../mesh/pause/agent-pause.js';
import {
  describeSessionFor,
  isSessionBusy,
  liveSessionCwd,
  resumeChatQueueFor,
} from '../../../../extensions/agent-send/agent-send-defaults.js';
import {
  onDispatchLifecycle,
  resetMessageDispatcher,
  setQueuedChatCeilingResolver,
  setQueuedChatHoldResolver,
  setQueuedChatWordsResolver,
} from '../../../message-dispatcher.js';
import { rearmChatQueues } from '../../../message-dispatcher/queue-upkeep.js';
import { MessageQueueStore, setMessageQueueStore } from '../../../message-queue-store.js';
import { disposeProjector } from '../../../session-state-projector.js';
import { passedOnLevelOf } from '../../../../core/turn-power/turn-levels.js';
import { chatCallerOf } from '../../chat-capabilities.js';
import { chatClientId } from '../../chat-client-id.js';
import { rowsCarryHold, rowsCarryWords } from '../../chat-message-ceiling.js';
import { ChatMessageService, type ChatCaller } from '../../chat-message-service.js';
import { ChatMessageStore } from '../../chat-message-store.js';
import {
  canonicalChatId,
  chatTitleOf,
  emitChatActivity,
  interruptChatTurn,
  steerChatTurn,
} from '../../chat-message-wiring.js';

const operator = { kind: 'person', accountId: 'fixture-owner', name: 'Fixture owner' } as const;
let root: string;
let db: ReturnType<typeof createDb>;
let mesh: MeshCore;
let runtime: FakeAgentRuntime;
let queue: MessageQueueStore;
let store: ChatMessageStore;
let service: ChatMessageService;
let opened = false;
let pauses: AgentPauseService;
let caller: ChatCaller;
let senderAgentId: string;
let recipient: { id: string; path: string };
const projectors = new Set<string>();

function git(cwd: string, ...args: string[]) {
  const path = process.env.PATH;
  if (!path) throw new Error('Missing Git tool path for owned worktree fixture');
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      timeout: 10_000,
      stdio: 'pipe',
      env: {
        PATH: path,
        LANG: 'C',
        HOME: join(root, 'home'),
        USERPROFILE: join(root, 'home'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(root, 'home', '.gitconfig'),
        GIT_TEMPLATE_DIR: join(root, 'git-template'),
      },
    }
  );
}

function open(migrate: boolean) {
  db = createDb(join(root, 'fixture.sqlite'));
  if (migrate) runMigrations(db);
  mesh = new MeshCore({ db, defaultScanRoot: root });
  setAgentHomeRegistry({
    isRegisteredHome: (path) => mesh.getByPath(path) !== undefined,
    listRegisteredHomes: () => mesh.listWithPaths().map((agent) => agent.projectPath),
    managedWorkspaceOwner: () => null,
    roomsDir: null,
  });
  runtime = new FakeAgentRuntime('opencode');
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault('opencode');
  pauses = new AgentPauseService({ db });
  initAgentPause(pauses);
  queue = new MessageQueueStore(db);
  setMessageQueueStore(queue);
  store = new ChatMessageStore(db);
  service = new ChatMessageService({
    store,
    meshCore: () => mesh,
    describeSession: describeSessionFor(undefined),
    chatTitle: chatTitleOf,
    sessionCwd: liveSessionCwd,
    isBusy: isSessionBusy,
    canonicalId: canonicalChatId,
    turnLevelOf: passedOnLevelOf,
    emitActivity: emitChatActivity,
    interruptTurn: interruptChatTurn,
    steerInto: steerChatTurn,
  });
  setQueuedChatCeilingResolver((id) => service.ceilingForQueuedMessage(id));
  setQueuedChatHoldResolver((id) => rowsCarryHold(store.listByQueueMessage(id)));
  setQueuedChatWordsResolver((id) => rowsCarryWords(store.listByQueueMessage(id)));
  opened = true;
}

function close() {
  if (!opened) return;
  opened = false;
  service.stop();
  setQueuedChatCeilingResolver(undefined);
  setQueuedChatHoldResolver(undefined);
  setQueuedChatWordsResolver(undefined);
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  for (const id of projectors) disposeProjector(id);
  projectors.clear();
  resetAgentPause();
  resetAgentIdentityService();
  setAgentHomeRegistry(undefined);
  mesh.close();
  db.$client.close();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), '1692-fresh-dm-entry-')));
  const home = join(root, 'home');
  const data = join(root, 'data');
  const sender = join(root, 'sender');
  const receiver = join(root, 'receiver');
  const worktree = join(root, 'sender-worktree');
  await Promise.all(
    [home, data, sender, receiver, join(root, 'git-template')].map((path) =>
      mkdir(path, { mode: 0o700 })
    )
  );
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('DORK_HOME', data);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(home, '.gitconfig'));
  initConfigManager(data);
  await initBoundary(root);
  git(sender, 'init', '-q', '-b', 'main');
  git(sender, 'commit', '-q', '--allow-empty', '-m', 'Owned fixture');
  git(sender, 'worktree', 'add', '-q', '-b', 'owned-worktree', worktree);
  open(true);
  const registered = await mesh.registerByPath(sender, { name: 'Sender', runtime: 'opencode' });
  senderAgentId = registered.id;
  const target = await mesh.registerByPath(receiver, { name: 'Receiver', runtime: 'opencode' });
  recipient = { id: target.id, path: receiver };
  expect(resolveAgentHome(worktree)).toMatchObject({
    kind: 'home',
    home: sender,
    via: 'linked-worktree',
  });
  const senderHome = homeOf(resolveAgentHome(worktree));
  if (!senderHome) throw new Error('Expected a verified sender home');
  const identityService = initAgentIdentityService(db);
  const token = await identityService.mint({ agentPath: senderHome, displayName: 'Sender' });
  const identity = await identityService.resolve(token);
  if (!identity) throw new Error('The actual identity store did not resolve the token');
  const sessionId = randomUUID();
  expect(
    await runtimeRegistry.persistSessionRuntime(
      sessionId,
      'opencode',
      { kind: 'interactive' },
      senderHome
    )
  ).toBe(true);
  expect(await runtimeRegistry.getSessionAgentPath(sessionId)).toBe(senderHome);
  const verified = chatCallerOf({ sessionId, identity });
  if (!verified) throw new Error('Expected the tool handler to resolve the caller');
  caller = verified;
});

afterEach(async () => {
  try {
    close();
  } finally {
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function metadata(id: string) {
  return db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get();
}
function allocations() {
  return db.select().from(sessionBirthAllocations).all();
}
function saved(id: string) {
  const receipt = store.get(id);
  if (!receipt) throw new Error('Expected an actual durable receipt');
  return receipt;
}
function resume() {
  const route = resumeChatQueueFor(() => mesh, undefined);
  return rearmChatQueues({ resume: (id) => route(id, undefined) });
}

it('binds a real fresh target from the verified sender and performs one scripted turn', async () => {
  const ended = vi.fn();
  const stop = onDispatchLifecycle((event) => {
    if (event.phase === 'settled') ended(event);
  });
  try {
    const sent = await service.send(caller, { to: recipient.id, message: 'Fixture fresh DM' });
    projectors.add(sent.chatId);
    await vi.waitFor(() =>
      expect(ended).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: sent.chatId,
          messageId: saved(sent.messageId).queueMessageId,
        })
      )
    );
    expect(saved(sent.messageId)).toMatchObject({
      fromSessionId: caller.sessionId,
      fromAgentPath: caller.agentPath,
      fromAgentId: senderAgentId,
      toSessionId: sent.chatId,
      deliveryRoute: 'chat',
    });
    expect(metadata(sent.chatId)).toMatchObject({
      agentPath: recipient.path,
      launchOrigin: 'chat-message',
      runtime: 'opencode',
      modelLaunchState: 'pending-v1',
    });
    expect(allocations()).toEqual([]);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});

it('keeps a receipt accepted by the dispatcher if remembering the direct chat fails', async () => {
  await pauses.pause(recipient.id, operator);
  const retire = vi.spyOn(store, 'deleteRejectedFreshDm');
  const keep = vi.spyOn(store, 'keepDmChat').mockImplementationOnce(() => {
    throw new Error('Fixture rejected the keep-DM write');
  });
  try {
    await expect(
      service.send(caller, { to: recipient.id, message: 'Accepted message' })
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(retire).not.toHaveBeenCalled();
    const [row] = store.listSentFrom(caller.sessionId);
    expect(row).toMatchObject({ status: 'queued', fromSessionId: caller.sessionId });
    expect(queue.list(row.toSessionId)).toMatchObject([{ id: row.queueMessageId }]);
    expect(metadata(row.toSessionId)).toMatchObject({
      launchOrigin: 'chat-message',
      modelLaunchState: 'pending-v1',
    });
    projectors.add(row.toSessionId);
  } finally {
    keep.mockRestore();
    retire.mockRestore();
  }
});

it('reopens an actually admitted fresh DM queue and adopts just its existing message', async () => {
  await pauses.pause(recipient.id, operator);
  const sent = await service.send(caller, { to: recipient.id, message: 'Fixture queued DM' });
  projectors.add(sent.chatId);
  expect(sent.status).toBe('queued');
  const original = saved(sent.messageId);
  const queued = queue.list(sent.chatId);
  expect(queued).toMatchObject([
    { id: original.queueMessageId, enqueuedBy: chatClientId(caller.sessionId) },
  ]);
  const bound = metadata(sent.chatId);
  expect(bound).toMatchObject({ modelLaunchState: 'pending-v1', agentPath: recipient.path });
  expect(allocations()).toEqual([]);
  expect(runtime.sendMessage).not.toHaveBeenCalled();
  close();
  open(false);

  expect(queue.list(sent.chatId)).toEqual(queued);
  expect(saved(sent.messageId)).toEqual(original);
  pauses.resume(recipient.id, operator);
  projectors.add(sent.chatId);
  const ended = vi.fn();
  const stop = onDispatchLifecycle((event) => {
    if (event.phase === 'settled') ended(event);
  });
  try {
    expect(await resume()).toBe(1);
    await vi.waitFor(() =>
      expect(ended).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: sent.chatId,
          messageId: original.queueMessageId,
        })
      )
    );
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(await resume()).toBe(0);
    expect(queue.list(sent.chatId)).toEqual([]);
    expect(metadata(sent.chatId)).toEqual(bound);
    expect(allocations()).toEqual([]);
  } finally {
    stop();
  }
});

it('does not admit a committed receipt without a dispatcher queue after reopen', async () => {
  const { row, birth } = store.insertFreshDm(
    {
      id: randomUUID(),
      toSessionId: randomUUID(),
      fromSessionId: caller.sessionId,
      fromAgentPath: caller.agentPath,
      fromAgentId: senderAgentId,
      fromAgentName: 'Sender',
      fromChatTitle: null,
      kind: 'message',
      text: 'Never admitted',
      summary: null,
      nonce: 'abcdef0123456789',
      delivery: 'queue',
      status: 'queued',
      queueMessageId: randomUUID(),
      ceilingJson: JSON.stringify('runtime-default'),
      replyToId: null,
    },
    recipient
  );
  const held = allocations();
  expect(held).toMatchObject([
    { sessionId: row.toSessionId, createdAt: birth.allocationCreatedAt },
  ]);
  expect(metadata(row.toSessionId)).toBeUndefined();
  close();
  open(false);

  expect(await resume()).toBe(0);
  expect(queue.list(row.toSessionId)).toEqual([]);
  expect(saved(row.id)).toEqual(row);
  expect(allocations()).toEqual(held);
  expect(metadata(row.toSessionId)).toBeUndefined();
  expect(runtime.sendMessage).not.toHaveBeenCalled();
});
