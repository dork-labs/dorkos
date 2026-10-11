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
  type FetchLike,
} from '@dork-labs/cloud-api/client';
import type { Problem } from '@dork-labs/cloud-api';
import { configManager } from '../config-manager.js';
import { resolveCloudBaseUrl } from '../auth/cloud-link-client.js';
import { getCloudLinkGeneration } from '../auth/cloud-link.js';
import { env } from '../../../env.js';

let v1Fetch: FetchLike | undefined;

/**
 * Replace the `fetch` every `/v1` client is built with, or pass `undefined` to
 * go back to the global one. Only the test-mode composition root calls this,
 * to answer `/v1` from an in-process fake; production never sets it.
 *
 * @param fetch - The replacement, or `undefined` for the global `fetch`.
 * @throws If a replacement is set outside `DORKOS_TEST_RUNTIME`: a real
 *   server always talks to the real service.
 * @internal
 */
export function setCloudV1Fetch(fetch: FetchLike | undefined): void {
  if (fetch !== undefined && !env.DORKOS_TEST_RUNTIME) {
    throw new Error('setCloudV1Fetch is test-mode only (DORKOS_TEST_RUNTIME)');
  }
  v1Fetch = fetch;
}

/** Build one contract client, with the replacement `fetch` only when one is set. */
function buildClient(baseUrl: string, token: string): CloudApiClient {
  return createCloudApiClient({ baseUrl, token, ...(v1Fetch && { fetch: v1Fetch }) });
}

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
  return buildClient(resolveCloudBaseUrl(), token);
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
    client: buildClient(baseUrl, token),
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
  return (await resolveCloudIdentity(context)).instanceId;
}

/** Who the captured credential belongs to, as far as the service says. */
export interface CloudIdentity {
  /** The service-issued instance id, or `null`. */
  instanceId: string | null;
  /**
   * The DorkOS account this link belongs to — the account's id, else its
   * organization's — or `null` when the service names neither.
   */
  accountKey: string | null;
}

/**
 * Introspect the captured credential once: its instance id, and the account
 * (or organization) it belongs to. Both `null` when the context went stale or
 * the credential is not authenticated.
 *
 * @param context - The captured link context.
 */
export async function resolveCloudIdentity(context: CloudV1Context): Promise<CloudIdentity> {
  const session = await context.client.get(V1_ROUTES.session, SessionSchema);
  if (!context.isCurrent() || !session.authenticated) {
    return { instanceId: null, accountKey: null };
  }
  const id = session.instanceId;
  const key = session.account?.id ?? session.orgId ?? null;
  return {
    instanceId: id && id.trim() !== '' ? id : null,
    accountKey: key && key.trim() !== '' ? key : null,
  };
}

/**
 * The DorkOS account this computer is linked to right now, or `null` when it
 * is not linked or the service could not say. Never throws.
 */
export async function readCloudAccountKey(): Promise<string | null> {
  const context = captureCloudV1Context();
  if (context === null) return null;
  try {
    return (await resolveCloudIdentity(context)).accountKey;
  } catch {
    return null;
  }
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
