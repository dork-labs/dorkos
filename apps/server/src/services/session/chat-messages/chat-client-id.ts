/**
 * The lock identity a chat message is sent under (spec `spin-off-chats` §2):
 * `chat:<sending chat id>`. It is how a queue row says another chat sent it,
 * which the dispatcher reads for two rules: the person's words run first, and
 * a row another chat sent is held to its sender's level when it launches.
 *
 * Leaf module: the dispatcher imports it, so it imports nothing of ours.
 *
 * @module services/session/chat-messages/chat-client-id
 */

/** The prefix of every chat-message lock identity. */
export const CHAT_CLIENT_PREFIX = 'chat:';

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
