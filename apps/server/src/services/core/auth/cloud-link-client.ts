/**
 * Pure device-flow HTTP client for linking this instance to a DorkOS account
 * (accounts-and-auth P2, task 2.4).
 *
 * Speaks the RFC 8628 device-authorization contract the cloud (task 2.3) exposes
 * over Better Auth's `deviceAuthorization` plugin, plus the instance heartbeat
 * and revoke endpoints. Every function is stateless and takes an injectable
 * `fetchImpl` (default: the platform `fetch`), an injectable `sleep`, and an
 * injectable `now` so the poll loop is deterministic under test with no real
 * network and no wall-clock dependence.
 *
 * This module holds NO token and touches NO config — the token lifecycle lives
 * in the {@link import('./cloud-link.js').CloudLinkManager} (server) and the
 * `dorkos cloud` CLI dispatcher, both of which reuse these primitives. It also
 * never logs a token or access key.
 *
 * @module services/core/auth/cloud-link-client
 */
import { createHmac } from 'node:crypto';
import { hostname } from 'node:os';
import {
  CONNECTOR_AUTH_SETUP_HEADER,
  CONNECTOR_AUTH_SETUP_VERSION,
} from '@dorkos/shared/connector-provider';
import {
  ManagedConnectorAuthorityCommandSchema,
  ManagedConnectorAuthorityCommandStatusSchema,
  ManagedConnectorErrorBodySchema,
  ManagedConnectorExecutionReceiptStatusSchema,
  ManagedConnectorExecutionRequestSchema,
  ManagedConnectorExecutionResponseSchema,
  type ManagedConnectorAuthorityCommand,
  type ManagedConnectorAuthorityCommandStatus,
  type ManagedConnectorExecutionReceiptStatus,
  type ManagedConnectorExecutionRequest,
  type ManagedConnectorExecutionResponse,
} from '@dorkos/shared/connector-managed-schemas';
import {
  ManagedConnectorUsageRequestSchema,
  ManagedConnectorUsageResponseSchema,
  type ManagedConnectorUsageRequest,
  type ManagedConnectorUsageResponse,
} from '@dorkos/shared/connector-managed-usage-schemas';
import {
  ManagedConnectorAccountListResponseSchema,
  ManagedConnectorAccountResponseSchema,
  ManagedConnectorAuthenticationCreateRequestSchema,
  ManagedConnectorAuthenticationStateSchema,
  ManagedConnectorCatalogPageSchema,
  ManagedConnectorOperationPageResponseSchema,
  ManagedConnectorToolkitVersionResponseSchema,
  type ManagedConnectorAccountListRequest,
  type ManagedConnectorAccountListResponse,
  type ManagedConnectorAccountResponse,
  type ManagedConnectorAuthenticationCreateRequest,
  type ManagedConnectorAuthenticationState,
  type ManagedConnectorCatalogPage,
  type ManagedConnectorCatalogRequest,
  type ManagedConnectorOperationPageRequest,
  type ManagedConnectorOperationPageResponse,
  type ManagedConnectorToolkitVersionRequest,
  type ManagedConnectorToolkitVersionResponse,
} from '@dorkos/shared/connector-managed-discovery-schemas';
import {
  ManagedConnectorEventDefinitionPageSchema,
  ManagedConnectorEventPullResponseSchema,
  ManagedConnectorEventPullRequestSchema,
  ManagedConnectorEventAckRequestSchema,
  ManagedConnectorEventAckResponseSchema,
} from '@dorkos/shared/connector-event-schemas';
import type { ConnectorEventPageRequest } from '@dorkos/shared/connector-events';
import { ZodError, type ZodType } from 'zod';
import { logger } from '../../../lib/logger.js';
import { env } from '../../../env.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/**
 * Stable `client_id` a DorkOS instance presents on the device-authorization
 * endpoints (mirrors the cloud's `INSTANCE_CLIENT_ID`). RFC 8628 requires a
 * client id; the flow is not per-app-registered, so one shared id suffices.
 */
export const INSTANCE_CLIENT_ID = 'dorkos-instance';

/** Default DorkOS cloud base URL when `DORKOS_CLOUD_URL` is unset. */
export const DEFAULT_CLOUD_URL = 'https://dorkos.ai';

/** RFC 8628 device-code grant type sent on every token poll. */
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Seconds added to the poll interval each time the cloud answers `slow_down` (RFC 8628 §3.5). */
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const MANAGED_CONNECTOR_REQUEST_TIMEOUT_MS = 10_000;
/** Hosted start is capped at 45s; retain 15s for transport and response parsing. */
const MANAGED_CONNECTOR_AUTHENTICATION_START_TIMEOUT_MS = 60_000;

/** A minimal `fetch` shape so callers can inject a mock without pulling DOM lib types. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The instance display metadata carried through the device-link flow. */
export interface InstanceDescriptor {
  /** Human-readable instance name (typically the hostname). */
  name: string;
  /** `process.platform` of the instance (e.g. `darwin`, `linux`, `win32`). */
  platform: string;
  /** DorkOS version the instance is running. */
  dorkosVersion: string;
  /**
   * This install's anonymous per-install telemetry `instanceId` (DOR-320, ADR
   * 260713-143958 Phase 4, the device-link merge point). **Optional and opt-in:**
   * only populated when `telemetry.linkAnalyticsToAccount` is on AND no env kill
   * switch is set (see {@link resolveLinkTelemetryInstanceId}); absent otherwise.
   * Serialized into the `POST /device/code` `scope` only when present, so its
   * presence on the wire is the app-side consent signal the cloud reads to alias
   * this install's anonymous history onto the account person. Keep this contract
   * in sync with the site's `lib/instance-descriptor.ts` and
   * `aliasInstanceToAccount`.
   */
  telemetryInstanceId?: string;
  /**
   * Proof that this install held the instance key it had before this link
   * request (see {@link linkProofForKey}), sent so the cloud can continue that same
   * link, and the apps connected through it, when the same DorkOS account approves while that link is still live.
   * **Optional:** present only when a previous key is known (a key held right
   * now, or `cloud.previousLinkProof` kept from the last unlink). Serialized
   * into the `POST /device/code` `scope` only when present, so a first link's
   * wire shape is unchanged. Never the raw key.
   */
  previousLinkProof?: string;
}

/** The `POST /api/auth/device/code` success body (RFC 8628). */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** Terminal outcome of the device-token poll loop. */
export type PollResult =
  { status: 'approved'; accessToken: string } | { status: 'denied' } | { status: 'expired' };

/** Outcome of a single heartbeat call. `unauthorized` is the unlink signal. */
export type HeartbeatResult =
  | { ok: true; instanceId: string; lastSeenAt: string; accountLabel: string | null }
  | { ok: false; unauthorized: true }
  | { ok: false; unauthorized: false; error: string };

/** Stable managed-cloud refusal categories used by durable local recovery. */
export type ManagedConnectorCloudErrorCode =
  | 'unauthorized'
  | 'permission_upgrade_required'
  | 'not_found'
  | 'conflict'
  | 'unavailable'
  | 'network_error'
  | 'request_failed'
  | 'invalid_response';

/** What one managed-cloud refusal carries beside its category, for logs and route mapping. */
export interface ManagedConnectorCloudErrorOptions extends ErrorOptions {
  /** The HTTP status the cloud answered with, when it answered at all. */
  status?: number;
  /** The cloud's own `error` code from its refusal body. */
  cloudCode?: string;
  /** The cloud's own `reason`, capped at 200 characters and never put in `message`. */
  reason?: string;
  /** The HTTP method of the refused request. */
  method?: string;
  /** No query string; a cursor or token must never reach a log line. */
  path?: string;
  /** `invalid_response` only. Zod issue paths, never the values that failed. */
  issuePaths?: string[];
}

/** Safe managed-cloud error whose message never includes a hosted response body or token. */
export class ManagedConnectorCloudError extends Error {
  /** The stable refusal category. */
  readonly code: ManagedConnectorCloudErrorCode;
  /** The HTTP status the cloud answered with, when it answered at all. */
  readonly status?: number;
  /** The cloud's own `error` code from its refusal body. */
  readonly cloudCode?: string;
  /** The cloud's own `reason`, capped at 200 characters. */
  readonly reason?: string;
  /** The HTTP method of the refused request. */
  readonly method?: string;
  /** The refused request's path, without its query string. */
  readonly path?: string;
  /** Zod issue paths for an `invalid_response`, never the values that failed. */
  readonly issuePaths?: string[];

  /** Construct one typed managed-cloud refusal. */
  constructor(code: ManagedConnectorCloudErrorCode, options?: ManagedConnectorCloudErrorOptions) {
    super(managedConnectorCloudErrorMessage(code), options);
    this.name = 'ManagedConnectorCloudError';
    this.code = code;
    this.status = options?.status;
    this.cloudCode = options?.cloudCode;
    this.reason = options?.reason?.slice(0, 200);
    this.method = options?.method;
    this.path = options?.path?.split('?')[0];
    this.issuePaths = options?.issuePaths;
  }
}

/** Local token absence proves that no hosted request has been dispatched. */
export class ManagedConnectorLinkRequiredError extends ManagedConnectorCloudError {
  /** Preserve the unauthorized category for existing account recovery consumers. */
  constructor() {
    super('unauthorized');
    this.name = 'ManagedConnectorLinkRequiredError';
  }
}

function managedConnectorCloudErrorMessage(code: ManagedConnectorCloudErrorCode): string {
  switch (code) {
    case 'unauthorized':
      return 'This computer isn’t linked to your DorkOS account anymore.';
    case 'permission_upgrade_required':
      return 'Your DorkOS account link needs updating. Link this computer again in Settings › Access.';
    case 'not_found':
      return 'DorkOS’s servers couldn’t find this request.';
    case 'conflict':
      return 'DorkOS’s servers turned this down because it clashed with another change.';
    case 'unavailable':
      return 'DorkOS’s servers aren’t answering right now.';
    case 'network_error':
      return 'Couldn’t reach DorkOS’s servers.';
    case 'invalid_response':
      return 'DorkOS’s servers sent back an answer that didn’t make sense.';
    case 'request_failed':
      return 'DorkOS’s servers turned the request down.';
  }
}

/** Which managed-cloud call refused, for the one log line each refusal writes. */
interface ManagedCloudRequest {
  /** A short label naming the calling function, e.g. `catalog`. */
  kind: string;
  method: string;
  path: string;
}

/**
 * Write the one log line a managed-cloud refusal gets. Never throws. The path
 * loses its query string and the reason is capped, so a cursor, token, or long
 * hosted message never reaches the log.
 */
function logManagedCloudRefusal(details: {
  kind: string;
  method: string;
  path: string;
  status?: number;
  cloudCode?: string;
  reason?: string;
  code: ManagedConnectorCloudErrorCode;
}): void {
  try {
    logger.warn('[CloudLink] Managed cloud request refused', {
      ...details,
      path: details.path.split('?')[0],
      reason: details.reason?.slice(0, 200),
    });
  } catch {
    // Logging must never turn a refusal into a different failure.
  }
}

/** Log and build the error for a success status whose body failed its schema. */
function unexpectedManagedCloudAnswer(
  error: unknown,
  response: Response,
  request: ManagedCloudRequest
): ManagedConnectorCloudError {
  const issuePaths =
    error instanceof ZodError ? error.issues.map((issue) => issue.path.join('.')) : undefined;
  try {
    logger.warn('[CloudLink] Managed cloud answered something unexpected', {
      kind: request.kind,
      status: response.status,
      issuePaths,
    });
  } catch {
    // Logging must never turn a refusal into a different failure.
  }
  return new ManagedConnectorCloudError('invalid_response', {
    status: response.status,
    issuePaths,
    method: request.method,
    path: request.path,
  });
}

/** Log and build the error for a request that never got an answer. */
function managedCloudNetworkError(
  error: unknown,
  request: ManagedCloudRequest
): ManagedConnectorCloudError {
  logManagedCloudRefusal({ ...request, code: 'network_error' });
  return new ManagedConnectorCloudError('network_error', {
    method: request.method,
    path: request.path,
    cause: error,
  });
}

/** The most of a refusal body read before giving up on it; a real one is tiny. */
export const MANAGED_ERROR_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Read at most {@link MANAGED_ERROR_BODY_LIMIT_BYTES} of a response body, then
 * let the rest go, so a proxy's multi-megabyte error page is never buffered.
 * A body cut off at the limit simply fails to parse as JSON.
 *
 * @internal Exported for tests.
 */
export async function readBoundedText(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MANAGED_ERROR_BODY_LIMIT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    return undefined;
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(size, MANAGED_ERROR_BODY_LIMIT_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const room = bytes.byteLength - offset;
    if (room <= 0) break;
    bytes.set(chunk.subarray(0, room), offset);
    offset += Math.min(chunk.byteLength, room);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Read the cloud's `{error, reason?}` refusal body. The exact shape is the
 * shared schema; anything past it is read field by field, so one oversize or
 * malformed field never costs the refusal its code. Both strings are capped.
 */
function readManagedErrorBody(text: string | undefined): {
  cloudCode?: string;
  reason?: string;
} {
  if (!text) return {};
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }
  const parsed = ManagedConnectorErrorBodySchema.safeParse(json);
  if (parsed.success) return { cloudCode: parsed.data.error, reason: parsed.data.reason };
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return {};
  const body = json as { error?: unknown; reason?: unknown };
  return {
    cloudCode:
      typeof body.error === 'string' && body.error.length > 0
        ? body.error.slice(0, 100)
        : undefined,
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined,
  };
}

/** Map a non-2xx cloud answer to its category, carrying the cloud's own code and reason. */
async function throwManagedConnectorCloudError(
  response: Response,
  request: ManagedCloudRequest
): Promise<never> {
  const { cloudCode, reason } = readManagedErrorBody(await readBoundedText(response));
  const common = {
    status: response.status,
    cloudCode,
    reason,
    method: request.method,
    path: request.path.split('?')[0],
  };
  const code: ManagedConnectorCloudErrorCode =
    response.status === 401
      ? 'unauthorized'
      : response.status === 403
        ? cloudCode === 'permission_upgrade_required'
          ? 'permission_upgrade_required'
          : 'request_failed'
        : response.status === 404
          ? 'not_found'
          : response.status === 409
            ? 'conflict'
            : response.status >= 500
              ? 'unavailable'
              : 'request_failed';
  logManagedCloudRefusal({ kind: request.kind, code, ...common });
  throw new ManagedConnectorCloudError(code, common);
}

async function parseManagedAuthorityStatus(
  response: Response,
  request: ManagedCloudRequest
): Promise<ManagedConnectorAuthorityCommandStatus> {
  if (!response.ok) await throwManagedConnectorCloudError(response, request);
  try {
    return ManagedConnectorAuthorityCommandStatusSchema.parse(await response.json());
  } catch (error) {
    throw unexpectedManagedCloudAnswer(error, response, request);
  }
}

async function requestManagedConnectorResource<T>(opts: {
  /** A short label naming the calling function, carried into the refusal log line. */
  kind: string;
  baseUrl: string;
  accessToken: string;
  path: string;
  schema: ZodType<T>;
  fetchImpl?: FetchLike;
  signal: AbortSignal;
  method?: 'GET' | 'POST';
  catalogAuthenticationSetup?: boolean;
  body?: unknown;
  timeoutMs?: number;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
}): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const timeoutMs = opts.timeoutMs ?? MANAGED_CONNECTOR_REQUEST_TIMEOUT_MS;
  const timeout = opts.timeoutSignal
    ? opts.timeoutSignal(timeoutMs)
    : AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([opts.signal, timeout]);
  const request: ManagedCloudRequest = {
    kind: opts.kind,
    method: opts.method ?? 'GET',
    path: opts.path.split('?')[0],
  };
  let response: Response;
  try {
    response = await fetchImpl(`${opts.baseUrl}${opts.path}`, {
      method: opts.method ?? 'GET',
      headers: {
        authorization: `Bearer ${opts.accessToken}`,
        ...(opts.catalogAuthenticationSetup
          ? { [CONNECTOR_AUTH_SETUP_HEADER]: CONNECTOR_AUTH_SETUP_VERSION }
          : {}),
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal,
    });
  } catch (error) {
    if (opts.signal.aborted) throw opts.signal.reason;
    throw managedCloudNetworkError(error, request);
  }
  if (!response.ok) await throwManagedConnectorCloudError(response, request);
  try {
    return opts.schema.parse(await response.json());
  } catch (error) {
    throw unexpectedManagedCloudAnswer(error, response, request);
  }
}

function managedQuery(entries: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query.toString();
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the DorkOS cloud base URL from the validated server env, with any
 * trailing slash stripped so path concatenation never doubles the separator.
 */
export function resolveCloudBaseUrl(): string {
  return (env.DORKOS_CLOUD_URL || DEFAULT_CLOUD_URL).replace(/\/+$/, '');
}

/** The fixed message the relink proof authenticates (versioned so it can change). */
export const LINK_PROOF_MESSAGE = 'dorkos-relink-v1';

/**
 * The relink proof for an instance key: HMAC-SHA256 keyed by the raw key string
 * (UTF-8) over {@link LINK_PROOF_MESSAGE}, encoded base64url without padding
 * (Node's `base64url` never pads). Only someone holding the key can compute it,
 * and it is not the plain SHA-256 of the key, so a stored hash of the key can
 * never stand in for it. The hosted side keeps only a one-way hash of the proof.
 *
 * @param instanceKey - The raw instance key the cloud issued.
 * @returns The 43-character base64url proof.
 */
export function linkProofForKey(instanceKey: string): string {
  return createHmac('sha256', instanceKey).update(LINK_PROOF_MESSAGE).digest('base64url');
}

/**
 * Build this instance's descriptor: hostname, platform, and the running DorkOS
 * version. Resolves the same in the server and the bundled CLI (both share
 * `lib/version.ts`).
 *
 * @param telemetryInstanceId - The anonymous per-install telemetry id to carry,
 *   or `undefined` to omit it. Callers resolve this via
 *   {@link resolveLinkTelemetryInstanceId} (config opt-in + env kill switches)
 *   and pass it in only at link time; heartbeats never carry it.
 */
export function buildInstanceDescriptor(telemetryInstanceId?: string): InstanceDescriptor {
  return {
    name: hostname(),
    platform: process.platform,
    dorkosVersion: SERVER_VERSION,
    // Included only when the caller opted in; keeps the wire shape unchanged
    // (and the merge un-triggered) for every install without the opt-in.
    ...(telemetryInstanceId ? { telemetryInstanceId } : {}),
  };
}

/**
 * Request a device code from the cloud, carrying this instance's descriptor in
 * the OAuth `scope` field so the cloud can show the human which instance is
 * asking before they approve.
 *
 * @param opts - Base URL, this instance's descriptor, and an optional `fetchImpl`.
 * @returns The device/user codes and verification URIs for display.
 * @throws If the cloud responds with a non-2xx status.
 */
export async function requestDeviceCode(opts: {
  baseUrl: string;
  descriptor: InstanceDescriptor;
  fetchImpl?: FetchLike;
}): Promise<DeviceCodeResponse> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const res = await fetchImpl(`${opts.baseUrl}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: INSTANCE_CLIENT_ID,
      scope: JSON.stringify({
        name: opts.descriptor.name,
        platform: opts.descriptor.platform,
        dorkosVersion: opts.descriptor.dorkosVersion,
        // Only serialized when present (the app-side telemetry opt-in); its
        // presence is what the cloud reads to merge this install's anonymous
        // analytics onto the account person (site `aliasInstanceToAccount`).
        ...(opts.descriptor.telemetryInstanceId
          ? { telemetryInstanceId: opts.descriptor.telemetryInstanceId }
          : {}),
        // Only serialized when a previous key is known; its presence asks the
        // cloud to continue that link rather than start a new one.
        ...(opts.descriptor.previousLinkProof
          ? { previousLinkProof: opts.descriptor.previousLinkProof }
          : {}),
      }),
    }),
  });
  if (!res.ok) {
    throw new Error(`Device code request failed (HTTP ${res.status})`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

/**
 * How long one device-token request may take. Its own bound, never the
 * cancel signal: once sent, a token request is allowed to finish, so this is
 * what keeps a cancel from waiting on a request that hangs. A timeout reads
 * as a failed poll.
 */
export const DEVICE_TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Read a JSON body, giving up when `signal` aborts. The race is explicit
 * rather than left to the fetch implementation, so a body that stalls after
 * its headers ends at the bound whichever fetch delivered it.
 */
function readJsonUntil(res: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    res
      .json()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Wait `ms`, or less if `signal` aborts first. */
function sleepUnlessAborted(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    sleep(ms).then(done, done);
  });
}

/**
 * Poll the device-token endpoint until the flow reaches a terminal state,
 * honoring the RFC 8628 `interval`, `slow_down` backoff, and the code's expiry.
 *
 * Sleeps `interval` seconds BEFORE each poll (never hammering the cloud), then
 * checks the local expiry deadline. Recognized cloud errors map to terminal
 * states (`access_denied` -> denied; `expired_token`/`invalid_grant` -> expired)
 * or continue the loop (`authorization_pending`, or `slow_down` which also bumps
 * the interval). An unrecognized error or a network failure throws so the caller
 * surfaces it (rather than looping forever).
 *
 * @param opts - Device code, timing, and injectable `fetchImpl`/`sleep`/`now`/`signal`.
 * @returns The terminal {@link PollResult}.
 */
export async function pollForToken(opts: {
  baseUrl: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<PollResult> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  const deadline = now() + opts.expiresIn * 1000;
  let intervalSeconds = opts.interval;

  for (;;) {
    if (opts.signal?.aborted) return { status: 'expired' };
    // An abort ends the wait at once. A token request already sent is never
    // abandoned: the cloud issues the key when it answers.
    await sleepUnlessAborted(sleep, intervalSeconds * 1000, opts.signal);
    if (opts.signal?.aborted) return { status: 'expired' };
    if (now() >= deadline) return { status: 'expired' };

    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error('Device-token request timed out')),
      DEVICE_TOKEN_REQUEST_TIMEOUT_MS
    );
    // The bound covers the body read too: a response that sends its headers and
    // then stalls must not hold the poll (and every drain waiting on it) open.
    let res: Response;
    let body: { access_token?: string; error?: string };
    try {
      res = await fetchImpl(`${opts.baseUrl}/api/auth/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: opts.deviceCode,
          client_id: INSTANCE_CLIENT_ID,
        }),
        signal: timeout.signal,
      });
      body = res.ok
        ? ((await readJsonUntil(res, timeout.signal)) as { access_token?: string })
        : res.status === 400
          ? ((await readJsonUntil(res, timeout.signal).catch(() => ({}))) as { error?: string })
          : {};
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      if (!body.access_token)
        throw new Error('Cloud approved the link but returned no access token');
      return { status: 'approved', accessToken: body.access_token };
    }

    if (res.status === 400) {
      switch (body.error) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
          continue;
        case 'access_denied':
          return { status: 'denied' };
        case 'expired_token':
        case 'invalid_grant':
          return { status: 'expired' };
        default:
          throw new Error(`Unexpected device-token error: ${body.error ?? 'unknown'}`);
      }
    }

    throw new Error(`Device-token poll failed (HTTP ${res.status})`);
  }
}

