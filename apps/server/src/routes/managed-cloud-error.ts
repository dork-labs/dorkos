/**
 * One honest HTTP answer for every refused managed-cloud call.
 *
 * Every route that can reach DorkOS's managed cloud maps a
 * {@link ManagedConnectorCloudError} through {@link managedCloudErrorResponse}
 * before its own catch-all, so a refusal never becomes a generic 500 and the
 * client can branch on one stable `code`.
 *
 * @module routes/managed-cloud-error
 */
import type { Context } from 'hono';
import { problem } from '@dorkos/http-kit';
import type { ProblemCode } from '@dorkos/shared/problem';
import {
  ManagedConnectorCloudError,
  type ManagedConnectorCloudErrorCode,
} from '../services/core/auth/cloud-link-client.js';

/** The problem a refused managed-cloud call answers with: its code and fixed sentence. */
interface ManagedCloudAnswer {
  readonly code: ProblemCode;
  readonly detail: string;
}

const UNAVAILABLE: ManagedCloudAnswer = {
  code: 'cloud_unavailable',
  detail: 'DorkOS’s servers aren’t answering. Nothing changed. Try again soon.',
};

const REFUSED: ManagedCloudAnswer = {
  code: 'cloud_refused',
  detail: 'DorkOS’s servers couldn’t finish this. Nothing changed here. Try again later.',
};

const ANSWERS: Record<ManagedConnectorCloudErrorCode, ManagedCloudAnswer> = {
  unauthorized: {
    code: 'cloud_link_required',
    detail: 'This computer isn’t linked to your DorkOS account. Link it again in Settings.',
  },
  permission_upgrade_required: {
    code: 'cloud_link_required',
    detail: 'This computer’s link to your DorkOS account needs updating. Link it again.',
  },
  unavailable: UNAVAILABLE,
  network_error: UNAVAILABLE,
  request_failed: REFUSED,
  invalid_response: REFUSED,
  not_found: REFUSED,
  conflict: REFUSED,
};

/**
 * The answer for a refused managed-cloud call, honestly.
 *
 * The cloud's own reason never reaches the response body; it is already in
 * the one log line the refusal wrote.
 *
 * @param c - The Hono context to answer.
 * @param error - Whatever the route caught.
 * @returns The problem response when `error` was a `ManagedConnectorCloudError`;
 *   `undefined` when the caller must keep mapping its own error types.
 */
export function managedCloudErrorResponse(c: Context, error: unknown): Response | undefined {
  if (!(error instanceof ManagedConnectorCloudError)) return undefined;
  const answer = ANSWERS[error.code];
  return problem(c, answer.code, { detail: answer.detail });
}
