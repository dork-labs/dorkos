/**
 * The record of what chats sent each other (spec `spin-off-chats`), over a real
 * migrated SQLite database: the sender stamp, the launch ceiling and the read
 * cursor all read these rows, so a fake would only agree with itself.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { ChatMessageStore, type NewChatMessage } from '../chat-message-store.js';

let db: Db;
let store: ChatMessageStore;
let clock: number;

/** A row with every field filled, overridable per case. */
function message(overrides: Partial<NewChatMessage> = {}): NewChatMessage {
  return {
    id: 'm1',
    toSessionId: 'chat-b',
    fromSessionId: 'chat-a',
    fromAgentPath: '/agents/ana',
    fromAgentId: 'agent-ana',
    fromAgentName: 'Ana',
    fromChatTitle: 'Planning',
    kind: 'message',
    text: 'hello',
    summary: null,
    nonce: 'aaaaaaaa',
    delivery: 'queue',
    status: 'queued',
    queueMessageId: 'q1',
    ceilingJson: JSON.stringify('runtime-default'),
    replyToId: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = createTestDb();
  clock = Date.parse('2026-10-09T10:00:00.000Z');
  // Each write one second after the last, so createdAt orders deterministically.
  store = new ChatMessageStore(db, () => new Date((clock += 1000)));
});

describe('ChatMessageStore — rows', () => {
  it('inserts, reads back, updates and deletes a chat message', () => {
    const inserted = store.insert(message());
    expect(inserted.failureReason).toBeNull();
    expect(inserted.createdAt).toBe('2026-10-09T10:00:01.000Z');
    expect(store.get('m1')).toEqual(inserted);

    const updated = store.update('m1', { status: 'failed', failureReason: 'gone' });
    expect(updated?.status).toBe('failed');
    expect(updated?.failureReason).toBe('gone');
    expect(updated?.updatedAt).toBe('2026-10-09T10:00:02.000Z');
    expect(updated?.createdAt).toBe(inserted.createdAt);

    store.delete('m1');
    expect(store.get('m1')).toBeUndefined();
  });

  it('writes nothing for an empty patch', () => {
    const inserted = store.insert(message());
    expect(store.update('m1', {})).toEqual(inserted);
  });
});

describe('ChatMessageStore — findByNonces', () => {
  it('matches only rows addressed to the receiving chat', () => {
    store.insert(message({ id: 'to-b', toSessionId: 'chat-b', nonce: 'aaaaaaaa' }));
    store.insert(message({ id: 'to-c', toSessionId: 'chat-c', nonce: 'bbbbbbbb' }));

    expect(store.findByNonces(['chat-b'], ['aaaaaaaa', 'bbbbbbbb']).map((r) => r.id)).toEqual([
      'to-b',
    ]);
    // Chat C's nonce, asked for under chat B, is nobody's message here.
    expect(store.findByNonces(['chat-b'], ['bbbbbbbb'])).toEqual([]);
  });

  it('matches a row under any id the chat answers to', () => {
    store.insert(message({ id: 'to-b', toSessionId: 'canonical-b', nonce: 'aaaaaaaa' }));
    expect(
      store.findByNonces(['requested-b', 'canonical-b'], ['aaaaaaaa']).map((r) => r.id)
    ).toEqual(['to-b']);
  });

  it('answers nothing for no nonces or no ids', () => {
    store.insert(message());
    expect(store.findByNonces(['chat-b'], [])).toEqual([]);
    expect(store.findByNonces([], ['aaaaaaaa'])).toEqual([]);
  });
});

describe('ChatMessageStore — queue rows and threads', () => {
  it('lists every chat message batched into one queue row, oldest first', () => {
    store.insert(message({ id: 'first', queueMessageId: 'q1', nonce: '00000001' }));
    store.insert(message({ id: 'other', queueMessageId: 'q2', nonce: '00000002' }));
    store.insert(message({ id: 'second', queueMessageId: 'q1', nonce: '00000003' }));

    expect(store.listByQueueMessage('q1').map((r) => r.id)).toEqual(['first', 'second']);
    expect(store.listByQueueMessage('nothing')).toEqual([]);
  });

  it('latestUnanswered is the newest open message from one chat to another', () => {
    store.insert(message({ id: 'old', nonce: '00000001' }));
    store.insert(message({ id: 'newest', nonce: '00000002', status: 'working' }));
    // Not candidates: answered, failed, a stop, a report, and the other direction.
    store.insert(message({ id: 'answered', nonce: '00000003', status: 'replied' }));
    store.insert(message({ id: 'failed', nonce: '00000004', status: 'failed' }));
    store.insert(message({ id: 'stop', nonce: null, kind: 'stop', status: 'delivered' }));
    store.insert(message({ id: 'report', nonce: '00000005', kind: 'report' }));
    store.insert(
      message({ id: 'reverse', nonce: '00000006', fromSessionId: 'chat-b', toSessionId: 'chat-a' })
    );

    expect(store.latestUnanswered('chat-a', 'chat-b')?.id).toBe('newest');
    store.update('newest', { status: 'replied' });
    expect(store.latestUnanswered('chat-a', 'chat-b')?.id).toBe('old');
    expect(store.latestUnanswered('chat-b', 'chat-a')?.id).toBe('reverse');
    expect(store.latestUnanswered('chat-x', 'chat-b')).toBeUndefined();
  });

  it('sendersTo names only chats that wrote to this one, never a stop or the chat itself', () => {
    store.insert(
      message({ id: 'out', fromSessionId: 'me', toSessionId: 'sent-to', nonce: '00000001' })
    );
    store.insert(
      message({ id: 'in', fromSessionId: 'heard-from', toSessionId: 'me', nonce: '00000002' })
    );
    store.insert(
      message({
        id: 'stop',
        fromSessionId: 'stopper',
        toSessionId: 'me',
        kind: 'stop',
        nonce: null,
      })
    );
    store.insert(
      message({ id: 'unrelated', fromSessionId: 'x', toSessionId: 'y', nonce: '00000003' })
    );

    // Writing to a chat, or stopping it, never makes it readable.
    expect([...store.sendersTo('me')]).toEqual(['heard-from']);
    expect([...store.sendersTo('nobody')]).toEqual([]);
  });
});

