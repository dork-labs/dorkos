/**
 * The DorkOS Cloud `/v1` client seam — one place that knows how to build a
 * contract client for this instance, and the only place that reads the linked
 * credential for it.
 *
 * It is deliberately thin. `@dork-labs/cloud-api/client` already owns the
 * request shape, the schema validation and the problem envelope; all this module
 * adds is where the service lives (the existing cloud config) and who is calling
 * (the existing device-link instance credential). Nothing here bakes in a host,
 * a plan, a price or any catalog value.
 *
 * **Not linked is a normal state, not an error.** Every reader returns `null`
 * when this instance holds no credential, so a surface built on it degrades to
 * hidden rather than to a red banner. The `/v1` paths sit BESIDE the legacy
 * cloud paths the app already calls; nothing here replaces those.
 *
 * @module services/core/cloud/v1-client
 */
import { SessionSchema, V1_ROUTES } from '@dork-labs/cloud-api';
import {
  createCloudApiClient,
  CloudApiProblemError,
  type CloudApiClient,
} from '@dork-labs/cloud-api/client';
import type { Problem } from '@dork-labs/cloud-api';
import { configManager } from '../config-manager.js';
import { resolveCloudBaseUrl } from '../auth/cloud-link-client.js';
import { getCloudLinkGeneration } from '../auth/cloud-link.js';

let observedToken: string | null = null;
let tokenEpoch = 0;
let observedManager: typeof configManager | undefined;
let stopObserving: (() => void) | undefined;

/** One process-wide listener records intermediate token changes, including A → unlink → A. */
function observeTokenChanges(): void {
  if (observedManager === configManager) return;
  stopObserving?.();
  observedManager = configManager;
  observedToken = readCloudInstanceToken();
  tokenEpoch += 1;
  stopObserving = configManager.onChange((change) => {
    if (!change.paths.some((path) => path === 'cloud' || path === 'cloud.instanceToken')) return;
    const current = readCloudInstanceToken();
    if (current === observedToken) return;
    observedToken = current;
    tokenEpoch += 1;
  });
}

/**
 * This instance's linked credential, or `null` when it has never been linked
 * (or was unlinked). Read through the config manager so it stays the single
 * source of truth — the value itself is never logged and never leaves the
 * server.
 */
export function readCloudInstanceToken(): string | null {
  return configManager.get('cloud')?.instanceToken ?? null;
}

/** Whether this instance currently holds a cloud credential. */
export function isCloudLinked(): boolean {
  return readCloudInstanceToken() !== null;
}

/**
 * A `/v1` client bound to this instance's credential, or `null` when unlinked.
 *
 * Built per call rather than cached: the credential can be replaced by a
 * re-link or cleared by an unlink at any moment, and a cached client would keep
 * presenting the old one.
 */
export function createCloudV1Client(): CloudApiClient | null {
  const token = readCloudInstanceToken();
  if (token === null) return null;
  return createCloudApiClient({ baseUrl: resolveCloudBaseUrl(), token });
}

/**
 * A client and currency check captured under one linked credential and origin.
 * The credential stays inside the client; neither it nor the origin leaves this
 * server-only context. The generation catches same-token local relinking.
 */
export interface CloudV1Context {
  client: CloudApiClient;
  isCurrent(): boolean;
}

/** Capture the current link for a bounded sequence of Cloud requests. */
export function captureCloudV1Context(): CloudV1Context | null {
  observeTokenChanges();
  const token = readCloudInstanceToken();
  if (token === null || token.trim() === '') return null;
  const baseUrl = resolveCloudBaseUrl();
  const epoch = tokenEpoch;
  const manager = configManager;
  const generation = getCloudLinkGeneration();
  return {
    client: createCloudApiClient({ baseUrl, token }),
    isCurrent: () =>
      epoch === tokenEpoch &&
      manager === configManager &&
      token === readCloudInstanceToken() &&
      baseUrl === resolveCloudBaseUrl() &&
      generation === getCloudLinkGeneration(),
  };
}

/** Resolve only a service-issued instance ID under the captured credential. */
export async function resolveCloudInstanceId(context: CloudV1Context): Promise<string | null> {
  const session = await context.client.get(V1_ROUTES.session, SessionSchema);
  if (!context.isCurrent() || !session.authenticated) return null;
  const id = session.instanceId;
  return id && id.trim() !== '' ? id : null;
}

/**
 * The problem envelope behind a failed `/v1` call, or `null` when the failure
 * was not one the service described (a network error, a malformed body).
 *
 * @param error - The value a `/v1` call rejected with.
 */
export function problemOf(error: unknown): Problem | null {
  return error instanceof CloudApiProblemError ? error.problem : null;
}

/**
 * Whether a failed `/v1` call means "this route is not here", which every
 * surface reads as "nothing to show" rather than as a fault.
 *
 * Two shapes count. A route behind a server flag answers `404` with a problem
 * envelope; a service that has not deployed the route at all answers `404` with
 * something else entirely, which surfaces as a response error. Both mean the
 * same thing to a client: there is no payload, so render nothing.
 *
 * @param error - The value a `/v1` call rejected with.
 */
export function isAbsent(error: unknown): boolean {
  const problem = problemOf(error);
  if (problem !== null) return problem.status === 404 || problem.code === 'not_found';
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 404
  );
}

/**
 * Run a `/v1` read, answering `null` for every condition that means "no payload
 * for this instance": unlinked, route absent, or a refusal the service
 * described. Anything else — a network fault, a 5xx — rethrows, because a
 * surface that silently hides on an outage is lying about what it knows.
 *
 * @param read - The read to run against a live client.
 */
export async function readOrNull<T>(
  read: (client: CloudApiClient) => Promise<T>
): Promise<T | null> {
  const client = createCloudV1Client();
  if (client === null) return null;
  try {
    return await read(client);
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}
