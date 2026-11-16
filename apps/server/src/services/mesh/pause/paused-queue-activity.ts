import { ulid } from 'ulidx';
import {
  activityEvents,
  agents,
  chatMessages,
  sessionMessageQueue,
  sessionMetadata,
  and,
  eq,
  type Db,
} from '@dorkos/db';
import type { PausedAgentRef } from './agent-pause.js';

/**
 * Record the waiting chat messages once per pause. This is a snapshot of the
 * held queue, not a counter rewritten as messages arrive: Activity and its audit
 * copy are append-only. The durable pause time also deduplicates after restart.
 *
 * @param db - The Activity and queue store
 * @param agent - The paused agent and durable pause time
 */
export function recordPausedQueueActivity(db: Db, agent: PausedAgentRef): void {
  if (!agent.pausedAt) return;
  db.transaction(() => {
    const already = db
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.eventType, 'agent.messages_held'),
          eq(activityEvents.resourceId, agent.id),
          eq(activityEvents.occurredAt, agent.pausedAt!)
        )
      )
      .get();
    if (already) return;
    const held = db
      .select({
        chatId: chatMessages.fromSessionId,
        chatTitle: chatMessages.fromChatTitle,
        sessionId: sessionMetadata.sessionId,
      })
      .from(sessionMessageQueue)
      .innerJoin(chatMessages, eq(chatMessages.queueMessageId, sessionMessageQueue.id))
      .innerJoin(sessionMetadata, eq(sessionMetadata.sessionId, sessionMessageQueue.sessionId))
      .innerJoin(agents, eq(agents.projectPath, sessionMetadata.agentPath))
      .where(eq(agents.id, agent.id))
      .all();
    if (held.length === 0) return;
    const chats = new Set(held.map((message) => message.chatId)).size;
    const summary =
      held.length === 1
        ? `${agent.name} was paused, so 1 message from ${held[0]!.chatTitle ?? 'another chat'} is held.`
        : `${agent.name} was paused, so ${held.length} messages from ${chats} ${chats === 1 ? 'chat' : 'chats'} are held.`;
    // Each held dispatch already has an immutable audit event. This feed
    // snapshot summarizes those holds without recording the same action twice.
    const now = new Date().toISOString();
    db.insert(activityEvents)
      .values({
        id: ulid(),
        occurredAt: agent.pausedAt!,
        createdAt: now,
        actorType: 'system',
        actorLabel: 'DorkOS',
        category: 'agent',
        eventType: 'agent.messages_held',
        resourceType: 'agent',
        resourceId: agent.id,
        resourceLabel: agent.name,
        summary,
        linkPath: `/session?session=${held[0]!.sessionId}`,
        metadata: JSON.stringify({ pausedAt: agent.pausedAt, messages: held.length, chats }),
      })
      .run();
  });
}
