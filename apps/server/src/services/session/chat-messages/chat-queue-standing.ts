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
import { emitQueueUpdate } from '../queue-stream-events.js';
import { queueKeyOf } from '../resolution/session-key-registry.js';
import { AGENT_LAUNCH_CAP_SETTING, agentLaunchMaxLive } from '../launch/launch-session.js';
import type { ChatMessageStore } from './chat-message-store.js';
import type { TurnRefusal } from '../launch/turn-not-started.js';

/**
 * What a send refused by the machine-load launch cap answers. Not the
 * spin-off sentence the cap gives `session_start`: a message to an agent's DM
 * is no spin-off, and agents that read it as one rewrote and resent their
 * words somewhere else.
 */
export function chatLaunchCapMessage(): string {
  return (
    `Not sent: ${agentLaunchMaxLive()} agent chats are already running on this computer, ` +
    'and this one would be new. ' +
    'Nothing was kept. Send the same message again in a few minutes. ' +
    `A person can raise the limit with the ${AGENT_LAUNCH_CAP_SETTING} setting.`
  );
}

/** How many of a chat's recent sends to one chat `chat_read` reports. */
export const YOUR_MESSAGES_MAX = 5;

/** Where a waiting message is in its chat's queue. */
export interface QueueStanding {
  /** 1-based place in line. */
  position: number;
  /** How many messages run before it. */
  ahead: number;
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
  return { position: index + 1, ahead: index };
}

/**
 * Move a queue row to the head of its chat's queue.
 *
 * @param chatId - The receiving chat.
 * @param queueMessageId - The queue row.
 * @returns Its new position.
 */
export function moveToHead(chatId: string, queueMessageId: string): number {
  const queue = getMessageQueueStore();
  const head = queue?.list(queueKeyOf(chatId))[0];
  if (queue && head && head.id !== queueMessageId) {
    queue.move(queueMessageId, { before: head.id });
    emitQueueUpdate(chatId);
  }
  return 1;
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
 * What a sender is told when the chat it wrote to refused the turn before its
 * agent saw the message. Written for the sender: the refusing chat's own error
 * speaks to that chat's person ("answer the open request"), which the sender
 * cannot do and must not try to.
 */
const NOT_DELIVERED: Record<TurnRefusal, string> = {
  'warm-ceiling': 'Not delivered: that computer has too many chats open. Send it again later.',
  'pending-interaction': 'Not delivered: that chat is waiting on its person. Send it again later.',
  'crash-loop': 'Not delivered: that chat’s agent keeps stopping. Its person needs to look.',
  'account-pin':
    'Not delivered: that chat runs on another account. Its person needs to restart it.',
};

/**
 * Why a message's turn failed, for its sender.
 *
 * @param refusal - Why the chat refused the turn before its agent saw the
 *   message, when it did.
 */
export function settledFailureReason(refusal: string | undefined): string {
  if (refusal === undefined) return 'The chat’s turn ended with an error.';
  return (
    NOT_DELIVERED[refusal as TurnRefusal] ??
    'Not delivered: that chat could not start. Send it again later.'
  );
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
    .latestSentTo(fromSessionId, toSessionId, YOUR_MESSAGES_MAX)
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
