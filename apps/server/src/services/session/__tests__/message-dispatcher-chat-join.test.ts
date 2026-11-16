/**
 * Drain-time joining of chat rows through the real dispatcher, durable queue,
 * chat-message store, and ChatMessageService lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { marksOfCeiling } from '../../core/turn-power/turn-marks.js';
import {
  dispatchMessage,
  resetMessageDispatcher,
  setQueuedChatCeilingResolver,
  setQueuedChatHoldResolver,
  setQueuedChatWordsResolver,
} from '../message-dispatcher.js';
import { setQueuedChatJoiner, steering } from '../message-dispatcher/state.js';
import { holdForSteer, releaseSteerHold } from '../message-dispatcher/pump.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import { getOrCreateProjector, disposeProjector } from '../session-state-projector.js';
import { ChatMessageStore } from '../chat-messages/chat-message-store.js';
import { ChatMessageService, type ChatCaller } from '../chat-messages/chat-message-service.js';
import {
  rowsCarryHold,
  rowsCarryWords,
  rowsCeiling,
} from '../chat-messages/chat-message-ceiling.js';
import { CHAT_DRAIN_JOIN_MAX } from '../message-dispatcher/join-chat-rows.js';

const TARGET = '00000000-0000-4000-8000-000000003060';
const PERSON = 'window-a';
const ANA: ChatCaller = { sessionId: 'chat-a', agentPath: '/agents/ana' };
const CAL: ChatCaller = { sessionId: 'chat-c', agentPath: '/agents/cal' };
const TIGHT: TurnPermissionLevel = { asks: 'always', reach: 'edit' };

const agents = [
  { id: 'agent-ana', name: 'ana', displayName: 'Ana', projectPath: ANA.agentPath },
  { id: 'agent-cal', name: 'cal', displayName: 'Cal', projectPath: CAL.agentPath },
  { id: 'agent-bo', name: 'bo', displayName: 'Bo', projectPath: '/agents/bo' },
];

let queue: MessageQueueStore;
let store: ChatMessageStore;
let runtime: FakeAgentRuntime;
let service: ChatMessageService;
let release: () => void;
let levels: Map<string, TurnPermissionLevel>;

function heldTurn(wait: Promise<void>) {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
    await wait;
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

function quickTurn() {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

/** Start the turn every queued fixture waits behind. */
async function startBusy(...after: Array<ReturnType<typeof quickTurn>>): Promise<void> {
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.withScenarios([heldTurn(gate), ...after]);
  await dispatchMessage({
    sessionId: TARGET,
    clientId: PERSON,
    content: 'the running turn',
    projector: getOrCreateProjector(TARGET),
    runtime,
  });
}

/** Send a person's message through the same real dispatcher. */
function sendPerson(content: string) {
  return dispatchMessage({
    sessionId: TARGET,
    clientId: PERSON,
    content,
    projector: getOrCreateProjector(TARGET),
    runtime,
  });
}

beforeEach(() => {
  release = () => {};
  const db = createTestDb();
  queue = new MessageQueueStore(db);
  store = new ChatMessageStore(db);
  setMessageQueueStore(queue);
  runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
  levels = new Map([
    [ANA.sessionId, TIGHT],
    [CAL.sessionId, TIGHT],
    [TARGET, TIGHT],
  ]);
  const mesh = {
    get: (id: string) => agents.find((agent) => agent.id === id),
    getProjectPath: (id: string) => agents.find((agent) => agent.id === id)?.projectPath,
    listWithPaths: () => agents,
  };
  service = new ChatMessageService({
    store,
    meshCore: () => mesh as never,
    describeSession: async () => ({
      bound: true,
      launchOrigin: 'interactive',
      agentPath: '/agents/bo',
      startedByExtension: null,
      roomBound: false,
    }),
    chatTitle: async (id) => `Title of ${id}`,
    sessionCwd: async () => undefined,
    isBusy: async () => true,
    dispatch: async (opts) =>
      dispatchMessage({
        sessionId: opts.sessionId,
        clientId: opts.clientId,
        content: opts.request.content,
        messageId: opts.messageId,
        disposition: opts.request.disposition,
        projector: getOrCreateProjector(opts.sessionId),
        runtime,
      }),
    steerInto: async () => false,
    canonicalId: async (id) => id,
    interruptTurn: async () => false,
    turnLevelOf: (id) => levels.get(id),
    emitActivity: () => {},
    nonce: (() => {
      let value = 0xa0000000;
      return () => (value++).toString(16);
    })(),
  });
  setQueuedChatJoiner((fromRowId, toRowId) => {
    for (const record of store.listByQueueMessage(fromRowId)) {
      store.update(record.id, { queueMessageId: toRowId });
    }
  });
  setQueuedChatCeilingResolver((id) => rowsCeiling(store.listByQueueMessage(id)));
  setQueuedChatHoldResolver((id) => rowsCarryHold(store.listByQueueMessage(id)));
  setQueuedChatWordsResolver((id) => rowsCarryWords(store.listByQueueMessage(id)));
});

