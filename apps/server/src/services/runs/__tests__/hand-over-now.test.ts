/**
 * T6 (DOR-5214, spec `turns-survive-restarts` §3.5, §4.6, §10 child C) and T6b
 * (DOR-5503): a spin-off's first message, a message sent from the web and a
 * chat message start their turns through the turn port, handed over at once,
 * and a busy machine makes their work wait with its place shown instead of
 * refusing it (`LAUNCH_CAP_FULL`, `RELAY_TOO_MANY_NEW_CHATS`) or holding it
 * outside the port (the chat messages' own cap hold).
 *
 * Over the real launch path, dispatcher, projector, SQLite queue and run
 * record; only the runtime underneath is a double, and the clock the record
 * and outbox read is injected so the worker's passes run one at a time.
 *
 * The parity cases hold the trust the direct path gave these turns: what the
 * launch path is handed through the port must carry every ceiling, mark,
 * launcher and identity the caller's own call carried, never less.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agents,
  eq,
  sessionBirthAllocations,
  sessionMessageQueue,
  sessionMetadata,
  type Db,
} from '@dorkos/db';
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
import { WEB_NEW_CHATS_MAX } from '@dorkos/shared/turn-hand-over';
import { registerClaudeCodeFacts } from '../../../startup/register-claude-code-facts.js';
import { ChatMessageStore } from '../../session/chat-messages/chat-message-store.js';
import {
  ChatMessageService,
  type ChatCaller,
} from '../../session/chat-messages/chat-message-service.js';
import { MACHINE_FULL_NOTE } from '../../session/chat-messages/sending/chat-turn-hand-over.js';

// What startup registers (DOR-4928): unregistered, the place rule refuses every folder.
registerClaudeCodeFacts();

/** A made-up agent, at home in a real folder: a person's send is checked against the boundary. */
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'hand-over-now-')));
const AGENT = { id: '01KHANDQVERAGENT0000000000', home: join(ROOT, 'relay-scout') } as const;
mkdirSync(AGENT.home);
const EPOCH = '01BOOTEPOCHHANDOVER0000000';
/** The chat a spin-off was started from. */
const PARENT = '5b0c1f4e-8a52-4a4e-9a51-6f1b0a2c3d4e';
/** The chat a chat message is sent from, and its agent's home (no registered agent). */
const SENDER: ChatCaller = {
  sessionId: '3c9e6a7b-1d2f-4b8a-9c0e-5f6a7b8c9d0e',
  agentPath: join(ROOT, 'ana'),
};
/** A level a starting chat holds its spin-off to. */
const LEVEL: TurnPermissionLevel = { asks: 'when-risky', reach: 'workspace' };

let db: Db;
let inner: FakeAgentRuntime;
let record: RunRecord;
let clock: number;
let answered: string[];
let releases: (() => void)[];
/** What the launch path was handed, per run. */
let launched: DispatchSessionMessageOpts[];
let chats: string[];
/** Launch slots a case took by hand, let go after it whatever happened. */
let slots: (() => void)[];
/** This computer's face over the real launch path, recording what it hands the launch path. */
let computer: ReturnType<typeof createComputerTurnPort>;
/** Chat messaging, when a case sends one; its receipts. */
let messaging: ChatMessageService[];
let messages: ChatMessageStore;

/** A turn that works until its release is called. */
const held = async function* (content: string): AsyncGenerator<StreamEvent> {
  answered.push(content);
  yield { type: 'text_delta', data: { text: 'working' } };
  await new Promise<void>((resolve) => releases.push(resolve));
  yield { type: 'done', data: {} };
};

/** Let every pending microtask and timer-0 callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One worker pass, and everything it set going. */
async function pass(): Promise<void> {
  await record.worker.runOnce();
  await settle();
}

