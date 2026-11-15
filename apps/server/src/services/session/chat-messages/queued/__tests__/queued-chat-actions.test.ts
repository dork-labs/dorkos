/**
 * Send now and person removal over real queue and chat-message stores. Function
 * dependencies are spies; no DorkOS module is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { CHAT_MESSAGE_LEAD, renderChatMessage } from '../../chat-message-fence.js';
import { ChatMessageStore } from '../../chat-message-store.js';
import { chatClientId } from '../../chat-client-id.js';
import {
  noteRemovedByPerson,
  queuedChatRecordsOf,
  setQueuedChatActionsDeps,
  steerQueuedChatMessage,
  type QueuedChatActionsDeps,
} from '../queued-chat-actions.js';
import { MessageQueueStore, setMessageQueueStore } from '../../../message-queue-store.js';
import { cancelQueuedMessage } from '../../../queued-message-edits.js';
import { resetChatStartedTurns } from '../../chat-started-turns.js';
import { launching, steering } from '../../../message-dispatcher/state.js';

const TARGET = 'target-chat';
const SENDER = 'sender-chat';
const TIGHT: TurnPermissionLevel = { asks: 'always', reach: 'edit' };

let queue: MessageQueueStore;
let store: ChatMessageStore;
let levels: Map<string, TurnPermissionLevel>;
let steerInto: ReturnType<typeof vi.fn<QueuedChatActionsDeps['steerInto']>>;
let emitActivity: ReturnType<typeof vi.fn<QueuedChatActionsDeps['emitActivity']>>;

/** Add one fenced chat message and its durable queue row. */
function seedChatMessage(
  options: {
    rowId?: string;
    recordId?: string;
    from?: string;
    text?: string;
    ceilingJson?: string;
  } = {}
) {
  const rowId = options.rowId ?? 'chat-row';
  const recordId = options.recordId ?? 'chat-message';
  const from = options.from ?? SENDER;
  const words = options.text ?? 'Please check the launch.';
  const nonce = recordId === 'second' ? 'b0c0d0e0' : 'a0b0c0d0';
  const rendered = renderChatMessage(
    {
      messageId: recordId,
      agentName: 'Ana',
      agentId: 'agent-ana',
      chatId: from,
      chatTitle: 'Planning',
    },
    'message',
    words,
    nonce
  );
  if (!queue.get(rowId)) {
    queue.enqueue({
      id: rowId,
      sessionId: TARGET,
      content: rendered.text,
      clientId: chatClientId(from),
    });
  } else {
    const row = queue.get(rowId)!;
    queue.updateContent(rowId, `${row.content}\n\n${rendered.text}`);
  }
  store.insert({
    id: recordId,
    toSessionId: TARGET,
    fromSessionId: from,
    fromAgentPath: `/agents/${from}`,
    fromAgentId: 'agent-ana',
    fromAgentName: 'Ana',
    fromChatTitle: 'Planning',
    kind: 'message',
    text: words,
    summary: null,
    nonce: rendered.nonce,
    delivery: 'queue',
    status: 'queued',
    queueMessageId: rowId,
    ceilingJson: options.ceilingJson ?? JSON.stringify('none'),
    replyToId: null,
  });
  return { rowId, recordId, rendered };
}

beforeEach(() => {
  const db = createTestDb();
  queue = new MessageQueueStore(db);
  store = new ChatMessageStore(db);
  setMessageQueueStore(queue);
  levels = new Map([
    [SENDER, TIGHT],
    [TARGET, TIGHT],
  ]);
  steerInto = vi.fn(async () => true);
  emitActivity = vi.fn();
  setQueuedChatActionsDeps({
    store,
    isBusy: async () => true,
    turnLevelOf: (sessionId) => levels.get(sessionId),
    steerInto,
    emitActivity,
    operatorName: () => 'Dana',
  });
});

