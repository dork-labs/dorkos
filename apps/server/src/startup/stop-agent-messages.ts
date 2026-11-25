/** Settle private chat receipts and cancel owned messaging waits before server storage closes. */
import { getRoomService } from '../services/rooms/index.js';
import type { RoomService } from '../services/rooms/room-service.js';
import { stopChatReports } from '../services/session/chat-messages/chat-message-current.js';
import { getChatMessageService } from '../services/session/chat-messages/chat-message-current.js';
import { getAgentSendService } from '../services/extensions/agent-send/agent-send.js';
import { markRunsShutdown } from '../services/runs/index.js';

/** Stop both messaging owners while SQLite is still open; a late turn cannot revive a receipt. */
export function stopAgentMessageServices(): void {
  stopChatReports();
  try {
    getChatMessageService()?.stop();
  } finally {
    try {
      getAgentSendService()?.stop();
    } finally {
      // Startup can fail before rooms exist. Resolve separately so dispose failures stay visible.
      let rooms: RoomService | undefined;
      try {
        rooms = getRoomService();
      } catch {
        /* Rooms have not been registered yet. */
      }
      rooms?.dispose();
      // Every turn still running ends `shutdown` on its run while SQLite is
      // open (spec `turns-survive-restarts` §4.4): DorkOS ended it, and says so.
      markRunsShutdown();
    }
  }
}
