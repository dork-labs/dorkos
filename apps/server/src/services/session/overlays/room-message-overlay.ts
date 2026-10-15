/**
 * Put back which room post opened each turn, on a runtime whose own store
 * keeps the words but not where they came from (DOR-2113).
 *
 * OpenCode's sidecar stores a room turn's prompt as a plain user message, so a
 * reloaded chat drew another agent's post as the person's own. The durable
 * `turn_start` rows record the room and entry, and this lays them back over the
 * history, in order: each recorded room turn claims the next user message with
 * the same words. The server then fills in who posted it at the wire boundary,
 * where the words are checked against the post again.
 *
 * @module services/session/overlays/room-message-overlay
 */
import type { HistoryMessage } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import { getSessionEventStore } from '../session-state-projector.js';
import type { RecordedTurnStartRow } from '../session-event-store.js';

/**
 * Lay recorded room turns over a history.
 *
 * @param messages - The history, in order.
 * @param starts - The recorded turn starts, in `seq` order.
 */
export function applyRoomMessages(
  messages: HistoryMessage[],
  starts: readonly RecordedTurnStartRow[]
): HistoryMessage[] {
  const rooms = starts.filter((start) => start.roomMessage && start.userMessage);
  if (rooms.length === 0) return messages;
  const out = [...messages];
  let next = 0;
  for (const start of rooms) {
    const words = start.userMessage!.trim();
    for (let i = next; i < out.length; i++) {
      const message = out[i]!;
      if (message.role !== 'user' || message.content.trim() !== words) continue;
      if (!message.roomMessage) out[i] = { ...message, roomMessage: start.roomMessage! };
      next = i + 1;
      break;
    }
  }
  return out;
}

/**
 * {@link applyRoomMessages} over a session's recorded turn starts. A store that
 * cannot be read leaves the history as it is.
 *
 * @param sessionId - The DorkOS session id.
 * @param messages - The runtime's own history.
 */
export function overlayRoomMessages(
  sessionId: string,
  messages: HistoryMessage[]
): HistoryMessage[] {
  try {
    return applyRoomMessages(messages, getSessionEventStore()?.readTurnStarts(sessionId) ?? []);
  } catch (err) {
    logger.warn('[room-messages] could not read recorded turn starts', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return messages;
  }
}
