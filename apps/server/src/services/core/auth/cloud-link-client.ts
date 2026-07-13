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
import { hostname } from 'node:os';
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
  | { status: 'approved'; accessToken: string }
  | { status: 'denied' }
  | { status: 'expired' };

/** Outcome of a single heartbeat call. `unauthorized` is the unlink signal. */
export type HeartbeatResult =
  | { ok: true; instanceId: string; lastSeenAt: string; accountLabel: string | null }
  | { ok: false; unauthorized: true }
  | { ok: false; unauthorized: false; error: string };

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
      }),
    }),
  });
  if (!res.ok) {
    throw new Error(`Device code request failed (HTTP ${res.status})`);
  }
  return (await res.json()) as DeviceCodeResponse;
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
    await sleep(intervalSeconds * 1000);
    if (opts.signal?.aborted) return { status: 'expired' };
    if (now() >= deadline) return { status: 'expired' };

    const res = await fetchImpl(`${opts.baseUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: opts.deviceCode,
        client_id: INSTANCE_CLIENT_ID,
      }),
    });

    if (res.ok) {
      const body = (await res.json()) as { access_token?: string };
      if (!body.access_token)
        throw new Error('Cloud approved the link but returned no access token');
      return { status: 'approved', accessToken: body.access_token };
    }

    if (res.status === 400) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
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
 *   and an optional `fetchImpl`.
 * @returns The heartbeat outcome; never throws for HTTP-level failures.
 */
export async function sendHeartbeat(opts: {
  baseUrl: string;
  accessToken: string;
  descriptor: InstanceDescriptor;
  fetchImpl?: FetchLike;
}): Promise<HeartbeatResult> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl}/api/instances/heartbeat`, {
      method: 'POST',
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