/** A chat the runtime already keeps, in the agent's home. */
function chat(): string {
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
function fromTheWeb(sessionId: string, content: string): StartTurnInput {
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
function spinOff(sessionId: string, content: string, extra: Partial<StartTurnInput> = {}) {
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

/** Install the run record over this case's store: again, for a restart. */
function installRecord(): void {
  installRunRecord(db, {
    epoch: EPOCH,
    now: () => clock,
    computer: () => computer,
    agentHome: () => (id) => (id === AGENT.id ? AGENT.home : undefined),
    admission: { admission: { pausedAgent: () => undefined, machineFull: isAgentLaunchCapFull } },
  });
  record = getRunRecord()!;
}

/** Chat messaging as startup wires it, over the run record's port; the receiving chats exist. */
function chatMessaging(): ChatMessageService {
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
  });
  messaging.push(service);
  return service;
}

/** Every launch slot taken, by hand. */
function fillMachine(): void {
  slots = Array.from({ length: agentLaunchMaxLive() }, () => claimCappedLaunch());
}

/** Let every slot go and give the worker one pass. */
async function freeMachine(): Promise<void> {
  for (const release of slots.splice(0)) release();
  clock += 1_001;
  await pass();
}

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

describe('a busy machine makes work wait, with its place shown', () => {
  it('a spin-off at a full machine waits for a slot, shows its place, and starts when one frees', async () => {
    // Purpose: fails if LAUNCH_CAP_FULL refuses a spin-off again, or its wait is not visible.
    slots = Array.from({ length: agentLaunchMaxLive() }, () => claimCappedLaunch());
    const child = chat();
    const answer = await record.handOver(spinOff(child, 'From Scout: tidy the tests'));
    expect(answer).toMatchObject({ kind: 'waiting', waitReason: 'machine_full', queuePosition: 1 });
    expect(record.view(child)).toEqual([
      expect.objectContaining({ status: 'queued', waitReason: 'machine_full', queuePosition: 1 }),
    ]);
    expect(launched).toEqual([]);

    for (const release of slots.splice(0)) release();
    clock += 1_001;
    await pass();
    await vi.waitFor(() => expect(answered).toEqual(['From Scout: tidy the tests']));
    expect(record.store.get(answer.runId)).toMatchObject({ status: 'running', waitReason: null });
  });

  it(`a new chat from the web past ${WEB_NEW_CHATS_MAX} running waits for one to finish, then starts`, async () => {
    // Purpose: fails if RELAY_TOO_MANY_NEW_CHATS refuses a new web chat again.
    const running = Array.from({ length: WEB_NEW_CHATS_MAX }, () => chat());
    for (const id of running) {
      expect(await record.handOver(fromTheWeb(id, `hello ${id}`))).toMatchObject({
        kind: 'handed',
      });
    }
    await vi.waitFor(() => expect(answered).toHaveLength(WEB_NEW_CHATS_MAX));
    const late = chat();
    const answer = await record.handOver(fromTheWeb(late, 'one more'));
    expect(answer).toMatchObject({ kind: 'waiting', waitReason: 'machine_full' });
    // Its place shows on the chat's runs, though its words are not a queue row yet.
    expect(record.view(late)).toEqual([
      expect.objectContaining({ status: 'queued', waitReason: 'machine_full', queuePosition: 1 }),
    ]);

    releases.shift()!();
    await vi.waitFor(() =>
      expect(record.store.get(record.store.listForChat(running[0]!)[0]!.id)?.status).toMatch(
        /ended|settled/u
      )
    );
    await pass();
    await vi.waitFor(() => expect(answered).toContain('one more'));
    expect(record.store.get(answer.runId)?.queueMessageId).toBe(answer.runId);
  });

  it('a chat message opening a new direct chat at a full machine waits, then opens it', async () => {
    // Purpose: fails if LAUNCH_CAP_FULL refuses a chat message's new chat again, or its wait is unseen.
    fillMachine();
    const receipt = await chatMessaging().send(SENDER, { to: AGENT.id, message: 'a fresh hello' });
    chats.push(receipt.chatId);
    expect(receipt).toMatchObject({ status: 'queued', position: 1, note: MACHINE_FULL_NOTE });
    expect(record.view(receipt.chatId)).toEqual([
      expect.objectContaining({ status: 'queued', waitReason: 'machine_full', queuePosition: 1 }),
    ]);
    expect(launched).toEqual([]);
    // Its reservation is kept while it waits, and the chat is not born yet.
    expect(db.select().from(sessionBirthAllocations).all()).toHaveLength(1);

    await freeMachine();
    await vi.waitFor(() => expect(answered).toEqual([expect.stringContaining('a fresh hello')]));
    const runId = messages.get(receipt.messageId)!.queueMessageId!;
    expect(record.store.get(runId)).toMatchObject({ status: 'running', waitReason: null });
    expect(
      db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, receipt.chatId)).get()
    ).toMatchObject({ agentPath: AGENT.home, launchOrigin: 'chat-message' });
  });

  it('a chat message to an idle chat at a full machine waits as a run, then starts', async () => {
    // Purpose: fails if chat messaging holds the message outside the port again (its old cap hold).
    fillMachine();
    const target = chat();
    const receipt = await chatMessaging().send(SENDER, { to: target, message: 'when you can' });
    expect(receipt).toMatchObject({ status: 'queued', chatId: target, note: MACHINE_FULL_NOTE });
    expect(record.view(target)).toEqual([
      expect.objectContaining({ status: 'queued', waitReason: 'machine_full', queuePosition: 1 }),
    ]);

    await freeMachine();
    await vi.waitFor(() => expect(answered).toEqual([expect.stringContaining('when you can')]));
    await vi.waitFor(() => expect(messages.get(receipt.messageId)?.status).toBe('working'));
  });

  it('a chat message waiting for a slot keeps its words across a restart', async () => {
    // Purpose: fails if a waiting chat message's words live only in memory (the DOR-5505 case).
    fillMachine();
    const target = chat();
    const first = chatMessaging();
    const receipt = await first.send(SENDER, { to: target, message: 'still here after it' });
    first.stop();
    // A new process: a new run record and chat messaging over the same stores.
    uninstallRunRecord();
    installRecord();
    await chatMessaging().startTurns();

    await freeMachine();
    await vi.waitFor(() =>
      expect(answered).toEqual([expect.stringContaining('still here after it')])
    );
    expect(messages.get(receipt.messageId)?.status).not.toBe('failed');
  });

  it('a message an earlier version held for a slot starts through the port at boot', async () => {
    // Purpose: fails if an upgrade strands what the old cap hold kept (a queued row with no queue id).
    const target = chat();
    const held = messages.insert({
      id: crypto.randomUUID(),
      toSessionId: target,
      fromSessionId: SENDER.sessionId,
      fromAgentPath: SENDER.agentPath,
      fromAgentId: null,
      fromAgentName: 'Ana',
      fromChatTitle: null,
      kind: 'message',
      text: 'held before the upgrade',
      summary: null,
      nonce: '0a1b2c3d4e5f6a7b',
      delivery: 'queue',
      status: 'queued',
      queueMessageId: null,
      ceilingJson: JSON.stringify('runtime-default'),
      replyToId: null,
    });
    await chatMessaging().startTurns();
    clock += 1_001;
    await pass();
    await vi.waitFor(() =>
      expect(answered).toEqual([expect.stringContaining('held before the upgrade')])
    );
    expect(launched[0]).toMatchObject({ clientId: `chat:${SENDER.sessionId}` });
    expect(messages.listHeldForSlot()).toEqual([]);
    expect(messages.get(held.id)?.queueMessageId).toBe(launched[0]!.runId);
  });

  it('stopping a chat takes back the chat messages still waiting for a slot there', async () => {
    fillMachine();
    const target = chat();
    const service = chatMessaging();
    const receipt = await service.send(SENDER, { to: target, message: 'never mind' });
    const runId = messages.get(receipt.messageId)!.queueMessageId!;

    await service.stopChat(SENDER, { chat: target });
    expect(messages.get(receipt.messageId)).toMatchObject({ status: 'failed' });
    expect(record.store.get(runId)).toMatchObject({ status: 'cancelled' });
    await freeMachine();
    expect(answered).toEqual([]);
  });

  it('answers a refusal at the door with the launch path’s own sentence, and cancels the run', async () => {
    const child = chat();
    const answer = await record.handOver(
      spinOff(child, 'From Scout: next door', {
        launcher: { kind: 'agent', agentPath: '/elsewhere' },
      })
    );
    expect(answer).toMatchObject({
      kind: 'refused',
      reason: 'desk_not_own',
      refusal: { code: 'DESK_NOT_OWN', message: expect.any(String) },
    });
    expect(record.store.get(answer.runId)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'desk_not_own' },
    });
  });
});

