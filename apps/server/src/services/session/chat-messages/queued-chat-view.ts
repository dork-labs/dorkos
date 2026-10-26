/**
 * What a queued row another chat sent shows a person (DOR-3060).
 *
 * The row holds the fenced envelope, because that is what the model is handed
 * when the row launches, and the fence is a prompt-injection defence that must
 * not change. A person never reads the row as stored: every place the queue
 * leaves the server goes through `toQueuedMessage`, and this is the view it
 * applies there. It answers with the senders and their own words, from the
 * `chat_messages` records the row was sent as.
 *
 * A row written before those records linked to it, or whose records are gone,
 * falls back to the fence's words under "Another chat"; the envelope itself is
 * never shown.
 *
 * @module services/session/chat-messages/queued-chat-view
 */
import type { ChatMessageRow } from '@dorkos/db';
import {
  chatMessageFenceNonces,
  chatMessageWords,
  type QueuedChatEntry,
} from '@dorkos/shared/chat-messages';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import type { QueuedChatView } from '../message-queue-store.js';
import { isChatClientId } from './chat-client-id.js';

/** The sender name on a row whose sender could not be found again. */
export const LEGACY_SENDER_NAME = 'Another chat';

/** The words on such a row when even the fence's words cannot be read. */
export const LEGACY_WORDS = 'A message from another chat.';

/**
 * The records a queued row was sent as, in send order.
 *
 * @param queueMessageId - The queued row's id
 */
export type QueuedChatRecords = (queueMessageId: string) => ChatMessageRow[];

/**
 * One record as a queued row shows it.
 *
 * @param row - A chat message record
 */
function entryOf(row: ChatMessageRow): QueuedChatEntry {
  return {
    id: row.id,
    kind: row.kind,
    from: {
      chatId: row.fromSessionId,
      ...(row.fromChatTitle ? { chatTitle: row.fromChatTitle } : {}),
      ...(row.fromAgentId ? { agentId: row.fromAgentId } : {}),
      agentName: row.fromAgentName,
    },
    ...(row.summary ? { summary: row.summary } : {}),
    text: row.text,
  };
}

/**
 * What a person sees for one queued row, or `undefined` for a row no other chat
 * sent (it shows as stored).
 *
 * @param records - The records a queued row was sent as
 * @param row - The queued row, as the store reads it
 */
export function queuedChatViewOf(
  records: QueuedChatRecords,
  row: QueuedMessage
): QueuedChatView | undefined {
  if (!isChatClientId(row.enqueuedBy)) return undefined;
  const sent = records(row.id);
  if (sent.length > 0) {
    return { content: sent.map((r) => r.text).join('\n\n'), fromChats: sent.map(entryOf) };
  }
  // No fence at all: whatever this is, it is not the envelope, so it shows as is.
  if (chatMessageFenceNonces(row.content).length === 0) return undefined;
  const text = chatMessageWords(row.content) || LEGACY_WORDS;
  return {
    content: text,
    fromChats: [
      {
        id: row.id,
        kind: 'message',
        from: { chatId: '', agentName: LEGACY_SENDER_NAME },
        text,
        legacy: true,
      },
    ],
  };
}