describe('ChatMessageStore — DM chats and read cursors', () => {
  it('keeps one DM chat per (sender agent, receiving agent), replaced on a second keep', () => {
    expect(store.dmChat('/agents/ana', 'agent-bo')).toBeUndefined();
    store.keepDmChat('/agents/ana', 'agent-bo', 'dm-1');
    store.keepDmChat('/agents/cy', 'agent-bo', 'dm-other');
    expect(store.dmChat('/agents/ana', 'agent-bo')).toBe('dm-1');

    store.keepDmChat('/agents/ana', 'agent-bo', 'dm-2');
    expect(store.dmChat('/agents/ana', 'agent-bo')).toBe('dm-2');
    expect(store.dmChat('/agents/cy', 'agent-bo')).toBe('dm-other');
  });

  it('records and moves a reader’s cursor per (reader, target)', () => {
    expect(store.readCursor('reader', 'target')).toBeUndefined();
    store.setReadCursor('reader', 'target', 'msg-1');
    store.setReadCursor('reader', 'elsewhere', 'msg-x');
    expect(store.readCursor('reader', 'target')).toBe('msg-1');

    store.setReadCursor('reader', 'target', 'msg-2');
    expect(store.readCursor('reader', 'target')).toBe('msg-2');
    expect(store.readCursor('reader', 'elsewhere')).toBe('msg-x');
  });
});

describe('ChatMessageStore — rekeySession', () => {
  it('moves rows, DM chats and cursors to the new id, and a second call changes nothing', () => {
    store.insert(
      message({ id: 'to-old', toSessionId: 'old', fromSessionId: 'a', nonce: '00000001' })
    );
    store.insert(
      message({ id: 'from-old', toSessionId: 'b', fromSessionId: 'old', nonce: '00000002' })
    );
    store.insert(message({ id: 'other', toSessionId: 'x', fromSessionId: 'y', nonce: '00000003' }));
    store.keepDmChat('/agents/ana', 'agent-bo', 'old');
    store.setReadCursor('old', 'target', 'r1');
    store.setReadCursor('reader', 'old', 'r2');

    store.rekeySession('old', 'new');

    expect(store.get('to-old')?.toSessionId).toBe('new');
    expect(store.get('from-old')?.fromSessionId).toBe('new');
    expect(store.get('other')).toMatchObject({ toSessionId: 'x', fromSessionId: 'y' });
    expect(store.dmChat('/agents/ana', 'agent-bo')).toBe('new');
    expect(store.readCursor('new', 'target')).toBe('r1');
    expect(store.readCursor('reader', 'new')).toBe('r2');
    expect(store.readCursor('old', 'target')).toBeUndefined();
    expect(store.readCursor('reader', 'old')).toBeUndefined();
    expect(store.findByNonces(['new'], ['00000001']).map((r) => r.id)).toEqual(['to-old']);

    const snapshot = {
      rows: [store.get('to-old'), store.get('from-old'), store.get('other')],
      dm: store.dmChat('/agents/ana', 'agent-bo'),
      cursors: [store.readCursor('new', 'target'), store.readCursor('reader', 'new')],
    };
    store.rekeySession('old', 'new');
    expect({
      rows: [store.get('to-old'), store.get('from-old'), store.get('other')],
      dm: store.dmChat('/agents/ana', 'agent-bo'),
      cursors: [store.readCursor('new', 'target'), store.readCursor('reader', 'new')],
    }).toEqual(snapshot);
  });

  it('keeps a cursor already at the new id rather than overwriting it with the old one', () => {
    store.setReadCursor('reader', 'old', 'stale');
    store.setReadCursor('reader', 'new', 'fresh');
    store.rekeySession('old', 'new');
    expect(store.readCursor('reader', 'new')).toBe('fresh');
    expect(store.readCursor('reader', 'old')).toBeUndefined();
  });
});