describe('trust parity: the port hands the launch path what the direct call did', () => {
  it('a spin-off keeps its launcher, ceiling, marks, account and asker, and counts toward the cap', async () => {
    // Purpose: fails if the port drops a ceiling, a mark or the launcher, or runs it unattended.
    const child = chat();
    const answer = await record.handOver(
      spinOff(child, 'From Scout: careful now', {
        permissionCeiling: LEVEL,
        carriedMarks: { outsider: true },
        seedContext: 'Started by Scout.',
        accountHint: 'work',
      })
    );
    expect(answer).toMatchObject({ kind: 'handed' });
    const [opts] = launched;
    expect(opts).toMatchObject({
      sessionId: child,
      origin: { kind: 'agent-launch' },
      launcher: { kind: 'agent', agentPath: AGENT.home },
      permissionCeiling: LEVEL,
      carriedMarks: { outsider: true },
      countsTowardLaunchCap: true,
      wordsAtSource: true,
      request: {
        content: 'From Scout: careful now',
        cwd: AGENT.home,
        agentPath: AGENT.home,
        seedContext: 'Started by Scout.',
        runtime: inner.type,
        account: 'work',
      },
    });
    expect(opts!.unattended).toBeUndefined();
    // Read as an agent's launch, never as another chat's or the web's.
    expect(opts!.clientId).toBe(`turn-port:${answer.runId}`);
    expect(record.store.get(answer.runId)?.askedByRef).toBe(`dork:chat:${PARENT}`);
  });

  it('a message from the web runs at the agent’s own level, under the relay’s identity', async () => {
    // Purpose: fails if a web message gains a person's clean-send identity (DOR-4693) or a bound.
    const id = chat();
    const answer = await record.handOver(fromTheWeb(id, 'from my phone'));
    expect(answer.kind).toBe('handed');
    const [opts] = launched;
    expect(opts!.clientId).toBe(`relay:${answer.runId}`);
    expect(opts).toMatchObject({ origin: { kind: 'session-relay', newChat: true } });
    expect(opts!.countsTowardLaunchCap).toBe(false);
    expect(opts!.permissionCeiling).toBeUndefined();
    expect(opts!.carriedMarks).toBeUndefined();
    expect(opts!.unattended).toBeUndefined();
    expect(opts!.launcher).toBeUndefined();
  });

  it('a chat message runs as the chat that sent it, and one naming no sender never queues', async () => {
    // Purpose: fails if a chat message could launch without its sender's ceiling (`chat:` identity).
    const id = chat();
    const sent = await record.handOver({
      sessionId: id,
      content: 'From Scout: a note',
      origin: { kind: 'chat-message' },
      tier: 'owner',
      cwd: AGENT.home,
      askedByRef: `dork:chat:${PARENT}`,
    });
    expect(sent.kind).toBe('handed');
    expect(launched[0]!.clientId).toBe(`chat:${PARENT}`);

    const other = chat();
    await expect(
      record.handOver({
        sessionId: other,
        content: 'no sender',
        origin: { kind: 'chat-message' },
        tier: 'owner',
        cwd: AGENT.home,
      })
    ).rejects.toThrow(/names the chat that sent it/u);
    expect(launched).toHaveLength(1);
    expect(
      db
        .select()
        .from(sessionMessageQueue)
        .all()
        .map((row) => row.sessionId)
    ).not.toContain(other);
    expect(record.store.listForChat(other)[0]).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'start_failed' },
    });
  });
  it('a chat message opening a new direct chat hands the launch path exactly what the direct call did', async () => {
    // Purpose: fails if a chat message loosens through the port: its sender's identity, the queue
    // row its sender's level rides on, its birth record, or a level, mark, launcher or watcher
    // the direct call never carried.
    const receipt = await chatMessaging().send(SENDER, { to: AGENT.id, message: 'parity' });
    chats.push(receipt.chatId);
    const row = messages.get(receipt.messageId)!;
    const [opts] = launched;
    expect(opts).toMatchObject({
      sessionId: row.toSessionId,
      origin: { kind: 'chat-message' },
      clientId: `chat:${SENDER.sessionId}`,
      messageId: row.queueMessageId,
      countsTowardLaunchCap: true,
    });
    expect(opts!.request).toEqual({
      content: expect.stringContaining('parity'),
      agentPath: AGENT.home,
    });
    expect(opts!.freshDmBirth).toEqual({
      kind: 'chat-message',
      delivery: 'live-fresh',
      allocationCreatedAt: row.createdAt,
      receiptId: row.id,
      queueMessageId: row.queueMessageId,
      fromSessionId: SENDER.sessionId,
      fromAgentPath: SENDER.agentPath,
      targetAgent: { id: AGENT.id, path: AGENT.home },
    });
    for (const never of [
      'permissionCeiling',
      'carriedMarks',
      'continuationHold',
      'launcher',
      'unattended',
      'workspaceCaller',
      'personChatSource',
      'wordsAtSource',
    ] as const) {
      expect(opts![never]).toBeUndefined();
    }
    expect(opts!.turnOptions).toEqual({});
    expect(record.store.get(row.queueMessageId!)?.askedByRef).toBe(`dork:chat:${SENDER.sessionId}`);
  });

  it('a chat message into a running chat queues behind it as its sender, taking no slot', async () => {
    const target = chat();
    const service = chatMessaging();
    await service.send(SENDER, { to: target, message: 'first' });
    await vi.waitFor(() => expect(answered).toHaveLength(1));
    const receipt = await service.send(SENDER, { to: target, message: 'second' });
    const row = messages.get(receipt.messageId)!;
    expect(receipt).toMatchObject({ status: 'queued', position: 1 });
    expect(launched[1]).toMatchObject({
      messageId: row.queueMessageId,
      countsTowardLaunchCap: false,
    });
    expect(db.select().from(sessionMessageQueue).all()).toEqual([
      expect.objectContaining({ id: row.queueMessageId, clientId: `chat:${SENDER.sessionId}` }),
    ]);
  });

  it('opens a direct chat only for a chat message, and only from the chat that sent it', async () => {
    const birth = {
      receiptId: 'receipt-1',
      fromSessionId: SENDER.sessionId,
      fromAgentPath: SENDER.agentPath,
      allocationCreatedAt: new Date().toISOString(),
      targetAgent: { id: AGENT.id, path: AGENT.home },
    };
    const base = { content: 'x', tier: 'owner' as const, agentId: AGENT.id, newDirectChat: birth };
    await expect(
      record.handOver({
        ...base,
        sessionId: chat(),
        origin: { kind: 'chat-message' },
        askedByRef: `dork:chat:${PARENT}`,
      })
    ).rejects.toThrow(/only by the chat that sent/u);
    await expect(
      record.handOver({ ...base, sessionId: chat(), origin: { kind: 'agent-launch' } })
    ).rejects.toThrow(/Only a chat message/u);
    expect(launched).toEqual([]);
  });
});
