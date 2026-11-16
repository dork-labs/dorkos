import { describe, expect, it } from 'vitest';
import { activityEvents, agents, sessionMetadata } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { ChatMessageStore } from '../../../session/chat-messages/chat-message-store.js';
import { MessageQueueStore } from '../../../session/message-queue-store.js';
import { recordPausedQueueActivity } from '../paused-queue-activity.js';

const AGENT = { id: 'scout', name: 'Scout', pausedAt: '2026-11-16T12:00:00.000Z' };

function world() {
  const db = createTestDb();
  db.insert(agents).values({
    id: AGENT.id, name: 'scout', projectPath: '/demo/scout',
    runtime: 'claude-code', registeredAt: AGENT.pausedAt, updatedAt: AGENT.pausedAt,
  }).run();
  db.insert(sessionMetadata).values({
    sessionId: 'target', agentPath: '/demo/scout', runtime: 'claude-code',
    createdAt: AGENT.pausedAt,
  }).run();
  const messages = new ChatMessageStore(db);
  const queue = new MessageQueueStore(db);
  function send(id: string, chat: string, title: string) {
    queue.enqueue({ id, sessionId: 'target', clientId: 'chat:' + chat, content: 'Keep this' });
    messages.insert({
      id: 'message-' + id, toSessionId: 'target', fromSessionId: chat,
      fromAgentPath: '/demo/atlas', fromAgentId: 'atlas', fromAgentName: 'Atlas',
      fromChatTitle: title, kind: 'message', text: 'Keep this', nonce: '12345678',
      delivery: 'queue', status: 'queued', queueMessageId: id,
    });
  }
  return { db, send, queue };
}

describe('Activity for messages held by a pause', () => {
  it('names one message and its sending chat, once for that pause', () => {
    const { db, send } = world();
    send('one', 'planning', 'Planning');
    recordPausedQueueActivity(db, AGENT);
    recordPausedQueueActivity(db, AGENT);
    const rows = db.select().from(activityEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe(
      'Scout was paused, so 1 message from Planning is held.'
    );
    expect(rows[0]?.linkPath).toBe('/session?session=target');
  });

  it('counts messages and distinct sending chats, excluding the person’s words', () => {
    const { db, send, queue } = world();
    send('one', 'planning', 'Planning');
    send('two', 'planning', 'Planning');
    send('three', 'review', 'Review');
    queue.enqueue({ sessionId: 'target', clientId: 'window', content: 'My words' });
    recordPausedQueueActivity(db, AGENT);
    expect(db.select().from(activityEvents).all()[0]?.summary).toBe(
      'Scout was paused, so 3 messages from 2 chats are held.'
    );
  });

  it('says nothing without chat messages and records a later pause separately', () => {
    const { db, send } = world();
    recordPausedQueueActivity(db, AGENT);
    expect(db.select().from(activityEvents).all()).toEqual([]);
    send('one', 'planning', 'Planning');
    recordPausedQueueActivity(db, AGENT);
    recordPausedQueueActivity(db, { ...AGENT, pausedAt: '2026-11-17T12:00:00.000Z' });
    expect(db.select().from(activityEvents).all()).toHaveLength(2);
  });
});
