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
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  ManagedConnectorCloudError,
  type ManagedConnectorCloudErrorCode,
} from '../services/core/auth/cloud-link-client.js';

/** The stable codes a refused managed-cloud call answers with. */
export type ManagedCloudRouteCode =
  'cloud_link_required' | 'cloud_link_needs_update' | 'cloud_unavailable' | 'cloud_refused';

interface ManagedCloudAnswer {
  status: ContentfulStatusCode;
  code: ManagedCloudRouteCode;
  error: string;
}

const UNAVAILABLE: ManagedCloudAnswer = {
  status: 503,
  code: 'cloud_unavailable',
  error:
    'DorkOS’s servers aren’t answering right now. Nothing changed. Try again in a few minutes.',
};

const REFUSED: ManagedCloudAnswer = {
  status: 502,
  code: 'cloud_refused',
  error:
    'DorkOS’s servers couldn’t finish this. Nothing changed on this computer. Try again later.',
};

const ANSWERS: Record<ManagedConnectorCloudErrorCode, ManagedCloudAnswer> = {
  unauthorized: {
    status: 401,
    code: 'cloud_link_required',
    error:
      'This computer isn’t linked to your DorkOS account anymore. Link it again in Settings › DorkOS account.',
  },
  permission_upgrade_required: {
    status: 409,
    code: 'cloud_link_needs_update',
    error:
      'This computer’s link to your DorkOS account needs updating. Link it again in Settings › DorkOS account.',
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
 * @returns The response when `error` was a `ManagedConnectorCloudError`;
 *   `undefined` when the caller must keep mapping its own error types.
 */
export function managedCloudErrorResponse(c: Context, error: unknown): Response | undefined {
  if (!(error instanceof ManagedConnectorCloudError)) return undefined;
  const answer = ANSWERS[error.code];
  return c.json({ error: answer.error, code: answer.code }, answer.status);
}