/**
 * Send an instance heartbeat, authenticated by the instance's scoped API key as
 * a Bearer token. A `401` means the key was revoked (the instance was unlinked)
 * — surfaced as `{ ok: false, unauthorized: true }` so the caller clears its
 * token and never retry-loops a dead key.
 *
 * @param opts - Base URL, the Bearer access token, this instance's descriptor,
 *   an optional `fetchImpl`, and an optional `signal` that bounds the request
 *   (an abort reads as a transient failure, never as a refused key).
 * @returns The heartbeat outcome; never throws for HTTP-level failures.
 */
export async function sendHeartbeat(opts: {
  baseUrl: string;
  accessToken: string;
  descriptor: InstanceDescriptor;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<HeartbeatResult> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl}/api/instances/heartbeat`, {
      method: 'POST',
      ...(opts.signal ? { signal: opts.signal } : {}),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.accessToken}`,
      },
      body: JSON.stringify({
        name: opts.descriptor.name,
        platform: opts.descriptor.platform,
        dorkosVersion: opts.descriptor.dorkosVersion,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      unauthorized: false,
      error: err instanceof Error ? err.message : 'network error',
    };
  }
  if (res.status === 401) return { ok: false, unauthorized: true };
  if (!res.ok) return { ok: false, unauthorized: false, error: `HTTP ${res.status}` };
  const body = (await res.json()) as {
    instanceId: string;
    lastSeenAt: string;
    accountLabel?: string | null;
  };
  return {
    ok: true,
    instanceId: body.instanceId,
    lastSeenAt: body.lastSeenAt,
    accountLabel: typeof body.accountLabel === 'string' ? body.accountLabel : null,
  };
}

