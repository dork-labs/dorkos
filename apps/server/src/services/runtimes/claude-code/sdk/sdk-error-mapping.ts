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
import { isInterruptedTerminalReason } from '@dorkos/shared/schemas';

/** What a non-success `result` needs to prove before its error frame is dropped. */
export interface StoppedTurnEvidence {
  /** The `result`'s own `terminal_reason`, if it carried one. */
  terminalReason?: string | undefined;
  /**
   * Whether DorkOS aimed a Stop at the query running this turn — the record
   * `interruptGivenQuery` writes before it even attempts the interrupt
   * (`agent-types.ts`, `stoppedQueries`).
   */
  stopWasRequested: boolean;
}

/**
 * Whether a non-success `result` is a turn a PERSON stopped, rather than a turn
 * that failed (DOR-1320).
 *
 * **Why the durable error frame hangs off this.** A Stop the CLI acks is
 * answered by a `result` whose subtype is `error_during_execution` — every
 * observed Stop on the persistent pump produced one — carrying an
 * `[ede_diagnostic]` line the CLI writes for its own debugging. Mapped as an
 * error, that put a red `error` frame in the durable record of a turn the
 * operator ended on purpose: the stop was acked, the turn settled, the next
 * message worked, and the transcript still said the agent crashed.
 *
 * **Two conditions, and neither is sufficient alone.**
 *
 * - **Shape** — `isInterruptedTerminalReason`. Necessary, because a stop that
 *   the CLI never got to act on still ends the turn some other way, and that
 *   ending is not a stop.
 * - **Intent** — {@link StoppedTurnEvidence.stopWasRequested}. Necessary,
 *   because the terminal reason says a turn was aborted and NOT by whom. The
 *   CLI drives both abort reasons from one `abortController.signal.aborted`
 *   check and collapses NINE distinct causes into them — `user-cancel`,
 *   `remote-cancel`, `shutdown`, `interrupt`, `background`, `recovery-timeout`,
 *   `server_fallback_tombstone`, `turn_teardown` (its default bucket) and
 *   `refusal-fallback-edit`. Only `interrupt` is DorkOS's own
 *   `query.interrupt()`; the CLI keeps the distinction in a predicate that
 *   never reaches the SDK surface. `refusal-fallback-edit` is the provable
 *   hole: an API refusal aborts the main turn controller directly, so a
 *   shape-only gate would drop a real failure's error frame and tell the
 *   operator they stopped a turn they never touched (DOR-1320 review, from the
 *   shipped `claude-agent-sdk` 0.3.224 bundle).
 *
 * When both hold the error frame is suppressed and the turn settles on its
 * terminal reason, which the projector already reads as `interrupted`. Nothing
 * else about the result is dropped: the closing `session_status` still carries
 * the reason, the cost and the token totals.
 *
 * @param evidence - The result's terminal reason and DorkOS's own stop record
 */
export function isStoppedTurnResult(evidence: StoppedTurnEvidence): boolean {
  return evidence.stopWasRequested && isInterruptedTerminalReason(evidence.terminalReason);
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
