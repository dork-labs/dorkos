/**
 * Turn-failure detection for the chat surface (spec additional-agent-runtimes, 4.1).
 *
 * How a failed turn reaches the client: the typed `error` SessionEvent rides
 * the durable `/events` stream for every runtime — it folds an inline error
 * part into the live turn and mirrors into `status.lastError` — and the turn
 * closes with `turn_end{terminalReason:'error'}`, which the stream store
 * settles into `lifecycle: 'error'` (surfaced as `ChatStatus 'error'`).
 *
 * A failed turn can therefore show up on several surfaces at once: the inline
 * error part (live fold, or Claude Code's JSONL history reload), the
 * transport-error banner (send-path failures), and the standalone
 * `TurnFailedNotice`. This predicate's sole job is keeping those from
 * doubling up: it admits the standalone notice only when the status is
 * `error` AND no other error affordance is already visible for the failed
 * turn — covering the failures that render no inline part at all (e.g. a
 * turn that died with no typed error event).
 *
 * @module features/chat/model/stream/turn-failure
 */
import type { ChatMessage, ChatStatus, TransportErrorInfo } from '../chat-types';

/**
 * Whether the chat panel should render the standalone turn-failed notice.
 *
 * True only when the session's rendered status is `error` AND no other error
 * affordance is already visible: the transport-error banner (`error` set by
 * the send path) or an inline error part rendered since the last user message
 * (the Claude Code history path).
 *
 * @param status - The rendered coarse chat status.
 * @param transportError - The transport-level error banner state.
 * @param messages - The rendered message list.
 */
export function shouldShowTurnFailedNotice(
  status: ChatStatus,
  transportError: TransportErrorInfo | null,
  messages: ChatMessage[]
): boolean {
  if (status !== 'error') return false;
  if (transportError) return false;

  // Scan only the current (failed) turn: everything after the last user
  // message. Error parts from EARLIER turns must not suppress the notice.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const tail = messages.slice(lastUserIdx + 1);
  return !tail.some((m) => m.parts.some((p) => p.type === 'error'));
}