/**
 * Submit one idempotent managed connector authority command through the linked instance.
 *
 * @param opts - Linked cloud URL/token, exact shared command, transport, and cancellation signal.
 * @returns The strict durable hosted status for the submitted command.
 */
export async function submitManagedConnectorAuthorityCommand(opts: {
  baseUrl: string;
  accessToken: string;
  command: ManagedConnectorAuthorityCommand;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<ManagedConnectorAuthorityCommandStatus> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const command = ManagedConnectorAuthorityCommandSchema.parse(opts.command);
  const request: ManagedCloudRequest = {
    kind: 'authority_submit',
    method: 'POST',
    path: '/api/instances/connectors/authority-commands',
  };
  let response: Response;
  try {
    response = await fetchImpl(`${opts.baseUrl}/api/instances/connectors/authority-commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.accessToken}`,
      },
      body: JSON.stringify(command),
      signal: opts.signal,
    });
  } catch (error) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    throw managedCloudNetworkError(error, request);
  }
  return parseManagedAuthorityStatus(response, request);
}

/**
 * Recover one managed connector authority command without replaying its mutation blindly.
 *
 * @param opts - Linked cloud URL/token, command id, transport, and cancellation signal.
 * @returns The strict durable hosted status for the command.
 */
export async function readManagedConnectorAuthorityCommand(opts: {
  baseUrl: string;
  accessToken: string;
  commandId: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<ManagedConnectorAuthorityCommandStatus> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const request: ManagedCloudRequest = {
    kind: 'authority_read',
    method: 'GET',
    path: `/api/instances/connectors/authority-commands/${encodeURIComponent(opts.commandId)}`,
  };
  let response: Response;
  try {
    response = await fetchImpl(`${opts.baseUrl}${request.path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${opts.accessToken}` },
      signal: opts.signal,
    });
  } catch (error) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    throw managedCloudNetworkError(error, request);
  }
  return parseManagedAuthorityStatus(response, request);
}

