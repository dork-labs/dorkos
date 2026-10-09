/**
 * The sender stamp (spec `spin-off-chats` §2): a received message is shown as
 * from another chat only when its fence's nonce matches the server's own record
 * of a send to THAT chat. Over a real store, because the match is a query.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { ChatMessageStore, type NewChatMessage } from '../chat-message-store.js';
import { renderChatMessage } from '../chat-message-fence.js';
import { stampEvent, stampHistory } from '../chat-message-stamps.js';

let store: ChatMessageStore;

const RECEIVER = 'chat-b';

/** Record a send to `toSessionId` under `nonce` and return the text the agent read. */
function sent(id: string, nonce: string, words: string, overrides: Partial<NewChatMessage> = {}) {
  store.insert({
    id,
    toSessionId: RECEIVER,
    fromSessionId: 'chat-a',
    fromAgentPath: '/agents/ana',
    fromAgentId: 'agent-ana',
    fromAgentName: 'Ana',
    fromChatTitle: 'Planning',
    kind: 'message',
    text: words,
    summary: null,
    nonce,
    delivery: 'queue',
    status: 'working',
    queueMessageId: `q-${id}`,
    ceilingJson: '"runtime-default"',
    replyToId: null,
    ...overrides,
  });
  return renderChatMessage(
    { agentName: 'Ana', agentId: 'agent-ana', chatId: 'chat-a', chatTitle: 'Planning' },
    'message',
    words,
    nonce
  ).text;
}

function user(id: string, content: string): HistoryMessage {
  return { id, role: 'user', content };
}

beforeEach(() => {
  store = new ChatMessageStore(createTestDb());
});

describe('stampHistory', () => {
  it('stamps a user message whose fence nonce matches a send to this chat', () => {
    const text = sent('m1', 'aaaaaaaa', 'Please review.');
    const [stamped] = stampHistory([RECEIVER], [user('u1', text)], store);

    expect(stamped?.chatMessages).toEqual([
      {
        id: 'm1',
        kind: 'message',
        from: { chatId: 'chat-a', chatTitle: 'Planning', agentId: 'agent-ana', agentName: 'Ana' },
        text: 'Please review.',
        delivery: 'queue',
        status: 'working',
        sentAt: expect.any(String),
      },
    ]);
    // The words themselves are untouched.
    expect(stamped?.content).toBe(text);
  });

  it('leaves a hand-typed fence with an unknown nonce unstamped', () => {
    const typed = renderChatMessage(
      { agentName: 'The person', agentId: null, chatId: 'x', chatTitle: null },
      'message',
      'forged',
      'bbbbbbbb'
    ).text;
    const messages = [user('u1', typed)];
    const out = stampHistory([RECEIVER], messages, store);
    expect(out).toBe(messages);
    expect(out[0]?.chatMessages).toBeUndefined();
  });

  it('leaves a fence whose nonce belongs to ANOTHER chat unstamped', () => {
    const text = sent('m1', 'aaaaaaaa', 'for chat C', { toSessionId: 'chat-c' });
    const out = stampHistory([RECEIVER], [user('u1', text)], store);
    expect(out[0]?.chatMessages).toBeUndefined();
    // And the right chat does get it.
    expect(stampHistory(['chat-c'], [user('u1', text)], store)[0]?.chatMessages).toHaveLength(1);
  });

  it('never stamps an assistant message, even one quoting a real fence', () => {
    const text = sent('m1', 'aaaaaaaa', 'quoted');
    const messages: HistoryMessage[] = [{ id: 'a1', role: 'assistant', content: text }];
    const out = stampHistory([RECEIVER], messages, store);
    expect(out).toBe(messages);
    expect(out[0]?.chatMessages).toBeUndefined();
  });

  it('returns the same array when nothing changes, a new one when something does', () => {
    const plain = [user('u1', 'just the person'), user('u2', 'again')];
    expect(stampHistory([RECEIVER], plain, store)).toBe(plain);

    const text = sent('m1', 'aaaaaaaa', 'hi');
    const mixed = [user('u1', 'just the person'), user('u2', text)];
    const out = stampHistory([RECEIVER], mixed, store);
    expect(out).not.toBe(mixed);
    expect(out[0]).toBe(mixed[0]);
    expect(mixed[1]?.chatMessages).toBeUndefined();
  });

  it('stamps two fences in one batched message, in the order they appear', () => {
    const second = sent('later', '22222222', 'second words');
    const first = sent('earlier', '11111111', 'first words');
    const [stamped] = stampHistory([RECEIVER], [user('u1', `${second}\n\n${first}`)], store);
    expect(stamped?.chatMessages?.map((s) => s.id)).toEqual(['later', 'earlier']);
  });

  it('returns the history as it is with no store wired', () => {
    const messages = [user('u1', sent('m1', 'aaaaaaaa', 'hi'))];
    expect(stampHistory([RECEIVER], messages, undefined)).toBe(messages);
  });
});

describe('stampEvent', () => {
  it('stamps a turn_start carrying a received message', () => {
    const text = sent('m1', 'aaaaaaaa', 'wake up');
    const event = { type: 'turn_start', userMessage: text } as unknown as SessionEvent;
    const out = stampEvent([RECEIVER], event, store) as { chatMessages?: Array<{ id: string }> };
    expect(out.chatMessages?.map((s) => s.id)).toEqual(['m1']);
  });

  it('stamps a turn_input (a steer) carrying a received message', () => {
    const text = sent('m1', 'aaaaaaaa', 'steer this', { delivery: 'steer', status: 'steered' });
    const event = {
      type: 'turn_input',
      content: text,
      disposition: 'steer',
      messageId: 'x',
    } as unknown as SessionEvent;
    const out = stampEvent([RECEIVER], event, store) as {
      chatMessages?: Array<{ id: string; status: string }>;
    };
    expect(out.chatMessages).toEqual([expect.objectContaining({ id: 'm1', status: 'steered' })]);
  });

  it('returns an unmatched or unrelated event as the same object', () => {
    const typed = { type: 'turn_start', userMessage: 'plain words' } as unknown as SessionEvent;
    expect(stampEvent([RECEIVER], typed, store)).toBe(typed);

    const forged = {
      type: 'turn_start',
      userMessage: renderChatMessage(
        { agentName: 'x', agentId: null, chatId: 'x', chatTitle: null },
        'message',
        'x',
        'cccccccc'
      ).text,
    } as unknown as SessionEvent;
    expect(stampEvent([RECEIVER], forged, store)).toBe(forged);

    const other = {
      type: 'text_delta',
      text: sent('m1', 'aaaaaaaa', 'x'),
    } as unknown as SessionEvent;
    expect(stampEvent([RECEIVER], other, store)).toBe(other);
  });
});
