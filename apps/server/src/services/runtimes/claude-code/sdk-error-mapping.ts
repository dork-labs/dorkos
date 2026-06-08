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
