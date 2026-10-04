/**
 * What a guided launch saves and says when it stops (DOR-2702).
 *
 * The terminal's last line is for a person and carries no error code, so the code goes in the
 * launch journal instead: the live gate (`scripts/community-deploy-live-failure.ts`,
 * `describeLauncherStop`) and `--list-incomplete` read it from there.
 *
 * Lives under `runtime/` because `community-deploy/` is at the repository's per-directory file
 * limit (`scripts/check-dir-size.sh`).
 *
 * @module commands/community-deploy/runtime/stop-record
 */
import {
  LaunchSafeErrorCodeSchema,
  type LaunchErrorCategorySchema,
  type LaunchJournal,
} from '../journal.js';
import type { z } from 'zod';

type LaunchSafeErrorCode = z.infer<typeof LaunchSafeErrorCodeSchema>;
type LaunchErrorCategory = z.infer<typeof LaunchErrorCategorySchema>;

/** The signal that stopped setup; each has its conventional exit code (128 + signal number). */
export type LaunchStopSignal = 'SIGINT' | 'SIGTERM';

/**
 * Exit code for a launch stopped by a signal, as a shell reports it.
 *
 * @param signal - The signal setup received.
 */
export function stopExitCode(signal: LaunchStopSignal): number {
  return signal === 'SIGTERM' ? 143 : 130;
}

/**
 * The last line after setup is stopped by a signal, matching what the journal saved. It does not
 * say who stopped it: a Control-C and a SIGTERM take the same path.
 *
 * @param journal - The journal as saved after the stop.
 */
export function describeStoppedLaunch(journal: LaunchJournal): string {
  if (journal.lastSafeError?.code === 'CANCELLED') {
    return 'Setup was stopped. What it made so far is kept: run the resume command above to carry on.';
  }
  const unsure =
    'Setup was stopped while a change was still in progress, so it cannot tell yet whether that change happened.';
  // Steps are printed only for an open creation intent (the recovery's "Manual reconciliation").
  return journal.pendingIntent
    ? `${unsure} Follow the steps above before you resume.`
    : `${unsure} Check the resources listed above, then run the resume command above.`;
}

function categoryFor(code: LaunchSafeErrorCode): LaunchErrorCategory {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'authentication';
    case 'ACCESS_DENIED':
    case 'TERMS_NOT_ACCEPTED':
      return 'authorization';
    case 'BILLING_BLOCKED':
      return 'billing';
    case 'QUOTA_EXCEEDED':
      return 'capacity';
    case 'NAME_CONFLICT':
      return 'conflict';
    case 'INVALID_RESPONSE':
    case 'INVALID_INPUT':
    case 'MISSING_TIGRIS_SECRETS':
      return 'invalid-response';
    case 'CREATION_OUTCOME_UNCERTAIN':
    case 'REMOVAL_OUTCOME_UNCERTAIN':
      return 'uncertain';
    default:
      return 'transient';
  }
}

/**
 * The journal to save after a launch failed without being stopped, so its error code is on disk.
 *
 * Only an error that carries a journal-safe code is recorded, and only over nothing or over a
 * `CANCELLED` left by an earlier stop: an error a step already saved (an uncertain create, missing
 * bucket keys, a refused create) is more specific and stays. State, resources and the creation
 * intent are never touched, so `--resume` behaves exactly as before.
 *
 * @param journal - The latest journal this run saved.
 * @param error - What the launch threw.
 * @param now - Timestamp for the new revision.
 * @returns The next revision to write, or null when there is nothing to record.
 */
export function recordLaunchFailure(
  journal: LaunchJournal,
  error: unknown,
  now: string
): LaunchJournal | null {
  if (journal.pendingRemoval || journal.state === 'complete') return null;
  if (journal.lastSafeError !== null && journal.lastSafeError.code !== 'CANCELLED') return null;
  const raw =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  const code = LaunchSafeErrorCodeSchema.safeParse(raw);
  if (!code.success || code.data === 'CANCELLED') return null;
  return {
    ...journal,
    revision: journal.revision + 1,
    lastSafeError: { category: categoryFor(code.data), code: code.data },
    updatedAt: now,
  };
}