/** Read one account-free managed toolkit page through the linked instance key. */
export function requestManagedConnectorCatalog(opts: {
  baseUrl: string;
  accessToken: string;
  request: ManagedConnectorCatalogRequest;
  fetchImpl?: FetchLike;
  signal: AbortSignal;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
}): Promise<ManagedConnectorCatalogPage> {
  const query = managedQuery({
    version: 1,
    query: opts.request.query,
    cursor: opts.request.cursor,
    limit: opts.request.limit,
  });
  return requestManagedConnectorResource({
    ...opts,
    kind: 'catalog',
    path: `/api/instances/connectors/catalog?${query}`,
    schema: ManagedConnectorCatalogPageSchema,
    catalogAuthenticationSetup: true,
  });
}

/** Resolve one concrete managed toolkit version through the linked instance key. */
export function requestManagedConnectorToolkitVersion(opts: {
  baseUrl: string;
  accessToken: string;
  request: ManagedConnectorToolkitVersionRequest;
  fetchImpl?: FetchLike;
  signal: AbortSignal;
}): Promise<ManagedConnectorToolkitVersionResponse> {
  return requestManagedConnectorResource({
    ...opts,
    kind: 'toolkit_version',
    path: `/api/instances/connectors/toolkits/${encodeURIComponent(opts.request.toolkit)}/version?version=1`,
    schema: ManagedConnectorToolkitVersionResponseSchema,
  });
}

