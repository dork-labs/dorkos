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
import { ManagedConnectorCloudError } from '../services/core/auth/cloud-link-client.js';
import { MANAGED_CLOUD_PROBLEM } from '../services/connectors/resources/owner-refusals.js';

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
  const answer = MANAGED_CLOUD_PROBLEM[error.code];
  return problem(c, answer.code, { detail: answer.detail });
}

/**
 * A refused managed-cloud call's code, or `undefined` for any other error: what
 * the capability mount's connection doors are given to answer it as the hand
 * routes do (DOR-4978).
 *
 * @param error - Whatever the door caught.
 */
export function managedCloudRefusalCode(error: unknown): string | undefined {
  return error instanceof ManagedConnectorCloudError ? error.code : undefined;
}
