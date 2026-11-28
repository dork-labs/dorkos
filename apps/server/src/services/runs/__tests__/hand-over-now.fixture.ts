/**
 * The world `hand-over-now.test.ts` and `hand-over-now-chat.test.ts` run in
 * (spec `turns-survive-restarts` T6, T6b): the real launch path, dispatcher,
 * projector, SQLite queue and run record; only the runtime underneath is a
 * double, and the clock the record and outbox read is injected so the
 * worker's passes run one at a time. Chat messaging is wired as startup wires
 * it, over the run record's port.
 *
 * @module services/runs/__tests__/hand-over-now.fixture
 */
import { afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agents, sessionMetadata, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';
import type { StartTurnInput } from '@dorkos/shared/turn-port';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { initBoundary } from '../../../lib/boundary.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import { resetMessageDispatcher } from '../../session/message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../../session/message-queue-store.js';
import { disposeProjector } from '../../session/session-state-projector.js';
import {
  dispatchSessionMessage,
  type DispatchSessionMessageOpts,
} from '../../session/launch/launch-session.js';
import { agentLaunchMaxLive, claimCappedLaunch } from '../../session/launch/launch-cap.js';
import { createComputerTurnPort } from '../../session/turn-port/computer-turn-port.js';
import { isAgentLaunchCapFull } from '../../session/turn-port/index.js';
import { getRunRecord, installRunRecord, uninstallRunRecord, type RunRecord } from '../index.js';
import { registerClaudeCodeFacts } from '../../../startup/register-claude-code-facts.js';
import { ChatMessageStore } from '../../session/chat-messages/chat-message-store.js';
import {
  ChatMessageService,
  type ChatCaller,
  type ChatMessageServiceDeps,
} from '../../session/chat-messages/chat-message-service.js';

// What startup registers (DOR-4928): unregistered, the place rule refuses every folder.
registerClaudeCodeFacts();

/** A made-up agent, at home in a real folder: a person's send is checked against the boundary. */
export const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'hand-over-now-')));
export const AGENT = { id: '01KHANDQVERAGENT0000000000', home: join(ROOT, 'relay-scout') } as const;
mkdirSync(AGENT.home);
const EPOCH = '01BOOTEPOCHHANDOVER0000000';
/** The chat a spin-off was started from. */
export const PARENT = '5b0c1f4e-8a52-4a4e-9a51-6f1b0a2c3d4e';
/** The chat a chat message is sent from, and its agent's home (no registered agent). */
export const SENDER: ChatCaller = {
  sessionId: '3c9e6a7b-1d2f-4b8a-9c0e-5f6a7b8c9d0e',
  agentPath: join(ROOT, 'ana'),
};
/** A level a starting chat holds its spin-off to. */
export const LEVEL: TurnPermissionLevel = { asks: 'when-risky', reach: 'workspace' };

export let db: Db;
export let inner: FakeAgentRuntime;
export let record: RunRecord;
export let clock: number;
export let answered: string[];
export let releases: (() => void)[];
/** What the launch path was handed, per run. */
export let launched: DispatchSessionMessageOpts[];
export let chats: string[];
/** Launch slots a case took by hand, let go after it whatever happened. */
export let slots: (() => void)[];
/** This computer's face over the real launch path, recording what it hands the launch path. */
export let computer: ReturnType<typeof createComputerTurnPort>;
/** Chat messaging, when a case sends one; its receipts. */
export let messaging: ChatMessageService[];
export let messages: ChatMessageStore;

/** A turn that works until its release is called. */
const held = async function* (content: string): AsyncGenerator<StreamEvent> {
  answered.push(content);
  yield { type: 'text_delta', data: { text: 'working' } };
  await new Promise<void>((resolve) => releases.push(resolve));
  yield { type: 'done', data: {} };
};

/** Let every pending microtask and timer-0 callback run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One worker pass, and everything it set going. */
export async function pass(): Promise<void> {
  await record.worker.runOnce();
  await settle();
}

/** A chat the runtime already keeps, in the agent's home. */
export function chat(): string {
  const id = crypto.randomUUID();
  db.insert(sessionMetadata)
    .values({
      sessionId: id,
      runtime: inner.type,
      agentPath: AGENT.home,
      createdAt: new Date().toISOString(),
    })
    .run();
  chats.push(id);
  return id;
}

/** A message that opens a chat from the web, as the relay hands it. */
export function fromTheWeb(sessionId: string, content: string): StartTurnInput {
  return {
    sessionId,
    content,
    origin: { kind: 'session-relay', newChat: true },
    tier: 'owner',
    cwd: AGENT.home,
    agentId: AGENT.id,
  };
}