/** Read one immutable managed operation-schema page through the linked instance key. */
export function requestManagedConnectorOperationSchemas(opts: {
  baseUrl: string;
  accessToken: string;
  request: ManagedConnectorOperationPageRequest;
  fetchImpl?: FetchLike;
  signal: AbortSignal;
}): Promise<ManagedConnectorOperationPageResponse> {
  const query = managedQuery({
    version: 1,
    toolkitVersion: opts.request.toolkitVersion,
    cursor: opts.request.cursor,
    limit: opts.request.limit,
  });
  return requestManagedConnectorResource({
    ...opts,
    kind: 'operation_schemas',
    path: `/api/instances/connectors/toolkits/${encodeURIComponent(opts.request.toolkit)}/operations?${query}`,
    schema: ManagedConnectorOperationPageResponseSchema,
  });
}

/** Read one bounded managed connection inventory page through the linked instance key. */
export function requestManagedConnectorAccounts(opts: {
  baseUrl: string;
  accessToken: string;
  request: ManagedConnectorAccountListRequest;
  fetchImpl?: FetchLike;
  signal: AbortSignal;
}): Promise<ManagedConnectorAccountListResponse> {
  const query = managedQuery({
    version: 1,
    toolkit: opts.request.toolkit,
    cursor: opts.request.cursor,
    limit: opts.request.limit,
  });
  return requestManagedConnectorResource({
    ...opts,
    kind: 'accounts',
    path: `/api/instances/connectors/connections?${query}`,
    schema: ManagedConnectorAccountListResponseSchema,
  });
}

