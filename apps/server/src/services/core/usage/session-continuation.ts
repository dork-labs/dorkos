/**
 * Where an extension's `accounts.markContinued` lands: the extension moved a
 * session it claimed to a new session itself, and the source session's limit
 * plan must now point at the new one (spec `claude-account-fleet` §6 X2, the
 * single-writer rule).
 *
 * The out-of-usage service (D9) owns the session limit rows and installs the
 * recorder once they exist, the same shape as `setAccountUsageStore`. Until it
 * does, no session carries a limit plan to update, so a call is refused with a
 * plain error rather than silently accepted.
 *
 * @module services/core/usage/session-continuation
 */

/** Where a moved session's work went. */
export interface ContinuationTarget {
  /** The new session's id. */
  sessionId: string;
  /** The new session's runtime. */
  runtime: string;
  /** The account the new session runs on. */
  accountId: string;
}

/**
 * Records that `ownerId` (an extension id) moved `sourceSessionId` to `to`.
 * Rejects when the source is not a session that extension may move.
 */
export type ContinuationRecorder = (
  ownerId: string,
  sourceSessionId: string,
  to: ContinuationTarget
) => Promise<void>;

/** The refusal while nothing records moved sessions. */
export const CONTINUATION_UNAVAILABLE_MESSAGE =
  'This DorkOS server does not track sessions that ran out of usage, so there is nothing to mark as continued.';

let recorder: ContinuationRecorder | undefined;

/**
 * Install the process's one continuation recorder.
 *
 * @param next - The recorder, or `undefined` to clear it (shutdown, tests).
 */
export function setContinuationRecorder(next: ContinuationRecorder | undefined): void {
  recorder = next;
}

/**
 * Record a session an extension moved itself.
 *
 * @param ownerId - The extension that moved it.
 * @param sourceSessionId - The session whose work moved.
 * @param to - Where it went.
 * @throws {Error} When no recorder is installed, or the recorder refuses.
 */
export async function recordContinuation(
  ownerId: string,
  sourceSessionId: string,
  to: ContinuationTarget
): Promise<void> {
  if (!recorder) throw new Error(CONTINUATION_UNAVAILABLE_MESSAGE);
  await recorder(ownerId, sourceSessionId, to);
}
