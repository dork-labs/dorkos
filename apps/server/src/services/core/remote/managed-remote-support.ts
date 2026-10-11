/**
 * Small helpers the managed remote coordinator leans on, kept apart so the
 * coordinator reads as the ceremony it runs.
 *
 * @module services/core/remote/managed-remote-support
 */
import { RemoteCredentialSchema, V1_ROUTES, type RemoteCredential } from '@dork-labs/cloud-api';
import { CloudApiResponseError } from '@dork-labs/cloud-api/client';

import { logger } from '../../../lib/logger.js';
import { problemOf, type CloudV1Context } from '../cloud/v1-client.js';

/** How many fresh idempotency keys one setup tries when Cloud answers `conflict`. */
const MAX_ISSUE_ATTEMPTS = 3;

/**
 * Whether a failed read was a success this build could not parse: a service a
 * release ahead. The contract says to treat such an answer as ended.
 */
export function unreadable(error: unknown): boolean {
  return error instanceof CloudApiResponseError && error.status < 400;
}

/** A loggable name for an error: its class, never its message (which could carry a body). */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Ask Cloud for a credential for `instanceId`, with a fresh idempotency key per
 * attempt.
 *
 * @param context - The link the setup runs under.
 * @param instanceId - The instance the credential is for.
 * @param options.stillLive - Whether the setup still owns the link.
 * @param options.newIdempotencyKey - A key Cloud has never seen.
 * @returns The credential; `'stale'` when the setup was overtaken meanwhile;
 *   `null` when Cloud would not issue one.
 */
export async function issueRemoteCredential(
  context: CloudV1Context,
  instanceId: string,
  options: { stillLive: () => boolean; newIdempotencyKey: () => string }
): Promise<RemoteCredential | 'stale' | null> {
  for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt += 1) {
    // Chosen before the call and never reused: a key Cloud has seen is
    // refused with `conflict`, never answered twice, so after any lost or
    // refused answer the only recovery is a new key.
    const idempotencyKey = options.newIdempotencyKey();
    try {
      return await context.client.post(V1_ROUTES.remoteCredentialsIssue, RemoteCredentialSchema, {
        body: { instanceId, idempotencyKey },
      });
    } catch (error) {
      if (!options.stillLive()) return 'stale';
      if (problemOf(error)?.code === 'conflict') continue;
      logger.warn('[RemoteAccess] Credential issue refused', {
        code: problemOf(error)?.code ?? errorName(error),
      });
      return null;
    }
  }
  return null;
}