afterEach(async () => {
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  service?.stop();
  setQueuedChatJoiner(undefined);
  steering.clear();
  setQueuedChatCeilingResolver(undefined);
  setQueuedChatHoldResolver(undefined);
  setQueuedChatWordsResolver(undefined);
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(TARGET);
});

describe('chat rows at a turn boundary', () => {
  it('keeps two rows while busy, then launches both fences once and settles both records', async () => {
    await startBusy(quickTurn());
    const first = await service.send(ANA, { to: TARGET, message: 'first request' });
    const second = await service.send(CAL, { to: TARGET, message: 'second request' });

    expect(queue.list(TARGET)).toHaveLength(2);
    expect(store.get(first.messageId)!.queueMessageId).not.toBe(
      store.get(second.messageId)!.queueMessageId
    );

    release();
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(2));
    const joined = runtime.sendMessage.mock.calls[1]![1];
    expect(joined.match(/--- BEGIN CHAT MESSAGE/g)).toHaveLength(2);
    expect(joined.indexOf('first request')).toBeLessThan(joined.indexOf('second request'));
    await vi.waitFor(() => {
      expect(store.get(first.messageId)?.status).toBe('delivered');
      expect(store.get(second.messageId)?.status).toBe('delivered');
    });
    expect(queue.list(TARGET)).toEqual([]);
  });

  it('carries the strictest ceiling and hold from every joined sender', async () => {
    await startBusy(quickTurn());
    const origin = { roomId: 'room-1', authorId: 'teammate-1' };
    levels.set(ANA.sessionId, { ...TIGHT, teammate: [origin] });
    await service.send(
      { ...ANA, marksAtTurnEnd: { outsider: true } },
      { to: TARGET, message: 'marked request' }
    );
    await service.send(CAL, { to: TARGET, message: 'plain request' });

    release();
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(2));
    const options = runtime.sendMessage.mock.calls[1]![2] as {
      permissionCeiling?: TurnPermissionLevel;
      carriedMarks?: { outsider?: boolean };
    };
    expect(marksOfCeiling(options.permissionCeiling!)).toEqual({ teammate: [origin] });
    expect(options.carriedMarks).toEqual({ outsider: true });
  });

  it('stops at a person row between two chat rows', async () => {
    await startBusy(quickTurn(), quickTurn(), quickTurn());
    const first = await service.send(ANA, { to: TARGET, message: 'first agent' });
    await service.send(CAL, { to: TARGET, message: 'second agent' });
    const person = await sendPerson('between them');
    queue.move(person.outcome.messageId, { after: store.get(first.messageId)!.queueMessageId! });

    expect(queue.list(TARGET).map((row) => row.content.includes('between them'))).toEqual([
      false,
      true,
      false,
    ]);
    release();
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(4));
    const launched = runtime.sendMessage.mock.calls.map((call) => call[1]);
    expect(launched[1]).toContain('first agent');
    expect(launched[1]).not.toContain('second agent');
    expect(launched[2]).toBe('between them');
    expect(launched[3]).toContain('second agent');
  });

  it('never launches or joins a row a person is sending now, until the hold lets go', async () => {
    await startBusy(quickTurn(), quickTurn());
    const first = await service.send(ANA, { to: TARGET, message: 'first agent' });
    const second = await service.send(CAL, { to: TARGET, message: 'second agent' });
    const secondRow = store.get(second.messageId)!.queueMessageId!;
    expect(holdForSteer(secondRow)).toBe(true);

    release();
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage.mock.calls[1]![1]).toContain('first agent');
    expect(runtime.sendMessage.mock.calls[1]![1]).not.toContain('second agent');
    expect(queue.get(secondRow)).toBeDefined();
    expect(store.get(first.messageId)?.queueMessageId).not.toBe(secondRow);

    releaseSteerHold(TARGET, secondRow);
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(3));
    expect(runtime.sendMessage.mock.calls[2]![1]).toContain('second agent');
  });

  it('starts another turn when joining the next row would pass the size cap', async () => {
    await startBusy(quickTurn(), quickTurn());
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const receipt = await service.send(index % 2 === 0 ? ANA : CAL, {
        to: TARGET,
        message: `message-${index} ${'x'.repeat(19_000)}`,
      });
      ids.push(receipt.messageId);
    }
    expect(queue.list(TARGET)).toHaveLength(6);

    release();
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(3));
    const firstBatch = runtime.sendMessage.mock.calls[1]![1];
    const secondBatch = runtime.sendMessage.mock.calls[2]![1];
    expect(firstBatch.length).toBeLessThanOrEqual(CHAT_DRAIN_JOIN_MAX);
    expect(firstBatch).toContain('message-0');
    expect(firstBatch).not.toContain('message-5');
    expect(secondBatch).toContain('message-5');
    await vi.waitFor(() =>
      expect(ids.map((id) => store.get(id)?.status)).toEqual(ids.map(() => 'delivered'))
    );
  });
});
