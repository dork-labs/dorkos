/**
 * Where a sent chat message stands, told truthfully (DOR-2994).
 *
 * A sender could not tell "queued behind a turn that may run for hours" from
 * "lost": the receipt gave a bare position and `chat_read` gave nothing. These
 * helpers say what is ahead of a waiting message, and why one failed, for both.
 *
 * @module services/session/chat-messages/chat-queue-standing
 */
import type { ChatMessageRow } from '@dorkos/db';
import type { ChatMessageStatus } from '@dorkos/shared/chat-messages';
import { getMessageQueueStore } from '../message-queue-store.js';
import { queueKeyOf } from '../resolution/session-key-registry.js';
import { AGENT_LAUNCH_MAX_LIVE } from '../launch/launch-session.js';
import { isChatClientId } from './chat-client-id.js';
import type { ChatMessageStore } from './chat-message-store.js';

/**
 * What a send refused by the machine-load launch cap answers. Not the
 * spin-off sentence the cap gives `session_start`: a message to an agent's DM
 * is no spin-off, and agents that read it as one rewrote and resent their
 * words somewhere else.
 */
export const CHAT_LAUNCH_CAP_MESSAGE =
  `Not sent: ${AGENT_LAUNCH_MAX_LIVE} agent chats are already running on this computer. ` +
  'Nothing was kept. Send the same message again in a few minutes.';

/** How many of a chat's recent sends to one chat `chat_read` reports. */
export const YOUR_MESSAGES_MAX = 5;

/** Where a waiting message is in its chat's queue. */
export interface QueueStanding {
  /** 1-based place in line. */
  position: number;
  /** How many messages run before it. */
  ahead: number;
  /** How many of those a person wrote; a person's words run first. */
  aheadFromPeople: number;
}

/**
 * One of the caller's own messages to a chat, as `chat_read` reports it; while
 * it waits, with its {@link QueueStanding}.
 */
export interface YourMessage extends Partial<QueueStanding> {
  id: string;
  status: ChatMessageStatus;
  sentAt: string;
  summary?: string;
  failureReason?: string;
}

/**
 * Where one queue row stands in its chat's queue, or `undefined` when it is
 * not waiting there (it started, or was taken off).
 *
 * @param chatId - The receiving chat.
 * @param queueMessageId - The queue row the message rides on.
 */
export function queueStanding(chatId: string, queueMessageId: string): QueueStanding | undefined {
  const rows = getMessageQueueStore()?.list(queueKeyOf(chatId)) ?? [];
  const index = rows.findIndex((row) => row.id === queueMessageId);
  if (index < 0) return undefined;
  const ahead = rows.slice(0, index);
  return {
    position: index + 1,
    ahead: ahead.length,
    aheadFromPeople: ahead.filter((row) => !isChatClientId(row.enqueuedBy)).length,
  };
}

/**
 * The place-in-line fields for a send's receipt: the full standing while the
 * row waits in the queue, else the dispatcher's bare position, else nothing.
 *
 * @param chatId - The receiving chat.
 * @param row - The sent message's row.
 * @param status - Its status after the send.
 * @param position - The dispatcher's position for it, when it gave one.
 */
export function waitingPlace(
  chatId: string,
  row: Pick<ChatMessageRow, 'queueMessageId'>,
  status: ChatMessageStatus,
  position: number | undefined
): Partial<QueueStanding> {
  if (status !== 'queued') return {};
  const standing = row.queueMessageId ? queueStanding(chatId, row.queueMessageId) : undefined;
  return standing ?? (position !== undefined ? { position } : {});
}

/**
 * Why a message's turn failed, for its sender.
 *
 * @param reason - The runtime's words when it refused the turn before the agent
 *   saw the message.
 */
export function settledFailureReason(reason: string | undefined): string {
  return reason !== undefined
    ? `Not delivered: the chat could not start a turn. ${reason}`
    : 'The chat’s turn ended with an error.';
}

/**
 * The caller's newest sends to one chat, oldest first, each with where it
 * stands, so a sender can tell waiting from delivered from lost.
 *
 * @param store - The chat-message store.
 * @param fromSessionId - The calling chat.
 * @param toSessionId - The chat being read.
 */
export function yourMessagesTo(
  store: ChatMessageStore,
  fromSessionId: string,
  toSessionId: string
): YourMessage[] {
  return store
    .listSentFrom(fromSessionId)
    .filter((row) => row.toSessionId === toSessionId && row.kind !== 'stop')
    .slice(-YOUR_MESSAGES_MAX)
    .map((row) => yourMessage(row, toSessionId));
}

function yourMessage(row: ChatMessageRow, chatId: string): YourMessage {
  const queue =
    row.status === 'queued' && row.queueMessageId
      ? queueStanding(chatId, row.queueMessageId)
      : undefined;
  return {
    id: row.id,
    status: row.status,
    sentAt: row.createdAt,
    ...(row.summary ? { summary: row.summary } : {}),
    ...queue,
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
  };
}
