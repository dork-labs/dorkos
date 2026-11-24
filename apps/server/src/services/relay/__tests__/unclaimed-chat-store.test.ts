import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import { UnclaimedChatStore } from '../unclaimed-chat-store.js';

describe('UnclaimedChatStore', () => {
  let store: UnclaimedChatStore;

  beforeEach(() => {
    const db = createDb(':memory:');
    runMigrations(db);
    store = new UnclaimedChatStore(db);
  });

  /** Record a sighting in `tg-bot`'s DM `chatId`. */
  const sight = (chatId: string, extra: Record<string, unknown> = {}) =>
    store.recordSighting({ adapterId: 'tg-bot', chatId, chatKind: 'dm', ...extra });

  it('AC3.1/AC3.2: the first sighting creates a pending row; a second is damped onto it', () => {
    const first = sight('123', { senderName: 'Miguel' });
    expect(first.isFirstSighting).toBe(true);
    expect(first.chat).toMatchObject({ senderName: 'Miguel', status: 'pending', messageCount: 1 });
    const second = sight('123');
    expect(second.isFirstSighting).toBe(false);
    expect(second.chat.messageCount).toBe(2);
    expect(store.list('pending')).toHaveLength(1);
  });

  it('DOR-907: keeps the raw platform chat type and title through a reload, null when absent', () => {
    const broadcast = sight('c1', {
      chatKind: 'group',
      platformChatType: 'channel',
      chatTitle: 'Weekend Trip Planning',
    }).chat;
    expect(store.getById(broadcast.id)).toMatchObject({
      chatKind: 'group',
      platformChatType: 'channel',
      chatTitle: 'Weekend Trip Planning',
    });
    const slack = sight('s1').chat;
    expect(store.getById(slack.id)).toMatchObject({ platformChatType: null, chatTitle: null });
  });

  it('AC3.5: ignore, block and claim are idempotent and touch no other chat', () => {
    const a = sight('a').chat;
    const b = sight('b').chat;
    const c = sight('c').chat;
    store.ignore(a.id);
    store.ignore(a.id);
    store.block(b.id);
    store.block(b.id);
    store.claim(c.id, 'agent-a');
    expect(store.getById(a.id)?.status).toBe('ignored');
    expect(store.isBlocked('tg-bot', 'a')).toBe(false);
    expect(store.isBlocked('tg-bot', 'b')).toBe(true);
    expect(store.getById(c.id)).toMatchObject({ status: 'claimed', decidedAgentId: 'agent-a' });
    expect(store.list('pending')).toHaveLength(0);
  });

  it('AC3.3: the row has no field that could carry a message body', () => {
    expect(Object.keys(sight('123').chat).sort()).toEqual(
      [
        'id',
        'adapterId',
        'chatId',
        'channelType',
        'chatKind',
        'platformChatType',
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

  it('truncates stranger-controlled names to 200 characters', () => {
    const long = 'x'.repeat(500);
    const chat = sight('123', { senderName: long, chatTitle: long }).chat;
    expect(chat.senderName).toHaveLength(200);
    expect(chat.chatTitle).toHaveLength(200);
  });

  it('MAJOR 4: caps PENDING rows at 200, evicting the oldest, and never counts decided ones', () => {
    for (let i = 0; i < 205; i++) sight(`chat-${i}`);
    expect(store.list('pending')).toHaveLength(200);
    expect(store.list('pending').some((c) => c.chatId === 'chat-0')).toBe(false);
    store.ignore(store.list('pending')[0]!.id);
    sight('chat-new');
    expect(store.list('pending')).toHaveLength(200);
    expect(store.list('ignored')).toHaveLength(1);
  });

  // DOR-2608: removing a connection deletes every chat it recorded, matching the whole id.
  describe('deleteForConnection', () => {
    it('deletes every status for that connection and reports how many went', () => {
      for (const chatId of ['p', 'c', 'i', 'b']) {
        store.recordSighting({ adapterId: 'tg', chatId, chatKind: 'dm' });
      }
      const idOf = (chatId: string) => store.list('pending').find((c) => c.chatId === chatId)!.id;
      store.claim(idOf('c'), 'agent-1');
      store.ignore(idOf('i'));
      store.block(idOf('b'));
      expect(store.deleteForConnection('tg')).toBe(4);
      for (const status of ['pending', 'claimed', 'ignored', 'blocked'] as const) {
        expect(store.list(status)).toEqual([]);
      }
    });

    it('leaves a connection whose id only starts with, or looks like a pattern for, the removed one', () => {
      for (const adapterId of ['tg', 'tg-2', 'tgx']) {
        store.recordSighting({ adapterId, chatId: '1', chatKind: 'dm' });
      }
      expect(store.deleteForConnection('tg')).toBe(1);
      expect(store.deleteForConnection('tg%')).toBe(0);
      expect(store.deleteForConnection('t_')).toBe(0);
      expect(store.deleteForConnection('slack')).toBe(0);
      expect(
        store
          .list('pending')
          .map((c) => c.adapterId)
          .sort()
      ).toEqual(['tg-2', 'tgx']);
    });
  });
});