/** Read one exact managed connection through the linked instance key. */
export function requestManagedConnectorAccount(opts: {
  baseUrl: string;
  accessToken: string;
  managedConnectionId: string;
  fetchImpl?: FetchLike;
  signal: AbortSignal;
}): Promise<ManagedConnectorAccountResponse> {
  return requestManagedConnectorResource({
    ...opts,
    kind: 'account',
    path: `/api/instances/connectors/connections/${encodeURIComponent(opts.managedConnectionId)}?version=1`,
    schema: ManagedConnectorAccountResponseSchema,
  });
}

/** Start one idempotent managed provider-authentication flow. */
export function requestManagedConnectorAuthentication(opts: {
  baseUrl: string;
  accessToken: string;
  request: ManagedConnectorAuthenticationCreateRequest;
  fetchImpl?: FetchLike;
  signal: AbortSignal;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
}): Promise<ManagedConnectorAuthenticationState> {
  const request = ManagedConnectorAuthenticationCreateRequestSchema.parse(opts.request);
  return requestManagedConnectorResource({
    ...opts,
    kind: 'authentication_start',
    method: 'POST',
    body: request,
    path: '/api/instances/connectors/authentication-flows',
    schema: ManagedConnectorAuthenticationStateSchema,
    timeoutMs: MANAGED_CONNECTOR_AUTHENTICATION_START_TIMEOUT_MS,
  });
}

