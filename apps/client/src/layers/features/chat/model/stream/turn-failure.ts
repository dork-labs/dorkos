/**
 * Turn-failure detection for the chat surface (spec additional-agent-runtimes, 4.1).
 *
 * How a failed turn reaches the client: adapters emit typed `error`
 * StreamEvents, but those are dropped from the durable `/events` stream
 * (`toRawSessionEvent`). What DOES arrive is the projector's
 * `turn_end{terminalReason:'error'}` (via `guardTurnErrors`), which the
 * stream store settles into `lifecycle: 'error'` and
 * `selectRenderedStatus` surfaces as `ChatStatus 'error'`. That status is
 * therefore the one signal that fires for EVERY runtime.
 *
 * Claude Code additionally persists the error in its JSONL transcript, so the
 * post-turn history reload renders an inline `ErrorMessageBlock` (with its own
 * Retry). Runtimes whose history has no error entry (Codex, OpenCode) would
 * otherwise fail silently — this predicate fills that gap without doubling up
 * on the surfaces that already show one.
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
