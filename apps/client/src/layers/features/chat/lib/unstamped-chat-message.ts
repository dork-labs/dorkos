/**
 * Another chat's words with no sender on record (DOR-3060).
 *
 * The server stamps a received chat message with its sender by looking up the
 * fence's nonce. When that record is gone, the message still carries the
 * envelope the model read ("This message is from another chat…", then the
 * fence). A person must never read that envelope, and must never see those
 * words as their own: the transcript shows them under "Another chat", as the
 * fence's words in plain text.
 *
 * A person who pastes a whole envelope into a message of their own reads it
 * back under "Another chat" too. That only ever names fewer people, never someone
 * who did not write it, so it is the safe way to be wrong.
 *
 * @module features/chat/lib/unstamped-chat-message
 */
import { chatMessageFenceNonces, displayTextOf } from '@dorkos/shared/chat-messages';
import type { ChatMessage } from '@/layers/shared/model';

/** The name another chat's words go under when nobody knows who sent them. */
export const UNKNOWN_CHAT_SENDER = 'Another chat';

/**
 * Whether a user message holds another chat's fenced words that carry no
 * sender stamp.
 *
 * Only a message nobody else is named for. A fence is plain text anyone can
 * type, so a room post (whose room names its author) and a prompt with a
 * source (a channel, a schedule, a heartbeat) keep the name they have: a
 * stranger quoting a fence must never pass for one of the person's own chats.
 *
 * @param message - The user message.
 */
export function isUnstampedChatMessage(
  message: Pick<ChatMessage, 'content' | 'chatMessages' | 'roomMessage' | 'promptSource'>
): boolean {
  if (message.chatMessages?.length || message.roomMessage || message.promptSource) return false;
  return chatMessageFenceNonces(message.content).length > 0;
}

/**
 * The words of an unstamped chat message, without the envelope, or a plain
 * placeholder when nothing is left.
 *
 * @param content - The user message's raw text.
 */
export function unstampedChatWords(content: string): string {
  return displayTextOf(content) || 'A message from another chat.';
}
