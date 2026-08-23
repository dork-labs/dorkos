/**
 * Maps SDK error signals to DorkOS user-facing error categories and messages.
 *
 * Two distinct SDK error channels feed the event stream:
 * - `result` message `subtype` (operational limits) → {@link mapErrorCategory}
 * - assistant message `error` (terminal failures) → {@link describeAssistantError}
 *
 * @module services/runtimes/claude-code/sdk-error-mapping
 */
import type { ErrorCategory } from '@dorkos/shared/types';

/**
 * The `result.terminal_reason` values that mean the turn was CUT SHORT rather
 * than failing — the SDK's own abort reasons, plus the `interrupted` DorkOS
 * supplies on the resume path.
 *
 * The same three the projector settles as the `interrupted` lifecycle
 * (`session/session-state-projector.ts`), and deliberately so: the two readings
 * of one turn may not disagree about whether a person stopped it.
 */
const ABORTED_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'interrupted',
  'aborted_streaming',
  'aborted_tools',
]);

/**
 * Whether a `result` is the CLI reporting a turn somebody stopped, rather than
 * a turn that failed (DOR-1320).
 *
 * **Why this is the gate on the durable error frame.** A Stop the CLI acks is
 * answered by a `result` whose subtype is `error_during_execution` — every
 * observed Stop on the persistent pump produced one — carrying an
 * `[ede_diagnostic]` line the CLI writes for its own debugging. Mapped as an
 * error, that put a red `error` frame in the durable record of a turn the
 * operator ended on purpose: the stop was acked, the turn settled, the next
 * message worked, and the transcript still said the agent crashed.
 *
 * The subtype alone cannot tell the two apart, but the SAME result names its
 * terminal reason, and `aborted_streaming` / `aborted_tools` is the CLI saying
 * the turn was cut short. So the error frame is suppressed and the turn settles
 * on that reason — which the projector already reads as `interrupted`. Nothing
 * else about the result is dropped: the closing `session_status` still carries
 * the reason, the cost and the token totals.
 *
 * Read defensively rather than by narrowing: `terminal_reason` is a forward-open
 * union (`TerminalReasonSchema`), so an unfamiliar value is simply not an abort.
 *
 * @param terminalReason - The `result`'s `terminal_reason`, if it carried one
 */
export function isAbortedTerminalReason(terminalReason: string | undefined): boolean {
  return terminalReason !== undefined && ABORTED_TERMINAL_REASONS.has(terminalReason);
}

/** Map SDK result subtypes to user-facing error categories. */
export function mapErrorCategory(subtype: string): ErrorCategory {
  switch (subtype) {
    case 'error_max_turns':
      return 'max_turns';
    case 'error_during_execution':
      return 'execution_error';
    case 'error_max_budget_usd':
      return 'budget_exceeded';
    case 'error_max_structured_output_retries':
      return 'output_format_error';
    default:
      return 'execution_error';
  }
}

/**
 * Terminal `SDKAssistantMessage.error` values we surface to the user (SDK 0.3.144+).
 *
 * Excludes `rate_limit` / `overloaded` (handled by the `api_retry` and
 * `rate_limit_event` channels) and `max_output_tokens` (handled by the
 * `stop_reason === 'max_tokens'` branch) to avoid double-reporting.
 */
export const SURFACED_ASSISTANT_ERRORS = new Set([
  'model_not_found',
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'invalid_request',
  'server_error',
]);

/** Map an SDK assistant-message error to a clear, user-facing message. */
export function describeAssistantError(error: string): string {
  switch (error) {
    case 'model_not_found':
      return 'The selected model is unavailable. Pick a different model and try again.';
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return 'Authentication failed. Re-authenticate Claude Code and try again.';
    case 'billing_error':
      return 'There is a billing issue with your Claude account.';
    case 'invalid_request':
      return 'The request was rejected as invalid.';
    case 'server_error':
      return 'Claude encountered a server error. Try again in a moment.';
    default:
      return 'The agent stopped with an unexpected error.';
  }
}
