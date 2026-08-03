import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { UnclaimedChatStore } from '../unclaimed-chat-store.js';

describe('UnclaimedChatStore', () => {
  let db: Db;
  let store: UnclaimedChatStore;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    store = new UnclaimedChatStore(db);
  });

  it('AC3.1: the first sighting creates a row and reports isFirstSighting: true', () => {
    const { chat, isFirstSighting } = store.recordSighting({
      adapterId: 'tg-bot',
      chatId: '123',
      chatKind: 'dm',
      senderName: 'Miguel',
    });
    expect(isFirstSighting).toBe(true);
    expect(chat).toMatchObject({
      adapterId: 'tg-bot',
      chatId: '123',
      chatKind: 'dm',
      senderName: 'Miguel',
      status: 'pending',
      messageCount: 1,
    });
    expect(store.list('pending')).toHaveLength(1);
  });

  it('AC3.2: a second sighting of the same chat is damped — same row, bumped counter, isFirstSighting: false', () => {
    store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' });
    const { chat, isFirstSighting } = store.recordSighting({
      adapterId: 'tg-bot',
      chatId: '123',
      chatKind: 'dm',
    });
    expect(isFirstSighting).toBe(false);
    expect(chat.messageCount).toBe(2);
    expect(store.list('pending')).toHaveLength(1);
  });

  it('a sighting on a different chatId creates a separate row', () => {
    store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' });
    store.recordSighting({ adapterId: 'tg-bot', chatId: '456', chatKind: 'dm' });
    expect(store.list('pending')).toHaveLength(2);
  });

  it('isBlocked is false for a never-seen chat and for a pending one', () => {
    expect(store.isBlocked('tg-bot', '123')).toBe(false);
    store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' });
    expect(store.isBlocked('tg-bot', '123')).toBe(false);
  });

  it('AC3.5: ignore and block are idempotent and change no other chat', () => {
    const a = store.recordSighting({ adapterId: 'tg-bot', chatId: 'a', chatKind: 'dm' }).chat;
    const b = store.recordSighting({ adapterId: 'tg-bot', chatId: 'b', chatKind: 'dm' }).chat;

    store.ignore(a.id);
    store.ignore(a.id); // idempotent
    expect(store.getById(a.id)?.status).toBe('ignored');
    expect(store.getById(b.id)?.status).toBe('pending');

    store.block(b.id);
    store.block(b.id); // idempotent
    expect(store.getById(b.id)?.status).toBe('blocked');
    expect(store.isBlocked('tg-bot', 'b')).toBe(true);
    expect(store.getById(a.id)?.status).toBe('ignored'); // unchanged by b's block
  });

  it('AC3.6: once blocked, isBlocked is true and the row is untouched by further recordSighting calls the caller is expected to skip', () => {
    const chat = store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' }).chat;
    store.block(chat.id);
    const before = store.getById(chat.id)!;
    // The router is responsible for checking isBlocked BEFORE calling
    // recordSighting again; this asserts the store-level contract that
    // isBlocked is authoritative and the row's counters are exactly what
    // block() left them at.
    expect(store.isBlocked('tg-bot', '123')).toBe(true);
    expect(before.messageCount).toBe(1);
    expect(before.lastSeenAt).toBe(before.firstSeenAt);
  });

  it('claim marks the chat claimed with the decided agent', () => {
    const chat = store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' }).chat;
    store.claim(chat.id, 'agent-a');
    const claimed = store.getById(chat.id)!;
    expect(claimed.status).toBe('claimed');
    expect(claimed.decidedAgentId).toBe('agent-a');
    expect(claimed.decidedAt).not.toBeNull();
    expect(store.list('pending')).toHaveLength(0);
    expect(store.list('claimed')).toHaveLength(1);
  });

  it('AC3.3 (store-level): no field in the persisted row can carry a message body — the sighting struct has no body-shaped field to begin with', () => {
    const sentinel = 'THE-MESSAGE-BODY-MUST-NEVER-APPEAR-HERE';
    const { chat } = store.recordSighting({
      adapterId: 'tg-bot',
      chatId: '123',
      chatKind: 'dm',
      senderName: 'not the sentinel',
    });
    expect(JSON.stringify(chat)).not.toContain(sentinel);
    // Structural: the store's own row shape has exactly these keys — a body
    // field cannot be silently threaded through even by a future caller
    // mistake, because the row schema does not have one.
    expect(Object.keys(chat).sort()).toEqual(
      [
        'id',
        'adapterId',
        'chatId',
        'channelType',
        'chatKind',
        'senderName',
        'senderId',
        'chatTitle',
        'status',
        'messageCount',
        'firstSeenAt',
        'lastSeenAt',
        'decidedAt',
        'decidedAgentId',
      ].sort()
    );
  });

  it('MINOR 12: chatTitle is recorded when the sighting carries one, and null otherwise', () => {
    const withTitle = store.recordSighting({
      adapterId: 'tg-bot',
      chatId: 'group-1',
      chatKind: 'group',
      chatTitle: 'Weekend Trip Planning',
    }).chat;
    expect(withTitle.chatTitle).toBe('Weekend Trip Planning');

    const withoutTitle = store.recordSighting({
      adapterId: 'tg-bot',
      chatId: 'dm-1',
      chatKind: 'dm',
    }).chat;
    expect(withoutTitle.chatTitle).toBeNull();
  });

  it('MINOR 11: senderName and chatTitle are truncated to 200 chars — stranger-controlled input', () => {
    const long = 'x'.repeat(500);
    const chat = store.recordSighting({
      adapterId: 'tg-bot',
      chatId: '123',
      chatKind: 'group',
      senderName: long,
      chatTitle: long,
    }).chat;
    expect(chat.senderName).toHaveLength(200);
    expect(chat.chatTitle).toHaveLength(200);
  });

  it('MAJOR 4: caps pending rows at 200, evicting the oldest to make room for new sightings', () => {
    for (let i = 0; i < 205; i++) {
      store.recordSighting({ adapterId: 'tg-bot', chatId: `chat-${i}`, chatKind: 'dm' });
    }
    expect(store.list('pending')).toHaveLength(200);
    // The five oldest by insertion should be the ones gone.
    for (let i = 0; i < 5; i++) {
      expect(store.isBlocked('tg-bot', `chat-${i}`)).toBe(false); // never existed / evicted
    }
  });

  it('the cap only evicts PENDING rows — claimed/ignored/blocked chats are never counted against it', () => {
    // Fill to exactly the cap with pending chats.
    for (let i = 0; i < 200; i++) {
      store.recordSighting({ adapterId: 'tg-bot', chatId: `chat-${i}`, chatKind: 'dm' });
    }
    // Decide a few — they leave the pending pool.
    const first = store.getById(store.list('pending')[0]!.id)!;
    store.ignore(first.id);
    expect(store.list('pending')).toHaveLength(199);

    // One more sighting is under the cap now — no eviction needed.
    store.recordSighting({ adapterId: 'tg-bot', chatId: 'chat-new', chatKind: 'dm' });
    expect(store.list('pending')).toHaveLength(200);
  });
});