/** Read one exact managed provider-authentication flow. */
export function requestManagedConnectorAuthenticationState(opts: {
  baseUrl: string;
  accessToken: string;
  flowId: string;
  fetchImpl?: FetchLike;
  signal: AbortSignal;
}): Promise<ManagedConnectorAuthenticationState> {
  return requestManagedConnectorResource({
    ...opts,
    kind: 'authentication_state',
    path: `/api/instances/connectors/authentication-flows/${encodeURIComponent(opts.flowId)}`,
    schema: ManagedConnectorAuthenticationStateSchema,
  });
}

/** Execute one exact managed connector attempt through the linked instance key. */
export function executeManagedConnectorOperation(opts: {
  baseUrl: string;
  accessToken: string;
  request: ManagedConnectorExecutionRequest;
  fetchImpl?: FetchLike;
  signal: AbortSignal;
}): Promise<ManagedConnectorExecutionResponse> {
  const request = ManagedConnectorExecutionRequestSchema.parse(opts.request);
  return requestManagedConnectorResource({
    ...opts,
    kind: 'execution',
    method: 'POST',
    body: request,
    path: '/api/instances/connectors/executions',
    schema: ManagedConnectorExecutionResponseSchema,
  });
}

/** Read one authoritative hosted receipt without redispatching its attempt. */
export function requestManagedConnectorExecutionReceipt(opts: {
  baseUrl: string;
  accessToken: string;
  attemptId: string;
  fetchImpl?: FetchLike;
  signal: AbortSignal;
}): Promise<ManagedConnectorExecutionReceiptStatus> {
  return requestManagedConnectorResource({
    ...opts,
    kind: 'execution_receipt',
    path: `/api/instances/connectors/executions/${encodeURIComponent(opts.attemptId)}`,
    schema: ManagedConnectorExecutionReceiptStatusSchema,
  });
}

