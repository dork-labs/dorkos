/**
 * Who sent a queued message that came from another chat, and the words the
 * queue says about it (DOR-3060; designer copy). Pure, so every rule is a
 * table test.
 *
 * A queued row from another agent must never read as the person's own words,
 * so the row names the agent and the chat it came from.
 *
 * @module features/chat/lib/queue-sender
 */
import type { QueuedMessage } from '@dorkos/shared/schemas';
import { UNKNOWN_CHAT_SENDER } from './unstamped-chat-message';

/** The agent and chat a queued message came from. */
export interface QueueSender {
  /** The sending agent's name. */
  agentName: string;
  /** Its Mesh id, for its face, when Mesh knew it. */
  agentId?: string;
  /** The chat it was sent from: what the title links to. */
  chatId: string;
  /** That chat's title. Absent when it could not be read: the row says "can't open". */
  chatTitle?: string;
  /**
   * The sender's one-line summary (`chat_send`'s `summary`), shown before the
   * words. Only for a row that carries one message, so it never stands in for
   * someone else's words.
   */
  summary?: string;
}

/** The name an unknown sender is shown under. */
export const UNKNOWN_SENDER = UNKNOWN_CHAT_SENDER;

/**
 * The sender of a queued message from another chat, or `null` when it cannot
 * be named (a row written before senders were recorded).
 *
 * @param fromChats - The message's `fromChats`, when the server sent any.
 */
export function queueSenderOf(fromChats: QueuedMessage['fromChats']): QueueSender | null {
  const first = fromChats?.[0];
  if (!first || first.legacy) return null;
  const { agentName, agentId, chatId, chatTitle } = first.from;
  return {
    agentName,
    chatId,
    ...(agentId ? { agentId } : {}),
    ...(chatTitle ? { chatTitle } : {}),
    ...(fromChats?.length === 1 && first.summary ? { summary: first.summary } : {}),
  };
}

/** What the header counts: whether each queued message came from another chat. */
export interface QueueHeaderRow {
  /** True when another chat sent it. */
  fromChat: boolean;
}

/**
 * The queue header's count. Only the person's own: "Queued (2)". Any message
 * from another chat: "3 waiting". It never names a sender: each row already
 * does, and the names crowded out when the queue sends.
 *
 * @param rows - The queued messages, in order.
 */
export function queueHeaderCount(rows: readonly QueueHeaderRow[]): string {
  return rows.some((row) => row.fromChat) ? `${rows.length} waiting` : `Queued (${rows.length})`;
}
