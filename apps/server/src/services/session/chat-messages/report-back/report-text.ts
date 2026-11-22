/** Select the original turn's report words without borrowing a later reply. */
import type { HistoryMessage } from '@dorkos/shared/types';
import type { TurnWindow } from '../chat-report-back.js';

const TURN_GRACE_MS = 1_000;

/**
 * The words of the chat's latest turn, joined; empty when the turn said
 * nothing.
 *
 * With a window, the words are the agent's messages stamped inside it, so a
 * message that started the NEXT turn (queued behind this one) cannot hide this
 * turn's words or lend it the next turn's, and a turn that said nothing never
 * borrows an earlier turn's. Messages somebody sent carry no time in every
 * runtime's history (Claude Code's do not), so only the agent's own messages
 * are read by time; a history with no times at all falls back to "the agent's
 * messages after the last one it was sent".
 *
 * @param history - The chat's history, in order.
 * @param window - When the turn ran, when known.
 */
export function lastTurnText(history: readonly HistoryMessage[], window?: TurnWindow): string {
  const timed = history.some((m) => m.role === 'assistant' && m.timestamp);
  if (window && timed) {
    const from = window.from !== undefined ? window.from - TURN_GRACE_MS : -Infinity;
    const to = window.to !== undefined ? window.to + TURN_GRACE_MS : Infinity;
    return history
      .filter((m) => {
        if (m.role !== 'assistant' || !m.timestamp) return false;
        const at = Date.parse(m.timestamp);
        return at >= from && at <= to;
      })
      .map((m) => m.content.trim())
      .filter((t) => t !== '')
      .join('\n\n');
  }
  let start = history.length;
  while (start > 0 && history[start - 1]!.role === 'assistant') start -= 1;
  return history
    .slice(start)
    .map((m) => m.content.trim())
    .filter((t) => t !== '')
    .join('\n\n');
}
