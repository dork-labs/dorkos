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
import { z } from 'zod';
import { LaunchSafeErrorCodeSchema } from '../src/commands/community-deploy/journal.js';
import { CommunityLiveGateError } from './community-deploy-live-capture.js';
import { CommunityLiveGateCleanupError } from './community-deploy-live-cleanup.js';
import { CommunityLiveGateNotArmedError } from './community-deploy-live-config.js';

/** Step a failure after cleanup is reported as. */
export const AFTER_CLEANUP_STEP = 'after-cleanup';

/** What a failure after cleanup did and did not leave behind. */
export const CLEANED_UP_DETAIL = 'cleanup finished; a later step failed';

/** Step a published launcher that exited with a failure is reported as. */
export const PUBLISHED_LAUNCHER_STEP = 'published-launcher';

/**
 * Only the two fields worth reporting, each held to its fixed vocabulary, so nothing else a
 * journal holds (or a newer launcher adds to it) can reach the gate's output.
 *
 * The code is checked against THIS checkout's error-code list, not the published launcher's. A
 * code that only the published version knows (version skew) is dropped, and the failure falls
 * back to the bare `published-launcher` step: it loses detail, never prints something unchecked.
 */
const LauncherStopSchema = z.object({
  lastSafeError: z.object({ code: LaunchSafeErrorCodeSchema }).nullable().catch(null),
  pendingIntent: z
    .object({ provider: z.enum(['fly', 'neon', 'tigris']) })
    .nullable()
    .catch(null),
});

/**
 * Say why the published launcher stopped, from the error it saved in its launch journal.
 *
 * Without this a live run that stopped reported only `published-launcher`, and finding out that
 * Neon had answered in an unexpected shape meant reading the journal by hand (DOR-2536).
 *
 * @param journal - The launch journal as parsed JSON.
 * @returns A fixed-vocabulary sentence such as `launcher stopped with CREATION_OUTCOME_UNCERTAIN
 *   (neon)`, or null when the journal records no known error code.
 */
export function describeLauncherStop(journal: unknown): string | null {
  const parsed = LauncherStopSchema.safeParse(journal);
  const code = parsed.success ? parsed.data.lastSafeError?.code : undefined;
  if (!code) return null;
  const provider = parsed.data?.pendingIntent?.provider;
  return `launcher stopped with ${code}${provider ? ` (${provider})` : ''}`;
}

/** Prefix the launcher prints on stderr when a command fails (`packages/cli/src/cli.ts`). */
const LAUNCHER_FAILURE_PREFIX = 'Community setup failed:';

/** Added only when the run has no launch journal, so the stop cannot have created anything. */
export const NO_LAUNCH_RECORD_SUFFIX = ' before writing a launch record';

/**
 * Say which error the launcher exited with, from its own terminal output. This is what explains a
 * launcher that refused its release (for example `COMMUNITY_RELEASE_INVALID`, DOR-2169) before it
 * wrote a journal, and a resumed launcher whose journal holds no saved error.
 *
 * Only a code token is ever returned: the last `Community setup failed:` line of the transcript,
 * its final `(CODE)`, checked against this checkout's error codes. Nothing else from the terminal
 * reaches the gate's output, so a message that echoes a name or an account cannot leak. Whether a
 * launch record exists is not known here; `explainCommunityLiveGateFailure` says so when none does.
 *
 * @param transcript - The tail of the launcher's terminal output.
 * @returns `launcher exited with <CODE>`, or null when no known code was printed.
 */
export function describeLauncherExit(transcript: string): string | null {
  // Carriage returns become line breaks so a terminal's CRLF splits cleanly. Colour codes need no
  // stripping: only the prefix and a `(CODE)` token are read, and neither contains one.
  const plain = transcript.replace(/\r/gu, '\n');
  const line = plain
    .split('\n')
    .filter((entry) => entry.includes(LAUNCHER_FAILURE_PREFIX))
    .at(-1);
  if (!line) return null;
  const token = [...line.matchAll(/\(([A-Z][A-Z0-9_]{1,63})\)/gu)].at(-1)?.[1];
  const code = LaunchSafeErrorCodeSchema.safeParse(token);
  return code.success ? `launcher exited with ${code.data}` : null;
}

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
 * @param findLauncherStop - Reads why the published launcher stopped (see `describeLauncherStop`);
 *   used only when the failure is the launcher's own exit. A lookup that fails counts as none.
 * @returns The error to throw: a gate error naming the recovery command when resources may remain
 *   (keeping a cleanup refusal's own step and the resources it left), an honest after-cleanup error
 *   when none do, and otherwise `error` unchanged.
 */
export async function explainCommunityLiveGateFailure(
  error: unknown,
  state: CommunityLiveGateFailureState,
  findRecoveryCommand: () => Promise<string | null>,
  findLauncherStop: () => Promise<string | null> = async () => null
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
  // The journal's saved error is the more specific answer (it names the service); without a
  // journal, the launcher's own last code, which the PTY runner attached, is the next best.
  const isLauncherExit =
    error instanceof CommunityLiveGateError && error.step === PUBLISHED_LAUNCHER_STEP;
  const journalStop = isLauncherExit ? await findLauncherStop().catch(() => null) : null;
  // The launcher's own last code is only a fallback. It says nothing was written only when no
  // launch record exists: a resumed launcher can stop with a journal (and resources) already there.
  const outputStop =
    isLauncherExit && !journalStop && error.detail
      ? `${error.detail}${recoveryCommand ? '' : NO_LAUNCH_RECORD_SUFFIX}`
      : null;
  const launcherStop = journalStop ?? outputStop;
  if (!recoveryCommand && !launcherStop) return error;
  return new CommunityLiveGateError(
    error instanceof CommunityLiveGateError ? error.step : 'execution',
    recoveryCommand,
    launcherStop ?? undefined
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
