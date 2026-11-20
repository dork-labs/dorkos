/** Settle private chat receipts and cancel owned messaging waits before server storage closes. */
import { getChatMessageService } from '../services/session/chat-messages/chat-message-current.js';
import { getAgentSendService } from '../services/extensions/agent-send/agent-send.js';

/** Stop both messaging owners while SQLite is still open; a late turn cannot revive a receipt. */
export function stopAgentMessageServices(): void {
  try {
    getChatMessageService()?.stop();
  } finally {
    getAgentSendService()?.stop();
  }
}
