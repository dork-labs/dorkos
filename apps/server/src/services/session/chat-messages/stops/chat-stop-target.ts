/**
 * Which chats `chat_stop` reaches: every chat a chat may write into, and a
 * new direct chat that waits to open (DOR-5512), whose waiting messages a stop
 * takes back, the first and every one that joined it.
 *
 * @module services/session/chat-messages/stops/chat-stop-target
 */
import { ChatMessageError } from '../chat-message-error.js';
import { assertChatSendable, type ChatTargetDeps } from '../chat-target.js';
import { openingChatAgent } from '../sending/direct-chat-opening.js';

/**
 * Refuse a chat a chat may not stop: as {@link assertChatSendable}, except a
 * new direct chat that waits to open, which is not bound yet.
 *
 * @param deps - What it reads.
 * @param sessionId - The chat.
 * @throws ChatMessageError when the chat may not be stopped.
 */
export async function assertChatStoppable(deps: ChatTargetDeps, sessionId: string): Promise<void> {
  try {
    await assertChatSendable(deps, sessionId, deps.meshCore() !== undefined);
  } catch (err) {
    const notBound = err instanceof ChatMessageError && err.code === 'NOT_FOUND';
    if (!notBound || !openingChatAgent(deps, sessionId)) throw err;
  }
}
