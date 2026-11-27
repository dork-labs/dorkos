/**
 * The chat-message rows as the computer side may read and move them: its
 * narrow view of the store (`../chat-rows/chat-rows-port.ts`), handed over at startup
 * (spec `computer-side-starts-alone` §5.12).
 *
 * @module services/session/chat-messages/computer-chat-rows
 */
import type { ChatRowsPort } from '../chat-rows/chat-rows-port.js';
import type { ChatMessageStore } from './chat-message-store.js';
import { chatStopByLine } from './stops/chat-stop-record.js';

/**
 * The computer side's view of one store: a rekey carries the chat's rows, and
 * a history reads the stops that actually stopped it (a delivered `stop` row),
 * each as its "Stopped by" line reads.
 *
 * @param store - The wired chat-message store.
 */
export function computerChatRows(store: ChatMessageStore): ChatRowsPort {
  return {
    rekeySession: (fromId, toId) => store.rekeySession(fromId, toId),
    stopsOf: (sessionId) =>
      store
        .listStopsOf(sessionId)
        .filter((row) => row.status === 'delivered')
        .map((row) => ({
          createdAt: row.createdAt,
          byLine: chatStopByLine(row.fromAgentName, row.fromChatTitle),
        })),
  };
}
