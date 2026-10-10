/**
 * `chat_read`'s reach (spec `spin-off-chats` §4) under the reader rule (spec
 * `audit-trail` §3.4): a person's own chat is readable by a chat it started,
 * the one deliberate exception, and by no other chat. A message is not enough.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import {
  SessionStartedByStore,
  setSessionStartedByStore,
} from '../../origin/session-started-by-store.js';
import {
  initSessionVisibility,
  resetSessionVisibility,
} from '../../../audit/session-visibility.js';
import { ChatMessageStore } from '../chat-message-store.js';
import { mayReadChat, maySeeChat } from '../chat-message-wiring.js';

/** The person's own chats; every other id is agent work. */
const PRIVATE = new Set(['person-chat', 'person-other', 'grandchild-private']);

let db: Db;
let store: ChatMessageStore;
let startedBy: SessionStartedByStore;
let clock = 0;

const start = (sessionId: string, from: string) =>
  startedBy.insert({
    sessionId,
    kind: 'chat',
    extensionId: null,
    startedBySessionId: from,
    originExtensionId: null,
    reason: null,
    createdAt: new Date(Date.UTC(2026, 9, 10, 12, 0, clock++)).toISOString(),
  });

const send = (from: string, to: string) =>
  store.insert({
    id: `m-${from}-${to}`,
    toSessionId: to,
    fromSessionId: from,
    fromAgentPath: '/agents/ana',
    fromAgentId: 'agent-ana',
    fromAgentName: 'Ana',
    fromChatTitle: null,
    kind: 'message',
    text: 'hello',
    summary: null,
    nonce: `n${clock++}`.padEnd(8, '0'),
    delivery: 'queue',
    status: 'queued',
    queueMessageId: null,
    ceilingJson: JSON.stringify('runtime-default'),
    replyToId: null,
  });

const as = (sessionId: string) => ({ sessionId, agentPath: '/agents/bo' });

beforeEach(() => {
  db = createTestDb();
  store = new ChatMessageStore(db);
  startedBy = new SessionStartedByStore(db);
  setSessionStartedByStore(startedBy);
  initSessionVisibility(
    (ids) => new Map(ids.map((id) => [id, PRIVATE.has(id) ? 'participants' : 'space'] as const))
  );
});

afterEach(() => {
  setSessionStartedByStore(undefined);
  resetSessionVisibility();
});

describe('mayReadChat', () => {
  it('lets a chat read the private chat that started it', () => {
    start('spin-off', 'person-chat');
    expect(mayReadChat(store, as('spin-off'), 'person-chat')).toBe(true);
  });

  it('refuses a chat that drew a reply out of a private chat', () => {
    // Any agent chat may message a person's chat, and the reply comes back as
    // a message from that chat. That must not open the person's history.
    send('helper', 'person-other');
    send('person-other', 'helper');
    expect(mayReadChat(store, as('helper'), 'person-other')).toBe(false);
  });

  it('still reads agent work that messaged it', () => {
    send('agent-work', 'helper');
    expect(mayReadChat(store, as('helper'), 'agent-work')).toBe(true);
  });

  it('refuses every other chat a private chat, related or not', () => {
    start('spin-off', 'person-chat');
    start('grandchild', 'spin-off');
    // Two levels down: the private chat started its parent, not it.
    expect(mayReadChat(store, as('grandchild'), 'person-chat')).toBe(false);
    // A sibling, and a chat the private one never touched.
    start('sibling', 'other-agent-chat');
    expect(mayReadChat(store, as('sibling'), 'person-chat')).toBe(false);
    // A chat the reader sent to does not open it either.
    send('spin-off', 'person-other');
    expect(mayReadChat(store, as('spin-off'), 'person-other')).toBe(false);
  });

  it('refuses a private chat the reader reaches only as one it started', () => {
    start('grandchild-private', 'spin-off');
    expect(mayReadChat(store, as('spin-off'), 'grandchild-private')).toBe(false);
  });

  it('still reads agent work in reach: itself, its spin-offs, and theirs', () => {
    start('spin-off', 'lead');
    start('grandchild', 'spin-off');
    expect(mayReadChat(store, as('lead'), 'lead')).toBe(true);
    expect(mayReadChat(store, as('lead'), 'spin-off')).toBe(true);
    expect(mayReadChat(store, as('lead'), 'grandchild')).toBe(true);
    expect(mayReadChat(store, as('grandchild'), 'lead')).toBe(false);
  });
});

describe('maySeeChat', () => {
  it('names agent work and the private chat that started the reader, nothing else', () => {
    start('spin-off', 'person-chat');
    expect(maySeeChat(as('spin-off'), 'person-chat')).toBe(true);
    expect(maySeeChat(as('spin-off'), 'agent-work')).toBe(true);
    expect(maySeeChat(as('spin-off'), 'person-other')).toBe(false);
  });
});
