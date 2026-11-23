import { ulid } from 'ulidx';
import { sessionPath } from '@dorkos/shared/session-link';
import {
  activityEvents,
  agents,
  chatMessages,
  sessionMessageQueue,
  and,
  eq,
  type Db,
} from '@dorkos/db';
import { sessionAgentOf } from '../../core/agent-identity/session-agent.js';
import type { PausedAgentRef } from './agent-pause.js';

/**
 * Record the waiting chat messages once per pause. This is a snapshot of the
 * held queue, not a counter rewritten as messages arrive: Activity and its audit
 * copy are append-only. The durable pause time also deduplicates after restart.
 * A chat's agent is `session-agent`'s answer, so a chat started with only its
 * agent's folder counts too (DOR-5038).
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
    const home = db
      .select({ projectPath: agents.projectPath })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .get()?.projectPath;
    if (!home) return;
    // Every queued chat message, then each target chat's agent once: a chat with no recorded
    // agent has nothing to join on. Queues are small and this runs once per pause.
    const owners = new Map<string, string | undefined>();
    const ownerOf = (sessionId: string): string | undefined => {
      if (!owners.has(sessionId)) owners.set(sessionId, sessionAgentOf(db, sessionId));
      return owners.get(sessionId);
    };
    const held = db
      .select({
        chatId: chatMessages.fromSessionId,
        chatTitle: chatMessages.fromChatTitle,
        sessionId: sessionMessageQueue.sessionId,
      })
      .from(sessionMessageQueue)
      .innerJoin(chatMessages, eq(chatMessages.queueMessageId, sessionMessageQueue.id))
      .all()
      .filter((message) => ownerOf(message.sessionId) === home);
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
        linkPath: sessionPath({ session: held[0]!.sessionId }),
        metadata: JSON.stringify({ pausedAt: agent.pausedAt, messages: held.length, chats }),
      })
      .run();
  });
}