/** Read one authoritative hosted managed-usage page. */
export function requestManagedConnectorUsage(opts: {
  baseUrl: string;
  accessToken: string;
  request: ManagedConnectorUsageRequest;
  fetchImpl?: FetchLike;
  signal: AbortSignal;
}): Promise<ManagedConnectorUsageResponse> {
  const request = ManagedConnectorUsageRequestSchema.parse(opts.request);
  const query = managedQuery({
    version: request.version,
    managedConnectionId: request.managedConnectionId,
    agentId: request.agentId,
    cursor: request.cursor,
    limit: request.limit,
  });
  return requestManagedConnectorResource({
    ...opts,
    kind: 'usage',
    path: `/api/instances/connectors/usage?${query}`,
    schema: ManagedConnectorUsageResponseSchema,
  });
}

/**
 * Best-effort server-side revoke of this instance's key on unlink.
 *
 * NOTE: the cloud's authoritative revoke (`POST /api/instances/revoke`) is
 * session-guarded — the human revokes an instance from their account registry —
 * so an instance holding only its API key cannot self-revoke there today. This
 * call is therefore genuinely best-effort (and forward-compatible): it swallows
 * every failure and the caller's local token clear is what actually unlinks this
 * instance. Never throws.
 *
 * @param opts - Base URL, the Bearer access token, and an optional `fetchImpl`.
 * @returns `true` only if the cloud acknowledged the revoke.
 */
export async function revokeInstanceKey(opts: {
  baseUrl: string;
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  try {
    const res = await fetchImpl(`${opts.baseUrl}/api/instances/revoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.accessToken}`,
      },
      body: JSON.stringify({}),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Read exact immutable hosted event definitions through the existing linked-instance client. */
export function requestManagedConnectorEventDefinitions(opts: {
  baseUrl: string;
  accessToken: string;
  request: Omit<ConnectorEventPageRequest, 'signal'>;
  signal: AbortSignal;
  fetchImpl?: FetchLike;
}) {
  const query = managedQuery({
    toolkitVersion: opts.request.toolkitVersion,
    cursor: opts.request.cursor,
    limit: opts.request.limit,
  });
  return requestManagedConnectorResource({
    ...opts,
    kind: 'event_definitions',
    path: `/api/instances/connectors/toolkits/${encodeURIComponent(opts.request.toolkit)}/events?${query}`,
    schema: ManagedConnectorEventDefinitionPageSchema,
  });
}

/** Pull protected hosted events for durable local acceptance, without requiring a live provider. */
export function requestManagedConnectorEventPull(opts: {
  baseUrl: string;
  accessToken: string;
  limit: number;
  signal: AbortSignal;
  fetchImpl?: FetchLike;
}) {
  return requestManagedConnectorResource({
    ...opts,
    kind: 'event_pull',
    path: '/api/instances/connectors/events/pull',
    method: 'POST',
    body: ManagedConnectorEventPullRequestSchema.parse({ limit: opts.limit }),
    schema: ManagedConnectorEventPullResponseSchema,
  });
}

/** Acknowledge only exact lease receipts after the local database commit. */
export function requestManagedConnectorEventAck(opts: {
  baseUrl: string;
  accessToken: string;
  events: Array<{ id: string; leaseToken: string }>;
  signal: AbortSignal;
  fetchImpl?: FetchLike;
}) {
  return requestManagedConnectorResource({
    ...opts,
    kind: 'event_ack',
    path: '/api/instances/connectors/events/ack',
    method: 'POST',
    body: ManagedConnectorEventAckRequestSchema.parse({ events: opts.events }),
    schema: ManagedConnectorEventAckResponseSchema,
  });
}
