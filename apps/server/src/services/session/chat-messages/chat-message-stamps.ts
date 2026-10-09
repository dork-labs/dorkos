/**
 * Put the sender on a received chat message, at the wire boundary (spec
 * `spin-off-chats` §2): `GET /api/sessions/:id/messages`, the `/events`
 * snapshot, and the live `turn_start` and `turn_input` events.
 *
 * A user message's text may hold one or more chat-message fences. Each fence's
 * nonce is looked up in `chat_messages` for THIS receiving chat; a match puts
 * a {@link ChatMessageStamp} on the message, and the app draws "From <agent> ·
 * <chat>" from the stamp alone. A fence with no matching row is somebody's
 * typing and stays plain text. One rule, one place, for every runtime: the
 * runtimes store the words; the server owns who sent them.
 *
 * @module services/session/chat-messages/chat-message-stamps
 */
import { chatMessageFenceNonces, type ChatMessageStamp } from '@dorkos/shared/chat-messages';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { ChatMessageRow } from '@dorkos/db';
import { getChatMessageStore, type ChatMessageStore } from './chat-message-store.js';

/**
 * The wire stamp for one stored chat message.
 *
 * @param row - The stored message.
 */
export function stampOf(row: ChatMessageRow): ChatMessageStamp {
  return {
    id: row.id,
    kind: row.kind,
    from: {
      chatId: row.fromSessionId,
      ...(row.fromChatTitle ? { chatTitle: row.fromChatTitle } : {}),
      ...(row.fromAgentId ? { agentId: row.fromAgentId } : {}),
      agentName: row.fromAgentName,
    },
    text: row.text,
    delivery: row.delivery,
    status: row.status,
    ...(row.replyToId ? { replyToId: row.replyToId } : {}),
    sentAt: row.createdAt,
  };
}

/**
 * The stamps for the fences in one piece of text, in the order they appear.
 *
 * @param store - The store.
 * @param sessionIds - Every id the receiving chat answers to.
 * @param content - The user message's text.
 */
function stampsFor(
  store: ChatMessageStore,
  sessionIds: readonly string[],
  content: string
): ChatMessageStamp[] {
  const nonces = chatMessageFenceNonces(content);
  if (nonces.length === 0) return [];
  const byNonce = new Map(store.findByNonces(sessionIds, nonces).map((row) => [row.nonce, row]));
  return nonces.flatMap((nonce) => {
    const row = byNonce.get(nonce);
    return row ? [stampOf(row)] : [];
  });
}

/**
 * Stamp every received chat message in a chat's history. Returns the input
 * array (same reference) when nothing in it was sent by another chat.
 *
 * @param sessionIds - Every id the chat answers to (the asked-for id and its canonical one).
 * @param messages - The history, in transcript order.
 * @param store - The store; the wired one when omitted.
 */
export function stampHistory<T extends Pick<HistoryMessage, 'role' | 'content' | 'chatMessages'>>(
  sessionIds: readonly string[],
  messages: T[],
  store: ChatMessageStore | undefined = getChatMessageStore()
): T[] {
  if (!store) return messages;
  let changed = false;
  const out = messages.map((message) => {
    if (message.role !== 'user') return message;
    const stamps = stampsFor(store, sessionIds, message.content);
    if (stamps.length === 0) return message;
    changed = true;
    return { ...message, chatMessages: stamps };
  });
  return changed ? out : messages;
}

/**
 * Stamp a live event that carries a user message: `turn_start` and
 * `turn_input`. Every other event is returned as it is.
 *
 * @param sessionIds - Every id the chat answers to.
 * @param event - The event.
 * @param store - The store; the wired one when omitted.
 */
export function stampEvent(
  sessionIds: readonly string[],
  event: SessionEvent,
  store: ChatMessageStore | undefined = getChatMessageStore()
): SessionEvent {
  if (!store) return event;
  if (event.type === 'turn_start' && event.userMessage) {
    const stamps = stampsFor(store, sessionIds, event.userMessage);
    return stamps.length > 0 ? { ...event, chatMessages: stamps } : event;
  }
  if (event.type === 'turn_input') {
    const stamps = stampsFor(store, sessionIds, event.content);
    return stamps.length > 0 ? { ...event, chatMessages: stamps } : event;
  }
  return event;
}
