/**
 * The refusal the chat tools answer with, in its own module so the service and
 * the modules it calls share it without importing each other.
 *
 * @module services/session/chat-messages/chat-message-error
 */

/** A refusal `chat_send`, `chat_read` or `chat_stop` answers with. */
export class ChatMessageError extends Error {
  /**
   * Build a refusal.
   *
   * @param code - A stable code.
   * @param message - A plain sentence for the calling agent.
   */
  constructor(
    readonly code:
      | 'NO_CHAT'
      | 'SELF'
      | 'NOT_FOUND'
      | 'NOT_ALLOWED'
      | 'NOT_READABLE'
      | 'INVALID_INPUT'
      | 'UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'ChatMessageError';
  }
}