/** A spin-off's first message, as `session_start` hands it. */
export function spinOff(sessionId: string, content: string, extra: Partial<StartTurnInput> = {}) {
  return {
    sessionId,
    agentId: AGENT.id,
    cwd: AGENT.home,
    content,
    origin: { kind: 'agent-launch' },
    tier: 'owner',
    launcher: { kind: 'agent', agentPath: AGENT.home },
    runtime: inner.type,
    askedByRef: `dork:chat:${PARENT}`,
    ...extra,
  } satisfies StartTurnInput;
}

/** Install the run record over this case's store: again, for a restart. */
export function installRecord(): void {
  installRunRecord(db, {
    epoch: EPOCH,
    now: () => clock,
    computer: () => computer,
    agentHome: () => (id) => (id === AGENT.id ? AGENT.home : undefined),
    admission: { admission: { pausedAgent: () => undefined, machineFull: isAgentLaunchCapFull } },
  });
  record = getRunRecord()!;
}

/**
 * Chat messaging as startup wires it, over the run record's port; the receiving chats exist.
 *
 * @param overrides - What a case reads differently (a sending chat's level, say).
 */
export function chatMessaging(overrides: Partial<ChatMessageServiceDeps> = {}): ChatMessageService {
  const agent = { id: AGENT.id, name: 'relay-scout', projectPath: AGENT.home };
  const service = new ChatMessageService({
    store: messages,
    meshCore: () =>
      ({
        get: (id: string) => (id === AGENT.id ? agent : undefined),
        getProjectPath: (id: string) => (id === AGENT.id ? AGENT.home : undefined),
        listWithPaths: () => [agent],
      }) as never,
    describeSession: async (id) => ({
      bound: chats.includes(id),
      launchOrigin: 'interactive',
      agentPath: AGENT.home,
      startedByExtension: null,
      roomBound: false,
    }),
    chatTitle: async () => null,
    sessionCwd: async (id) => (chats.includes(id) ? AGENT.home : undefined),
    isBusy: async () => false,
    steerInto: async () => false,
    canonicalId: async (id) => id,
    interruptTurn: async () => false,
    turnLevelOf: () => undefined,
    emitActivity: () => undefined,
    turns: { handOver: (input, opts) => record.handOver(input, opts), port: () => record.port },
    ...overrides,
  });
  messaging.push(service);
  return service;
}

/** Every launch slot taken, by hand. */
export function fillMachine(): void {
  slots = Array.from({ length: agentLaunchMaxLive() }, () => claimCappedLaunch());
}

/** Let every slot go and give the worker one pass. */
export async function freeMachine(): Promise<void> {
  for (const release of slots.splice(0)) release();
  clock += 1_001;
  await pass();
}

/** Set up and take down a case: the stores, the runtime double, the face and the run record. */
export function useHandOverNow(): void {
  beforeEach(async () => {
    await initBoundary(ROOT);
    db = createTestDb();
    clock = Date.now();
    answered = [];
    releases = [];
    launched = [];
    chats = [];
    slots = [];
    const now = new Date().toISOString();
    db.insert(agents)
      .values({
        id: AGENT.id,
        name: 'relay-scout',
        runtime: 'claude-code',
        projectPath: AGENT.home,
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    registerTestHomes([AGENT.home]);
    setMessageQueueStore(new MessageQueueStore(db));
    inner = new FakeAgentRuntime('handover-demo').withScenarios(
      Array.from({ length: 8 }, () => held)
    );
    inner.getInternalSessionId.mockReturnValue(undefined);
    runtimeRegistry.setDb(db);
    runtimeRegistry.register(inner);
    runtimeRegistry.setDefault(inner.type);
    messaging = [];
    messages = new ChatMessageStore(db);
    computer = createComputerTurnPort({
      meshCore: () => ({
        getProjectPath: (id: string) => (id === AGENT.id ? AGENT.home : undefined),
        listWithPaths: () =>
          [{ id: AGENT.id, name: 'relay-scout', projectPath: AGENT.home }] as never,
      }),
      roomSessionPlace: () => undefined,
      dispatch: (opts) => {
        launched.push(opts);
        return dispatchSessionMessage(opts);
      },
    });
    installRecord();
  });

  afterEach(async () => {
    for (const service of messaging) service.stop();
    for (const release of slots.splice(0)) release();
    for (const release of releases.splice(0)) release();
    await settle();
    resetMessageDispatcher();
    uninstallRunRecord();
    setMessageQueueStore(undefined);
    for (const id of chats) disposeProjector(id);
    clearTestHomes();
    vi.restoreAllMocks();
  });
}
