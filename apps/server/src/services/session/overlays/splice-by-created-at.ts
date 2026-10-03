/**
 * Splice recorded rows into a runtime's assembled history by wall-clock: the
 * one placement rule every overlay of a durable session event shares
 * (`permission-denial-overlay`, `model-substitution-overlay`).
 *
 * @module services/session/overlays/splice-by-created-at
 */
import type { HistoryMessage } from '@dorkos/shared/types';

/**
 * Put each row after the last message that is not newer than it.
 *
 * A message with no timestamp (the transcript parser omits it for records that
 * carry none) cannot be compared, so it is treated as belonging to the run of
 * messages before it: the last timestamp seen is carried forward across it, and
 * it never displaces a row on its own. Anything dated after the whole history,
 * including every row of a session whose messages carry no timestamps at all,
 * closes it out.
 *
 * @param messages - History as the runtime assembled it.
 * @param rows - Recorded rows, oldest first.
 * @param toMessage - The history row one recorded row becomes.
 */
export function spliceByCreatedAt<T extends { createdAt: string }>(
  messages: HistoryMessage[],
  rows: readonly T[],
  toMessage: (row: T) => HistoryMessage
): HistoryMessage[] {
  const merged: HistoryMessage[] = [];
  let next = 0;
  let lastSeen = '';
  for (const message of messages) {
    if (message.timestamp !== undefined) lastSeen = message.timestamp;
    while (next < rows.length && rows[next]!.createdAt <= lastSeen) {
      merged.push(toMessage(rows[next]!));
      next += 1;
    }
    merged.push(message);
  }
  for (; next < rows.length; next += 1) merged.push(toMessage(rows[next]!));
  return merged;
}
