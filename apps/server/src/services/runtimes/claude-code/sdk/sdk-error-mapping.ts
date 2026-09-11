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
import { describeAuthError } from '@dorkos/shared/runtime-error-classification';

/**
 * This adapter's runtime type — the identity {@link describeAuthError} turns
 * into the name a person reads ("Claude"), so every channel that reports a
 * Claude Code credential failure names the same thing.
 */
export const CLAUDE_CODE_RUNTIME_TYPE = 'claude-code';

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
 *   case: an API refusal aborts the main turn controller directly, so a
 *   shape-only gate would drop a real failure's error frame and tell the
 *   operator they stopped a turn they never touched (DOR-1320 review, from the
 *   shipped `claude-agent-sdk` 0.3.224 bundle). The CLI's abort predicate, its
 *   cause collapse, the suppression set that puts `refusal-fallback-edit` and
 *   DorkOS's own `interrupt` in one bucket, and the `result` shapes an abort
 *   closes with are all quoted in
 *   `research/20260903_claude-cli-aborted-refusal-shapes.md`, with the recipe
 *   for re-running it after an SDK bump.
 *
 *   **Re-extracted from the 0.3.268 bundle (2026-09-11), and the suppression set
 *   GREW.** The shape predicate is byte-identical, and so is everything DorkOS
 *   reads. What moved is behind it: a new abort cause `turn-abort` collapses to
 *   the same `interrupt` vocabulary as DorkOS's own `query.interrupt()`, and the
 *   suppression set is now three members — `interrupt`, `turn-abort`,
 *   `refusal-fallback-edit` — where it was two. `turn-abort` is what 0.3.246's
 *   `perTaskStopAffordance` raises, so it is a stop DorkOS may not have asked
 *   for. **No change is needed here, and that is the point**: this predicate ANDs
 *   shape with DorkOS's OWN stop record, so a third cause wearing the same
 *   terminal reason cannot buy a suppressed error frame. A shape-only gate would
 *   have silently gained a new way to tell someone they stopped a turn they never
 *   touched.
 *
 * When both hold the error frame is suppressed and the turn settles on its
 * terminal reason, which the projector already reads as `interrupted`. Nothing
 * else about the result is dropped: the closing `session_status` still carries
 * the reason, the cost and the token totals.
 *
 * **The other half of the same evidence now rides the wire.** Keeping the error
 * frame was never enough on its own: SETTLEMENT read the abort reason and
 * called the turn `interrupted` anyway, which erased the very frame this
 * predicate had deliberately preserved. So the mapper also stamps
 * `stopWasRequested` onto the `session_status` beside an abort reason, and every
 * settlement reader ANDs the same two halves this predicate does
 * (`@dorkos/shared/run-outcome`, `isUnrequestedAbortFailure`). One decision, one
 * piece of evidence, read the same way at both layers.
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
 *
 * **This set is hand-maintained, and a value missing from it is dropped on the
 * floor** — `message-event-mapper.ts` gates every assistant-error card on it, so
 * an unlisted value ends the turn with no card, no log line and nothing a person
 * can debug. Re-read the `SDKAssistantMessageError` union on every SDK bump: the
 * 0.3.224 → 0.3.268 range added three values, and all three are things only the
 * person can fix. Anything new belongs here unless one of the three channels
 * above already reports it.
 */
export const SURFACED_ASSISTANT_ERRORS = new Set([
  'model_not_found',
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'invalid_request',
  'server_error',
  'account_on_hold',
  'verification_required',
  'cloud_credential_error',
]);

/**
 * Whether an `invalid_request` notice is the API's content safeguard, not a
 * malformed request.
 *
 * The API says "…'s safeguards flagged this message (https://www.anthropic.com/legal/aup)"
 * and the CLI files it under the same `invalid_request` code as a genuinely
 * broken request. They need different words: a broken request is DorkOS's
 * problem, a flagged one is something the person can act on right now by
 * rephrasing or switching models. Matched on the phrase the API uses rather
 * than the model name in front of it, which changes per model.
 *
 * @param noticeText - The CLI's own text for the failure, when it carried any.
 */
export function isSafeguardRefusal(noticeText: string | undefined): boolean {
  return noticeText !== undefined && /safeguards flagged/i.test(noticeText);
}

/**
 * What the card says when the API's safeguard declined a message.
 *
 * Filed under `execution_error`, so `ErrorMessageBlock` prints this sentence
 * as the card's own text; it does not depend on the link to stay visible. The
 * link is there because it is the one thing the person may want to read next
 * and a paraphrase cannot carry it. The request id stays in Details, where the
 * raw notice is kept verbatim.
 */
export const SAFEGUARD_REFUSAL_MESSAGE =
  'Claude’s safety filter flagged this message. It sometimes flags ordinary coding work. ' +
  'Rephrase it, or pick a different model and try again. ' +
  'Policy: https://www.anthropic.com/legal/aup';

/**
 * Map an SDK assistant-message error to a clear, user-facing message.
 *
 * @param error - The SDK's error code.
 * @param noticeText - The CLI's own text for the failure, when the caller has
 *   it. Only `invalid_request` reads it, to tell a safeguard refusal apart from
 *   a malformed request.
 */
export function describeAssistantError(error: string, noticeText?: string): string {
  switch (error) {
    case 'model_not_found':
      return 'The selected model is unavailable. Pick a different model and try again.';
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      // Shared, never re-typed: the result channel says this same sentence for
      // the same expiry, and one copy is what keeps them from drifting apart
      // again (DOR-1656).
      return describeAuthError(CLAUDE_CODE_RUNTIME_TYPE);
    case 'billing_error':
      return 'There is a billing issue with your Claude account.';
    case 'account_on_hold':
      return 'Your Claude account is on hold, so it cannot run this. Check your Claude account settings, then try again.';
    case 'verification_required':
      return 'Your Claude account needs to be verified before it can run this. Finish verification in your Claude account settings, then try again.';
    case 'cloud_credential_error':
      // Deliberately NOT `describeAuthError`, which its two credential siblings
      // above do use. That sentence says the Claude sign-in stopped working and
      // earns the client's "Fix sign-in" treatment; this failure is the cloud
      // credential DorkOS was handed (Bedrock, Vertex or Foundry), which a
      // sign-in cannot repair. Sending someone to sign in again for it would be
      // a confident wrong answer, so the card stays an execution error and says
      // where the fix actually is.
      return 'Claude could not use the cloud credentials it was given. Check them in Settings, then try again.';
    case 'invalid_request':
      return isSafeguardRefusal(noticeText)
        ? SAFEGUARD_REFUSAL_MESSAGE
        : 'The request was rejected as invalid.';
    case 'server_error':
      return 'Claude encountered a server error. Try again in a moment.';
    default:
      return 'The agent stopped with an unexpected error.';
  }
}
