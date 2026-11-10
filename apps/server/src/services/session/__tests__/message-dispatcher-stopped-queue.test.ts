/**
 * DOR-3348: an ended chat's next message starts without a five-minute queue wait.
 * Real dispatcher, projector and SQLite queue; only the runtime is a double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';

vi.mock('../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import {
  dispatchMessage,
  listQueuedMessages,
  resetMessageDispatcher,
} from '../message-dispatcher.js';
import { ChatMessageService } from '../chat-messages/chat-message-service.js';
import { ChatMessageStore } from '../chat-messages/chat-message-store.js';
import { passedOnLevelOf } from '../../core/turn-power/turn-levels.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import { disposeProjector, getOrCreateProjector } from '../session-state-projector.js';

let session: string;
let runtime: FakeAgentRuntime;
let finish: (() => void) | undefined;
let chats: ChatMessageStore;
let service: ChatMessageService;

beforeEach(() => {
  session = crypto.randomUUID();
  runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
  const db = createTestDb();
  setMessageQueueStore(new MessageQueueStore(db));
  chats = new ChatMessageStore(db);
  service = new ChatMessageService({
    store: chats,
    meshCore: () => undefined,
    describeSession: async () => ({
      bound: true,
      agentPath: '/demo/agent',
      launchOrigin: 'interactive',
      startedByExtension: null,
      roomBound: false,
    }),
    chatTitle: async () => 'Demo chat',
    sessionCwd: async () => undefined,
    isBusy: async () => getOrCreateProjector(session).getStatus().lifecycle === 'streaming',
    dispatch: async (opts) =>
      dispatchMessage({
        sessionId: opts.sessionId,
        clientId: opts.clientId,
        content: opts.request.content,
        messageId: opts.messageId,
        projector: getOrCreateProjector(opts.sessionId),
        runtime,
      }),
    interruptTurn: async (id) => {
      const receipt = await runtime.interruptQuery(id);
      return receipt.outcome === 'acked';
    },
    steerInto: async () => false,
    canonicalId: async (id) => id,
    turnLevelOf: passedOnLevelOf,
    emitActivity: () => undefined,
  });
});

afterEach(async () => {
  finish?.();
  await vi.waitFor(() => expect(runtime.isTurnOpen(session)).toBe(false));
  service.stop();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(session);
  finish = undefined;
});

function send(content: string) {
  return dispatchMessage({
    sessionId: session,
    clientId: 'chat:sender',
    content,
    projector: getOrCreateProjector(session),
    runtime,
  });
}

describe('messages after stopped, done and idle chats', () => {
  it.each(['stopped', 'done', 'idle'] as const)(
    'starts the next turn for a %s chat',
    async (state) => {
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const quick = async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'reply' } };
        yield { type: 'done', data: {} };
      };
      runtime.withScenarios(
        state === 'idle'
          ? [quick]
          : [
              async function* (): AsyncGenerator<StreamEvent> {
                yield { type: 'text_delta', data: { text: 'working' } };
                await held;
                yield {
                  type: 'done',
                  data:
                    state === 'stopped'
                      ? { terminalReason: 'aborted_streaming', stopWasRequested: true }
                      : {},
                };
              },
              quick,
            ]
      );

      if (state !== 'idle') {
        await send('start working');
        expect(getOrCreateProjector(session).getStatus().lifecycle).toBe('streaming');
        if (state === 'stopped') {
          runtime.interruptQuery.mockImplementation(async () => {
            finish?.();
            return { outcome: 'acked', runtime: runtime.type };
          });
          await runtime.interruptQuery(session);
        } else finish?.();
        await vi.waitFor(() =>
          expect(getOrCreateProjector(session).getStatus().lifecycle).toBe(
            state === 'stopped' ? 'interrupted' : 'idle'
          )
        );
      }

      await send('take the next message');
      await vi.waitFor(
        () => {
          expect(runtime.sendMessage).toHaveBeenLastCalledWith(
            session,
            'take the next message',
            expect.anything()
          );
          expect(listQueuedMessages(session)).toEqual([]);
        },
        { timeout: 2000 }
      );
    }
  );
});

describe('chat_send interrupt handoff', () => {
  it('runs the interrupting message and a later message queued during its turn', async () => {
    let releaseInitial!: () => void;
    let releaseHandoff!: () => void;
    const initial = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const handoff = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    finish = () => {
      releaseInitial();
      releaseHandoff();
    };
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'working' } };
        await initial;
        yield {
          type: 'done',
          data: { terminalReason: 'aborted_streaming', stopWasRequested: true },
        };
      },
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'taking the interrupted handoff' } };
        await handoff;
        yield { type: 'done', data: {} };
      },
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'taking the later message' } };
        yield { type: 'done', data: {} };
      },
    ]);
    runtime.interruptQuery.mockImplementation(async () => {
      releaseInitial();
      return { outcome: 'acked', runtime: runtime.type };
    });
    await send('start working');
    const caller = { sessionId: crypto.randomUUID(), agentPath: '/demo/sender' };
    const interrupted = await service.send(caller, {
      to: session,
      message: 'change course',
      delivery: 'interrupt',
    });
    await vi.waitFor(
      () => {
        expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
        expect(runtime.sendMessage.mock.calls[1]?.[1]).toContain('change course');
        expect(chats.get(interrupted.messageId)).toMatchObject({
          status: 'working',
          text: 'change course',
        });
      },
      { timeout: 2000 }
    );
    const later = await service.send(caller, {
      to: session,
      message: 'continue from here',
      delivery: 'queue',
    });
    expect(later.status).toBe('queued');
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(listQueuedMessages(session)).toEqual([
      expect.objectContaining({ content: expect.stringContaining('continue from here') }),
    ]);
    releaseHandoff();
    await vi.waitFor(
      () => {
        expect(runtime.sendMessage).toHaveBeenCalledTimes(3);
        expect(runtime.sendMessage.mock.calls[2]?.[1]).toContain('continue from here');
        expect(chats.get(later.messageId)).toMatchObject({ text: 'continue from here' });
        expect(chats.get(later.messageId)?.status).not.toBe('queued');
        expect(listQueuedMessages(session)).toEqual([]);
      },
      { timeout: 2000 }
    );
  });
});

describe('messages already queued when a turn ends', () => {
  it.each(['stopped', 'done'] as const)(
    'starts the waiting message when the turn is %s',
    async (state) => {
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      runtime.withScenarios([
        async function* (): AsyncGenerator<StreamEvent> {
          yield { type: 'text_delta', data: { text: 'working' } };
          await held;
          yield {
            type: 'done',
            data:
              state === 'stopped'
                ? { terminalReason: 'aborted_streaming', stopWasRequested: true }
                : {},
          };
        },
        async function* (): AsyncGenerator<StreamEvent> {
          yield { type: 'text_delta', data: { text: 'answering the queued message' } };
          yield { type: 'done', data: {} };
        },
      ]);
      await send('start working');
      const waiting = await send('already queued');
      expect(waiting.queued).toBe(true);
      expect(listQueuedMessages(session)).toEqual([
        expect.objectContaining({ content: 'already queued' }),
      ]);
      if (state === 'stopped') {
        runtime.interruptQuery.mockImplementation(async () => {
          finish?.();
          return { outcome: 'acked', runtime: runtime.type };
        });
        await runtime.interruptQuery(session);
      } else finish?.();
      await vi.waitFor(
        () => {
          expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
          expect(runtime.sendMessage.mock.calls[1]?.[1]).toBe('already queued');
          expect(listQueuedMessages(session)).toEqual([]);
        },
        { timeout: 2000 }
      );
    }
  );
});
