/**
 * The lock identity a chat message is sent under (spec `spin-off-chats` §2):
 * `chat:<sending chat id>`. It is how a queue row says another chat sent it,
 * which the dispatcher reads for two rules: the person's words run first, and
 * a row another chat sent is held to its sender's level when it launches.
 *
 * A string format, so it lives here: the computer's dispatcher reads it and the
 * space side's chat messages write it, and neither imports the other for it.
 * Leaf module: it imports nothing.
 *
 * @module shared/chat-client-id
 */

/** The prefix of every chat-message lock identity. */
export const CHAT_CLIENT_PREFIX = 'chat:';

/** The longest message one chat may send another. */
export const CHAT_MESSAGE_MAX = 20_000;

/**
 * The lock identity for a message a chat sends.
 *
 * @param fromSessionId - The sending chat.
 */
export function chatClientId(fromSessionId: string): string {
  return `${CHAT_CLIENT_PREFIX}${fromSessionId}`;
}

/**
 * Whether a lock identity (a queue row's `enqueuedBy`) is another chat's.
 *
 * @param clientId - The identity.
 */
export function isChatClientId(clientId: string): boolean {
  return clientId.startsWith(CHAT_CLIENT_PREFIX);
}
