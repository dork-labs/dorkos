/**
 * A queued message from another chat shows a person its sender and words, never
 * the fenced envelope the model gets (DOR-3060). The envelope itself stays on
 * the row, unchanged, for the model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessageRow } from '@dorkos/db';
import { CHAT_MESSAGE_FENCE_LABEL, displayTextOf } from '@dorkos/shared/chat-messages';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import { CHAT_MESSAGE_LEAD, renderChatMessage } from '../chat-message-fence.js';
import { LEGACY_SENDER_NAME, LEGACY_WORDS, queuedChatViewOf } from '../queued-chat-view.js';
import {
  setQueuedChatView,
  toQueuedMessage,
  type QueuedMessageRecord,
} from '../../message-queue-store.js';

const BEGIN = `BEGIN ${CHAT_MESSAGE_FENCE_LABEL}`;

const security = {
  agentName: 'Security',
  agentId: 'agent-sec',
  chatId: 'chat-sec',
  chatTitle: 'Lane B review',
};

/** A fenced message, as `chat_send` puts it on a queue. */
function fenced(words: string, nonce = 'c0ffee12'): string {
  return renderChatMessage(security, 'message', words, nonce).text;
}

/** A queued row another chat sent. */
function chatRow(content: string, id = 'q-1'): QueuedMessage {
  return { id, content, disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'chat:chat-sec' };
}

/** The `chat_messages` record a row was sent as. */
function record(overrides: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    id: 'cm-1',
    toSessionId: 'chat-b',
    fromSessionId: 'chat-sec',
    fromAgentPath: '/agents/sec',
    fromAgentId: 'agent-sec',
    fromAgentName: 'Security',
    fromChatTitle: 'Lane B review',
    kind: 'message',
    text: 'Please hold PR #12.',
    summary: 'Hold PR #12',
    nonce: 'c0ffee12',
    delivery: 'queue',
    status: 'queued',
    failureReason: null,
    queueMessageId: 'q-1',
    ceilingJson: '{}',
    replyToId: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
    ...overrides,
  } as ChatMessageRow;
}

afterEach(() => {
  setQueuedChatView(undefined);
});

describe('displayTextOf', () => {
  it('replaces the envelope with the sender’s words', () => {
    const shown = displayTextOf(fenced('Please hold PR #12.'));
    expect(shown).toBe('Please hold PR #12.');
    expect(shown).not.toContain(BEGIN);
    expect(shown).not.toContain(CHAT_MESSAGE_LEAD);
  });

  it('keeps every message of a batch, in order, and nothing of their envelopes', () => {
    const batch = `${fenced('first', 'aaaaaaaa')}\n\n${fenced('second', 'bbbbbbbb')}`;
    expect(displayTextOf(batch)).toBe('first\n\nsecond');
  });

  it('leaves a message with no envelope exactly as it is', () => {
    expect(displayTextOf('my own words')).toBe('my own words');
  });
});

describe('queuedChatViewOf', () => {
  it('shows each sender and their words from the records the row was sent as', () => {
    const view = queuedChatViewOf(
      () => [record(), record({ id: 'cm-2', text: 'Also #13.', summary: null })],
      chatRow(fenced('ignored'))
    );

    expect(view?.content).toBe('Please hold PR #12.\n\nAlso #13.');
    expect(view?.fromChats).toEqual([
      {
        id: 'cm-1',
        kind: 'message',
        from: {
          chatId: 'chat-sec',
          chatTitle: 'Lane B review',
          agentId: 'agent-sec',
          agentName: 'Security',
        },
        summary: 'Hold PR #12',
        text: 'Please hold PR #12.',
      },
      {
        id: 'cm-2',
        kind: 'message',
        from: {
          chatId: 'chat-sec',
          chatTitle: 'Lane B review',
          agentId: 'agent-sec',
          agentName: 'Security',
        },
        text: 'Also #13.',
      },
    ]);
  });

  // Requirement 5: a row whose records are gone never shows the raw envelope.
  it('shows an old row as "Another chat" with the fence’s words', () => {
    const view = queuedChatViewOf(() => [], chatRow(fenced('Old words.')));
    expect(view?.content).toBe('Old words.');
    expect(view?.fromChats?.[0]).toMatchObject({
      from: { agentName: LEGACY_SENDER_NAME },
      text: 'Old words.',
      legacy: true,
    });
    expect(JSON.stringify(view)).not.toContain(BEGIN);
  });

  it('falls back to a plain sentence when even the fence’s words cannot be read', () => {
    const broken = `${CHAT_MESSAGE_LEAD}\n--- BEGIN ${CHAT_MESSAGE_FENCE_LABEL} deadbeef ---\nno header\n--- END ${CHAT_MESSAGE_FENCE_LABEL} deadbeef ---`;
    const view = queuedChatViewOf(() => [], chatRow(broken));
    expect(view?.content).toBe(LEGACY_WORDS);
  });

  it('leaves a person’s row alone', () => {
    const mine: QueuedMessage = { ...chatRow('my words'), enqueuedBy: 'client-1' };
    expect(queuedChatViewOf(() => [record()], mine)).toBeUndefined();
  });
});

describe('the queue a person reads', () => {
  // Requirement 4: no queue item contains the envelope, and the row still holds
  // it for the model.
  it('never carries the envelope, while the stored row keeps it for the model', () => {
    const stored: QueuedMessageRecord = {
      ...chatRow(fenced('Please hold PR #12.')),
      position: 1,
      context: null,
      heldToDefault: false,
    };
    setQueuedChatView((row) => queuedChatViewOf(() => [record()], row));

    const shown = toQueuedMessage(stored);

    expect(JSON.stringify(shown)).not.toContain(BEGIN);
    expect(JSON.stringify(shown)).not.toContain(CHAT_MESSAGE_LEAD);
    expect(shown.content).toBe('Please hold PR #12.');
    expect(shown.fromChats?.[0]?.from.agentName).toBe('Security');
    // What the dispatcher launches is the stored row, still fenced.
    expect(stored.content).toContain(BEGIN);
  });
});