afterEach(() => {
  setQueuedChatActionsDeps(undefined);
  setMessageQueueStore(undefined);
  resetChatStartedTurns();
  launching.clear();
  steering.clear();
});

describe('steerQueuedChatMessage', () => {
  it('steers the full fenced envelope and marks its record steered', async () => {
    const seeded = seedChatMessage();

    await expect(steerQueuedChatMessage(TARGET, seeded.rowId)).resolves.toEqual({
      outcome: 'steered',
    });

    expect(steerInto).toHaveBeenCalledWith(TARGET, seeded.rendered.text, seeded.rowId);
    const content = steerInto.mock.calls[0]![1];
    expect(content).toContain(CHAT_MESSAGE_LEAD);
    expect(content).toContain('--- BEGIN CHAT MESSAGE');
    expect(store.get(seeded.recordId)).toMatchObject({
      status: 'steered',
      queueMessageId: null,
    });
    expect(queue.get(seeded.rowId)).toBeUndefined();
  });

  it('does not launder a marked sender into an unmarked turn and moves it first', async () => {
    const person = queue.enqueue({ sessionId: TARGET, content: 'person', clientId: 'window-a' });
    const seeded = seedChatMessage();
    levels.set(SENDER, { ...TIGHT, outsider: true });

    await expect(steerQueuedChatMessage(TARGET, seeded.rowId)).resolves.toEqual({
      outcome: 'moved-to-front',
      reason: 'steer-not-allowed',
    });

    expect(steerInto).not.toHaveBeenCalled();
    expect(queue.list(TARGET).map((row) => row.id)).toEqual([seeded.rowId, person.id]);
    expect(store.get(seeded.recordId)).toMatchObject({ status: 'queued' });
  });
});

describe('steerQueuedChatMessage, more', () => {
  it.each([
    ['a Wi-Fi hold', JSON.stringify([{ carriedOutsider: true }])],
    ['outside words', JSON.stringify([{ carriedWords: true }])],
  ])(
    'never joins a running turn when its sender’s turn passed on %s',
    async (_what, ceilingJson) => {
      // The sender's live turn is clean now; what it carried at send time rides on the row.
      const seeded = seedChatMessage({ ceilingJson });

      await expect(steerQueuedChatMessage(TARGET, seeded.rowId)).resolves.toEqual({
        outcome: 'moved-to-front',
        reason: 'steer-not-allowed',
      });
      expect(steerInto).not.toHaveBeenCalled();
    }
  );

  it('holds the row before its first wait, so no turn or drain join can take it meanwhile', async () => {
    const seeded = seedChatMessage();
    let heldWhileChecking = false;
    setQueuedChatActionsDeps({
      store,
      isBusy: async () => {
        heldWhileChecking = steering.has(seeded.rowId);
        return true;
      },
      turnLevelOf: (sessionId) => levels.get(sessionId),
      steerInto,
      emitActivity,
      operatorName: () => 'Dana',
    });

    await steerQueuedChatMessage(TARGET, seeded.rowId);

    expect(heldWhileChecking).toBe(true);
  });

  it('answers not-found when the queue was cleared while it waited', async () => {
    const seeded = seedChatMessage();
    steerInto.mockImplementationOnce(async () => {
      queue.remove(seeded.rowId);
      return false;
    });

    await expect(steerQueuedChatMessage(TARGET, seeded.rowId)).resolves.toEqual({
      outcome: 'not-found',
    });
  });

  it('holds the row off the queue pump while the steer is in flight, then lets go', async () => {
    const seeded = seedChatMessage();
    let heldDuringSteer = false;
    steerInto.mockImplementationOnce(async () => {
      heldDuringSteer = steering.has(seeded.rowId);
      return true;
    });

    await steerQueuedChatMessage(TARGET, seeded.rowId);

    expect(heldDuringSteer).toBe(true);
    expect(steering.has(seeded.rowId)).toBe(false);
  });

  it('puts the row first, still queued, when the steer does not land', async () => {
    const person = queue.enqueue({ sessionId: TARGET, content: 'person', clientId: 'window-a' });
    const seeded = seedChatMessage();
    steerInto.mockResolvedValueOnce(false);

    await expect(steerQueuedChatMessage(TARGET, seeded.rowId)).resolves.toEqual({
      outcome: 'moved-to-front',
      reason: 'steer-did-not-land',
    });

    expect(queue.list(TARGET).map((row) => row.id)).toEqual([seeded.rowId, person.id]);
    expect(store.get(seeded.recordId)?.status).toBe('queued');
    expect(steering.has(seeded.rowId)).toBe(false);
  });

  it('puts the row first when nothing is running', async () => {
    const seeded = seedChatMessage();
    setQueuedChatActionsDeps({
      store,
      isBusy: async () => false,
      turnLevelOf: (sessionId) => levels.get(sessionId),
      steerInto,
      emitActivity,
      operatorName: () => 'Dana',
    });

    await expect(steerQueuedChatMessage(TARGET, seeded.rowId)).resolves.toEqual({
      outcome: 'moved-to-front',
      reason: 'no-running-turn',
    });
    expect(steerInto).not.toHaveBeenCalled();
  });

  it('never steers into a turn that runs looser than the sender', async () => {
    const seeded = seedChatMessage();
    levels.set(TARGET, { asks: 'never', reach: 'edit' });

    await expect(steerQueuedChatMessage(TARGET, seeded.rowId)).resolves.toMatchObject({
      outcome: 'moved-to-front',
      reason: 'steer-not-allowed',
    });
    expect(steerInto).not.toHaveBeenCalled();
  });

  it('refuses a row that is already starting, and a row the person wrote', async () => {
    const seeded = seedChatMessage();
    launching.add(seeded.rowId);
    await expect(steerQueuedChatMessage(TARGET, seeded.rowId)).resolves.toEqual({
      outcome: 'launching',
    });
    const own = queue.enqueue({ sessionId: TARGET, content: 'my draft', clientId: 'window-a' });
    await expect(steerQueuedChatMessage(TARGET, own.id)).resolves.toEqual({
      outcome: 'not-chat-row',
    });
    expect(steerInto).not.toHaveBeenCalled();
  });
});

