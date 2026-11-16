/**
 * The Transport slice for a message another chat left in this chat's queue
 * (DOR-3060): a person sends it now, into the running turn.
 *
 * Taking it off the queue ("Don't deliver") is the queue's own remove,
 * `Transport.removeQueuedMessage`; the server tells the sender who removed it.
 *
 * @module shared/transport-queued-chat
 */
import type { SteerQueuedChatMessageResponse } from './schemas.js';

/** Send another chat's queued message now. */
export interface QueuedChatTransport {
  /**
   * Send another chat's queued message into the running turn.
   *
   * `POST /sessions/:id/queue/:messageId/steer`. It joins the turn only when
   * that turn runs no looser than the sender; otherwise the message moves to
   * the front and runs next (`moved-to-front`, with the reason). Rejects with
   * `QUEUED_MESSAGE_NOT_FOUND` when it already left the queue.
   *
   * @param sessionId - The session whose queue holds the message.
   * @param messageId - The server-minted id of the waiting message.
   */
  steerQueuedChatMessage(
    sessionId: string,
    messageId: string
  ): Promise<SteerQueuedChatMessageResponse>;
}
