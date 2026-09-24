/**
 * What the live gate tells the operator when a run fails, kept apart from `main` so every answer
 * can be proven without spending anything.
 *
 * A failed run may have left billable resources behind, and then the one thing the operator needs
 * is the command that reconciles them. Once cleanup has finished, though, there is nothing left to
 * reconcile: a failure after that point (reading the final inventory, writing the receipt, removing
 * the run's state) used to print the recovery command anyway, pointing the operator at resources
 * that no longer existed. And a cleanup that stopped part way used to be reported only as
 * `execution`, hiding which step refused and which resources it had not deleted yet.
 */
import { CommunityLiveGateError } from './community-deploy-live-capture.js';
import { CommunityLiveGateCleanupError } from './community-deploy-live-cleanup.js';
import { CommunityLiveGateNotArmedError } from './community-deploy-live-config.js';

/** Step a failure after cleanup is reported as. */
export const AFTER_CLEANUP_STEP = 'after-cleanup';

/** What a failure after cleanup did and did not leave behind. */
export const CLEANED_UP_DETAIL = 'cleanup finished; a later step failed';

/** How far the run got when it failed. */
export interface CommunityLiveGateFailureState {
  /** Whether cleanup returned successfully, so nothing the run created is left. */
  cleanedUp: boolean;
  /** The recovery command the run already knows, or null. */
  recoveryCommand: string | null;
}

/**
 * Decide what a failed run reports.
 *
 * @param error - What the run threw.
 * @param state - How far the run got.
 * @param findRecoveryCommand - Looks for a launch journal the run had not read yet; used only when
 *   cleanup has not finished and the run holds no recovery command. A lookup that fails counts as
 *   none found.
 * @returns The error to throw: a gate error naming the recovery command when resources may remain
 *   (keeping a cleanup refusal's own step and the resources it left), an honest after-cleanup error
 *   when none do, and otherwise `error` unchanged.
 */
export async function explainCommunityLiveGateFailure(
  error: unknown,
  state: CommunityLiveGateFailureState,
  findRecoveryCommand: () => Promise<string | null>
): Promise<unknown> {
  if (state.cleanedUp)
    return new CommunityLiveGateError(AFTER_CLEANUP_STEP, null, CLEANED_UP_DETAIL);
  // A launcher that failed before the gate read its journal may still have written one, and may
  // already have created resources. Find it now rather than stay silent about them.
  const recoveryCommand = state.recoveryCommand ?? (await findRecoveryCommand().catch(() => null));
  // A cleanup refusal names only non-secret identities, so its step and what it left are shown.
  if (error instanceof CommunityLiveGateCleanupError)
    return new CommunityLiveGateError(
      error.step,
      recoveryCommand,
      `retained: ${error.retained.join(', ') || 'unknown'}`
    );
  if (!recoveryCommand) return error;
  return new CommunityLiveGateError(
    error instanceof CommunityLiveGateError ? error.step : 'execution',
    recoveryCommand
  );
}

/**
 * The text the gate writes to stderr for a failure.
 *
 * Only the gate's own errors, whose messages are fixed and non-secret, are shown as they are;
 * anything else may carry provider output, so it is reported without its message.
 *
 * @param error - What `main` rejected with.
 */
export function describeCommunityLiveGateFailure(error: unknown): string {
  const lines = [
    error instanceof CommunityLiveGateError || error instanceof CommunityLiveGateNotArmedError
      ? error.message
      : 'Community live gate failed',
  ];
  if (error instanceof CommunityLiveGateError && error.recoveryCommand)
    lines.push(`Retained resources can be reconciled with:\n  ${error.recoveryCommand}`);
  return `${lines.join('\n')}\n`;
}
