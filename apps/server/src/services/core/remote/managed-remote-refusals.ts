/**
 * What managed remote access says when it refuses (DOR-2086): the refusal
 * shape the routes answer with, the codes the client matches on, and how a
 * refused enrolment request from Cloud reads to a person.
 *
 * Kept apart from the coordinator so the coordinator reads as the ceremony it
 * runs. Nothing here carries a secret or a supplier detail.
 *
 * @module services/core/remote/managed-remote-refusals
 */
import { logger } from '../../../lib/logger.js';
import { isAbsent, problemOf } from '../cloud/v1-client.js';
import { errorName } from './managed-remote-support.js';

/** A refusal the routes answer with. Never carries a secret or a supplier detail. */
export interface CoordinatorRefusal {
  ok: false;
  status: number;
  code: string;
  error: string;
}

/** What a setup or mode action returns. */
export type CoordinatorResult = { ok: true } | CoordinatorRefusal;

/** Refusal code: managed remote access cannot be offered here right now. */
export const MANAGED_REMOTE_UNAVAILABLE = 'MANAGED_REMOTE_UNAVAILABLE';
/** Refusal code: this computer, or Cloud, already holds a setup. */
export const MANAGED_REMOTE_ALREADY_SET_UP = 'MANAGED_REMOTE_ALREADY_SET_UP';
/** Refusal code: managed mode needs a finished setup under this link. */
export const MANAGED_REMOTE_NOT_SET_UP = 'MANAGED_REMOTE_NOT_SET_UP';
/** Refusal code: Cloud could not start setup. */
export const MANAGED_REMOTE_SETUP_FAILED = 'MANAGED_REMOTE_SETUP_FAILED';

/** The note shown once a withdrawal could not reach Cloud. */
export const CLOUD_MAY_REMAIN_NOTE =
  'Turned off here. DorkOS Cloud may still have a record of this computer.';

/**
 * Build a refusal.
 *
 * @param status - The HTTP status the route answers with.
 * @param code - One of the codes above.
 * @param error - What a person reads.
 */
export function refusal(status: number, code: string, error: string): CoordinatorRefusal {
  return { ok: false, status, code, error };
}

/** Managed remote access cannot be offered on this computer right now. */
export const UNAVAILABLE = refusal(
  409,
  MANAGED_REMOTE_UNAVAILABLE,
  'DorkOS remote access is not available on this computer right now.'
);

/** A setup that a newer setup, a withdrawal or the end of the link overtook. */
export const SUPERSEDED = refusal(
  409,
  MANAGED_REMOTE_UNAVAILABLE,
  'Setup was cancelled before Cloud answered.'
);

/** How a refused enrolment request reads, and what it tells the coordinator. */
export interface RequestRefusal {
  refusal: CoordinatorRefusal;
  /** Cloud answered `404`: the service here does not offer managed access. */
  absent: boolean;
  /** Cloud already holds an enrolment for this computer. */
  cloudHolds: boolean;
}

/**
 * Read a failed `POST /v1/remote/enrolment/requests`.
 *
 * @param error - What the client threw.
 */
export function requestRefusal(error: unknown): RequestRefusal {
  if (isAbsent(error)) return { refusal: UNAVAILABLE, absent: true, cloudHolds: false };
  const code = problemOf(error)?.code;
  if (code === 'conflict') {
    return {
      // The way out is a withdrawal, which asks Cloud to forget its enrolment.
      refusal: refusal(
        409,
        MANAGED_REMOTE_ALREADY_SET_UP,
        'DorkOS Cloud already has this computer. Withdraw it, then set it up again.'
      ),
      absent: false,
      cloudHolds: true,
    };
  }
  if (code === 'entitlement_required') {
    return {
      refusal: refusal(
        409,
        MANAGED_REMOTE_UNAVAILABLE,
        'This account cannot use DorkOS remote access.'
      ),
      absent: false,
      cloudHolds: false,
    };
  }
  logger.warn('[RemoteAccess] Enrolment request refused', { code: code ?? errorName(error) });
  return {
    refusal: refusal(
      502,
      MANAGED_REMOTE_SETUP_FAILED,
      'DorkOS Cloud could not start setup. Try again.'
    ),
    absent: false,
    cloudHolds: false,
  };
}