describe('a person removing another chat’s queued message', () => {
  it('names the person in each sender’s record once the row is gone', () => {
    const seeded = seedChatMessage();
    seedChatMessage({ rowId: seeded.rowId, recordId: 'second', text: 'One more thing.' });

    const records = queuedChatRecordsOf(TARGET, seeded.rowId);
    expect(cancelQueuedMessage(TARGET, seeded.rowId)).toBeDefined();
    noteRemovedByPerson(records);

    for (const id of [seeded.recordId, 'second']) {
      expect(store.get(id)).toMatchObject({
        status: 'failed',
        failureReason: 'Dana removed it before it was delivered.',
      });
    }
    expect(emitActivity).toHaveBeenCalledWith(SENDER);
  });

  it('reads no records for the person’s own row or one already starting', () => {
    const own = queue.enqueue({ sessionId: TARGET, content: 'my draft', clientId: 'window-a' });
    expect(queuedChatRecordsOf(TARGET, own.id)).toEqual([]);

    const seeded = seedChatMessage();
    launching.add(seeded.rowId);
    expect(queuedChatRecordsOf(TARGET, seeded.rowId)).toEqual([]);
  });

  it('says "Someone" when the person has no name set', () => {
    const seeded = seedChatMessage();
    setQueuedChatActionsDeps({
      store,
      isBusy: async () => true,
      turnLevelOf: (sessionId) => levels.get(sessionId),
      steerInto,
      emitActivity,
      operatorName: () => null,
    });

    noteRemovedByPerson(queuedChatRecordsOf(TARGET, seeded.rowId));

    expect(store.get(seeded.recordId)?.failureReason).toBe(
      'Someone removed it before it was delivered.'
    );
  });
});
