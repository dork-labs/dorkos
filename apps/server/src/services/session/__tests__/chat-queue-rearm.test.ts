/**
 * DOR-3287, DOR-3348: a message another chat queued is never left on a row
 * nothing will run. Two ways that used to happen: a restart (the row survives,
 * the entry that runs it does not, and only a later message re-armed it), and a
 * send that joined such a row because the chat looked busy. Real dispatcher,
 * projector and SQLite queue; only the runtime is a double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';

vi.mock('../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import {
  adoptQueuedMessages,
  dispatchMessage,
  isQueuedMessageArmed,
  listQueuedMessages,
  rearmChatQueues,
  resetMessageDispatcher,
} from '../message-dispatcher.js';
import { ChatMessageService } from '../chat-messages/chat-message-service.js';
import { ChatMessageStore } from '../chat-messages/chat-message-store.js';
import { chatClientId } from '../chat-messages/chat-client-id.js';
import { passedOnLevelOf } from '../../core/turn-power/turn-levels.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import { disposeProjector, getOrCreateProjector } from '../session-state-projector.js';

let session: string;
let runtime: FakeAgentRuntime;
let queue: MessageQueueStore;
let chats: ChatMessageStore;
let service: ChatMessageService;
let busy: boolean;

const quick = async function* (): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'reply' } };
  yield { type: 'done', data: {} };
};

beforeEach(() => {
  session = crypto.randomUUID();
  busy = false;
  runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtime.withScenarios([quick, quick, quick]);
  const db = createTestDb();
  queue = new MessageQueueStore(db);
  setMessageQueueStore(queue);
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
    isBusy: async () => busy,
    dispatch: async (opts) =>
      dispatchMessage({
        sessionId: opts.sessionId,
        clientId: opts.clientId,
        content: opts.request.content,
        messageId: opts.messageId,
        projector: getOrCreateProjector(opts.sessionId),
        runtime,
      }),
    interruptTurn: async () => false,
    steerInto: async () => false,
    canonicalId: async (id) => id,
    turnLevelOf: passedOnLevelOf,
    emitActivity: () => undefined,
  });
});

afterEach(async () => {
  await vi.waitFor(() => expect(runtime.isTurnOpen(session)).toBe(false));
  service.stop();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(session);
});

/** Resume one chat's queue the way the server does: adopt its rows onto the real runtime. */
function resume(sessionId: string): void {
  adoptQueuedMessages({ sessionId, projector: getOrCreateProjector(sessionId), runtime });
}

/**
 * A row a previous server process accepted from another chat, with the chat
 * message riding on it. Written straight to the stores, then the dispatcher's
 * memory is dropped, which is what a restart leaves.
 */
function leftoverChatRow(text: string, fromChat = crypto.randomUUID()) {
  const row = queue.enqueue({
    sessionId: session,
    content: text,
    clientId: chatClientId(fromChat),
    disposition: 'queue',
    context: null,
  });
  const sent = chats.insert({
    id: crypto.randomUUID(),
    toSessionId: session,
    fromSessionId: fromChat,
    fromAgentPath: '/demo/sender',
    fromAgentId: null,
    fromAgentName: 'Sender',
    fromChatTitle: null,
    kind: 'message',
    text,
    summary: null,
    nonce: null,
    delivery: 'queue',
    status: 'queued',
    queueMessageId: row.id,
    ceilingJson: JSON.stringify('runtime-default'),
    replyToId: null,
  });
  resetMessageDispatcher();
  return { row, sent };
}

/** Let microtasks and short timers run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('a restart leaves another chat’s message queued for an idle chat', () => {
  it('starts it from the queue sweep, without waiting for a newer message', async () => {
    const { row, sent } = leftoverChatRow('census, due tonight');
    await settle();
    // The row alone starts nothing: this is the gap.
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(isQueuedMessageArmed(row.id)).toBe(false);

    await expect(rearmChatQueues({ resume })).resolves.toBe(1);

    await vi.waitFor(
      () => {
        expect(runtime.sendMessage).toHaveBeenCalledWith(
          session,
          'census, due tonight',
          expect.anything()
        );
        expect(listQueuedMessages(session)).toEqual([]);
        expect(chats.get(sent.id)?.status).toBe('delivered');
      },
      { timeout: 2000 }
    );
  });

  it('runs a row once, however often the sweep comes round', async () => {
    leftoverChatRow('only once');
    await rearmChatQueues({ resume });
    await rearmChatQueues({ resume });
    await vi.waitFor(() => expect(listQueuedMessages(session)).toEqual([]), { timeout: 2000 });
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves a queue nothing another chat sent alone', async () => {
    queue.enqueue({
      sessionId: session,
      content: 'a person’s own words',
      clientId: 'client-window',
      disposition: 'queue',
      context: null,
    });
    resetMessageDispatcher();
    const seen: string[] = [];
    await expect(rearmChatQueues({ resume: (id) => void seen.push(id) })).resolves.toBe(0);
    expect(seen).toEqual([]);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps sweeping the other chats when one cannot be resumed', async () => {
    leftoverChatRow('this one runs');
    const broken = crypto.randomUUID();
    queue.enqueue({
      sessionId: broken,
      content: 'its runtime is gone',
      clientId: chatClientId(crypto.randomUUID()),
      disposition: 'queue',
      context: null,
    });
    await expect(
      rearmChatQueues({
        resume: (id) => {
          if (id === broken) throw new Error('no runtime');
          resume(id);
        },
      })
    ).resolves.toBe(1);
    await vi.waitFor(() => expect(listQueuedMessages(session)).toEqual([]), { timeout: 2000 });
  });
});

describe('a send to a chat that only looks busy', () => {
  it('never joins a row nothing will run', async () => {
    leftoverChatRow('first, left behind');
    // The receiver reads as busy (a lock or turn the server still holds after a
    // stop), so the send would batch into the tail row.
    busy = true;
    const receipt = await service.send(
      { sessionId: crypto.randomUUID(), agentPath: '/demo/sender' },
      { to: session, message: 'second, sent now', delivery: 'queue' }
    );
    expect(receipt.note ?? '').not.toContain('joins the other agent messages');

    await vi.waitFor(
      () => {
        const sent = runtime.sendMessage.mock.calls.map((call) => String(call[1]));
        expect(sent.some((text) => text.includes('second, sent now'))).toBe(true);
        expect(sent.some((text) => text.includes('first, left behind'))).toBe(true);
        expect(listQueuedMessages(session)).toEqual([]);
      },
      { timeout: 2000 }
    );
  });
});
