/**
 * Cloud's half of a withdrawal (DOR-2086): asking DorkOS Cloud to revoke this
 * computer's managed credential and forget its enrolment, and asking again
 * later when it could not be reached.
 *
 * ## What a retry may hold
 *
 * An {@link OwedCleanup} names what Cloud still owes in ids only (the instance
 * and credential it was about) and never holds a bearer. A retry re-reads the
 * link's key at the moment it sends, and only while the link the withdrawal
 * ran under is still the current one. Once that link ends (an unlink, a relink,
 * a change of Cloud), its key is gone, so the retry stops as `abandoned` and
 * the report keeps saying Cloud may still have a record.
 *
 * The retry lives in memory only, on purpose: persisting it would need a new
 * `cloud.remote` field, and the note a person sees already says Cloud may
 * still hold a record. A restart ends the retry; the note goes with it.
 *
 * Nothing here ever restores local access: it only talks to Cloud.
 *
 * @module services/core/remote/managed-cloud-cleanup
 */
import {
  RemoteCredentialRevokeResponseSchema,
  RemoteEnrolmentWithdrawnSchema,
  V1_ROUTES,
} from '@dork-labs/cloud-api';

import { logger } from '../../../lib/logger.js';
import { isAbsent, type CloudV1Context } from '../cloud/v1-client.js';

/** The first retry waits up to this long, before full jitter. */
export const CLEANUP_BASE_DELAY_MS = 5_000;
/** No retry waits longer than this. */
export const CLEANUP_MAX_DELAY_MS = 10 * 60_000;
/** How many times a withdrawal asks Cloud again before leaving the note in place. */
export const CLEANUP_MAX_ATTEMPTS = 12;

/** What Cloud still owes after a withdrawal. Ids only: never a bearer. */
export interface OwedCleanup {
  /** The instance the withdrawn enrolment belonged to, when known. */
  instanceId: string | null;
  /** The credential to revoke, when known. */
  credentialId: string | null;
  /** Whether the credential revoke is still owed. */
  revoke: boolean;
  /** Whether forgetting the enrolment is still owed. */
  forget: boolean;
}

/** How a retry ended. */
export type CleanupRetryOutcome = 'done' | 'abandoned' | 'gave_up' | 'cancelled';

/**
 * Send the owed calls under `context`, both at once and synchronously, so a
 * caller about to clear the link can send them first.
 *
 * @returns Resolves with what is still owed, or `null` when Cloud did both.
 */
export function sendCloudCleanup(
  context: CloudV1Context,
  owed: OwedCleanup
): Promise<OwedCleanup | null> {
  const revoke = owed.revoke
    ? context.client.post(V1_ROUTES.remoteCredentialsRevoke, RemoteCredentialRevokeResponseSchema)
    : Promise.resolve(undefined);
  const forget = owed.forget
    ? context.client.delete(V1_ROUTES.remoteEnrolment, RemoteEnrolmentWithdrawnSchema)
    : Promise.resolve(undefined);
  return Promise.allSettled([revoke, forget]).then(([revoked, forgotten]) => {
    const remaining: OwedCleanup = {
      ...owed,
      revoke: revoked.status === 'rejected',
      // An enrolment Cloud no longer holds is forgotten already.
      forget: forgotten.status === 'rejected' && !isAbsent(forgotten.reason),
    };
    return remaining.revoke || remaining.forget ? remaining : null;
  });
}

/** What {@link retryCloudCleanup} needs. */
export interface CleanupRetryOptions {
  /** What is still owed. */
  owed: OwedCleanup;
  /** Whether the link the withdrawal ran under is still the current one. */
  linkIsCurrent: () => boolean;
  /** Capture the current link, re-reading its key. */
  captureContext: () => CloudV1Context | null;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A number in `[0, 1)`, for jitter. */
  random: () => number;
  /** Aborted when something newer (a setup, another withdrawal) takes over. */
  signal: AbortSignal;
}

/**
 * Ask Cloud again, with capped exponential backoff and full jitter, while the
 * same link stays current. Never rejects.
 */
export async function retryCloudCleanup(
  options: CleanupRetryOptions
): Promise<CleanupRetryOutcome> {
  let owed = options.owed;
  for (let attempt = 0; attempt < CLEANUP_MAX_ATTEMPTS; attempt += 1) {
    const ceiling = Math.min(CLEANUP_MAX_DELAY_MS, CLEANUP_BASE_DELAY_MS * 2 ** attempt);
    await options.sleep(Math.floor(options.random() * ceiling), options.signal);
    if (options.signal.aborted) return 'cancelled';
    if (!options.linkIsCurrent()) return abandoned(owed);
    const context = options.captureContext();
    if (context === null || !options.linkIsCurrent()) return abandoned(owed);
    let remaining: OwedCleanup | null;
    try {
      remaining = await sendCloudCleanup(context, owed);
    } catch {
      remaining = owed;
    }
    if (options.signal.aborted) return 'cancelled';
    if (remaining === null) return 'done';
    owed = remaining;
  }
  logger.warn('[RemoteAccess] Cloud cleanup still owed; stopped asking', ids(owed));
  return 'gave_up';
}

function abandoned(owed: OwedCleanup): CleanupRetryOutcome {
  logger.warn(
    '[RemoteAccess] Cloud cleanup abandoned: the link it was owed under ended',
    ids(owed)
  );
  return 'abandoned';
}

function ids(owed: OwedCleanup): Record<string, unknown> {
  return {
    instanceId: owed.instanceId,
    credentialId: owed.credentialId,
    revoke: owed.revoke,
    forget: owed.forget,
  };
}
