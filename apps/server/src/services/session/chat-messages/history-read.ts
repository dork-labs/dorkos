/**
 * Shape a history answer, whole or as a tail (DOR-2890).
 *
 * The app reloads a chat's history at the end of every turn, and that reload
 * used to carry the whole chat, every turn, however long it was. It only needs
 * what the turn wrote, so it names the newest message it already holds with
 * `?since=` and gets that message and everything after it.
 *
 * The anchor itself comes back, rather than only what follows it, because a
 * record can still change after the app first saw it: a tool call's result
 * lands on the assistant message that made the call, and the anchor is often
 * that message.
 *
 * @module services/session/chat-messages/history-read
 */
import type { HistoryMessage, HistoryRead } from '@dorkos/shared/types';

/**
 * The whole history, or with `since` naming one of its messages the tail that
 * starts at it, marked `tail`. An id the history does not hold (a compacted or
 * rewritten transcript) gets the whole history, so the caller replaces rather
 * than splices.
 *
 * Applied after every filter and stamp, so a tail is exactly the end of the
 * whole answer and never filtered differently from it.
 *
 * @param messages - The finished whole-history answer.
 * @param since - The `since` query value, as the request carried it.
 */
export function historyRead(messages: HistoryMessage[], since: unknown): HistoryRead {
  if (typeof since !== 'string' || since.length === 0) return { messages };
  const at = messages.findIndex((message) => message.id === since);
  return at === -1 ? { messages } : { messages: messages.slice(at), tail: true };
}
