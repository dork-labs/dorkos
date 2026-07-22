/**
 * The Nango HTTP seam — the injectable boundary between
 * {@link ./nango.js | NangoConnectorProvider} and a self-hosted Nango server's
 * REST API (spec §Detailed Design 1/4, spike §1.3).
 *
 * The provider depends only on the narrow {@link NangoHttpClient} interface,
 * expressed in Nango-flavored domain shapes (an `integration` config key, a
 * random-UUID `connectionId`, an `ACTIVE`/`PENDING` status). The default
 * {@link FetchNangoHttpClient} maps those operations onto Nango's REST API with
 * the secret key as a bearer token. Tests inject a fake client, so the
 * provider's behavior (id mapping, connect flow, degrade matrix) is verified
 * hermetically with no network.
 *
 * **Free Auth+Proxy only — never Enterprise MCP (spike §1.3).** Free self-hosted
 * Nango (docker-compose) gives OAuth (Auth) and a credentialed HTTP proxy, and
 * nothing else — functions, syncs, webhooks, AND Nango's own MCP server are all
 * Enterprise-gated. This client therefore wraps ONLY the Auth surface (connect,
 * connections, delete). It deliberately exposes no MCP-session operation:
 * {@link NangoConnectorProvider} reports `exposesOverMcp: false` and returns no
 * tool server, so nothing here can accidentally depend on Nango's paid MCP.
 *
 * **Unverified against live Nango.** The concrete REST endpoints, request
 * bodies, and response fields in {@link FetchNangoHttpClient} are shaped from
 * Nango's self-host documentation (`research/20260718_connector-gateway-spike.md`
 * §1.3) but have NOT been exercised against a live server — DorkOS CI runs this
 * provider against the fake client. Every such assumption is marked
 * `ASSUMPTION (live-unverified)` inline. Because this seam is injectable, live
 * verification is a config change (swap the client), never a provider refactor.
 *
 * @module services/connectors/providers/nango-client
 */

/** Per-request deadline so a hung Nango call can never block an aggregation. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A connectable Nango integration (a configured provider), reduced to what the
 * connect picker needs. `authMode` echoes Nango's per-integration auth config.
 */
export interface NangoIntegration {
  /** Nango's `unique_key` (provider config key) — the integration/toolkit slug, e.g. `'gmail'`. */
  uniqueKey: string;
  /** The underlying Nango provider template, e.g. `'google-mail'`. */
  provider: string;
  /** Human-facing name shown in the connect picker, when Nango carries one. */
  displayName?: string;
  /** Nango auth mode, e.g. `'OAUTH2'` | `'API_KEY'` | `'NONE'`. */
  authMode?: string;
}

/** The reference-not-secret result of initiating a Nango connect flow. */
export interface NangoConnectionRequest {
  /** Opaque Nango connect-session/request id, polled to completion. */
  connectionRequestId: string;
  /** Nango Connect UI URL to open (the vendor sign-in surface). */
  authorizeUrl: string;
}

/**
 * Nango connection lifecycle status. `PENDING` while the user is still
 * completing consent; `ACTIVE` once the stored credentials are usable;
 * `EXPIRED`/`ERROR` are the unusable states (a failed refresh, a revoked grant).
 */
export type NangoConnectionStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'ERROR';

/** One Nango connection, keyed by its random-UUID `connectionId`. */
export interface NangoConnection {
  /** Nango `connectionId` (random UUID) — the raw vendor handle for one account. */
  connectionId: string;
  /** Integration (provider config key) this connection belongs to, e.g. `'gmail'`. */
  integration: string;
  /**
   * Human-readable label, read from a Nango tag/metadata slot (Nango has no
   * first-class end-user object — arbitrary tags disambiguate connections).
   */
  label?: string;
  /** Nango connection status. */
  status: NangoConnectionStatus;
}

/** The pollable state of a Nango connect request. */
export interface NangoConnectionState {
  /** The request/connection status; `PENDING` means consent is still in flight. */
  status: NangoConnectionStatus;
  /** The connection, present once the request reaches `ACTIVE`. */
  connection?: NangoConnection;
  /** Failure detail, present on an `ERROR` request. */
  error?: string;
}

/**
 * The narrow Nango operations the provider needs — the Auth surface only. The
 * single seam a live verification swaps; the provider is written entirely
 * against this interface. Note the absence of any MCP-session method: Nango's
 * MCP server is Enterprise-gated, so tool exposure is out of this seam by design.
 */
export interface NangoHttpClient {
  /** List the integrations (configured providers) this Nango server exposes. */
  listIntegrations(): Promise<NangoIntegration[]>;
  /**
   * Begin connecting `integration`, carrying `label` as a Nango tag.
   *
   * @param input - The integration slug and optional connection label.
   */
  initiateConnection(input: {
    integration: string;
    label?: string;
  }): Promise<NangoConnectionRequest>;
  /**
   * Poll a connect request to its current state.
   *
   * @param connectionRequestId - The id from {@link initiateConnection}.
   */
  getConnectionState(connectionRequestId: string): Promise<NangoConnectionState>;
  /**
   * List the connections, optionally filtered to one integration.
   *
   * @param opts - Optional `integration` filter.
   */
  listConnections(opts?: { integration?: string }): Promise<NangoConnection[]>;
  /**
   * Delete (revoke) a connection. Idempotent — deleting an unknown/already-
   * deleted id resolves without throwing.
   *
   * @param connectionId - The raw `connectionId` to revoke.
   */
  deleteConnection(connectionId: string): Promise<void>;
}

/** Construction options for {@link FetchNangoHttpClient}. */
export interface FetchNangoHttpClientOpts {
  /** The Nango secret key (resolved from the credential store; never logged). */
  secretKey: string;
  /** The self-hosted Nango base URL DorkOS points at, e.g. `http://localhost:3003`. */
  baseUrl: string;
  /** The Nango Connect UI origin (defaults to Nango's hosted connect surface). */
  connectUrl?: string;
  /** Injectable `fetch` (tests never need this — they inject a fake client). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 10s). */
  timeoutMs?: number;
}

/** A Nango API error carrying the HTTP status for honest surfacing. */
export class NangoApiError extends Error {
  /** The HTTP status Nango returned. */
  readonly status: number;
  /**
   * Construct an error carrying the failing HTTP status.
   *
   * @param status - The HTTP status code.
   * @param message - A secret-free error message.
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = 'NangoApiError';
    this.status = status;
  }
}

/** Nango's hosted Connect UI origin. `ASSUMPTION (live-unverified)`. */
const DEFAULT_NANGO_CONNECT_URL = 'https://connect.nango.dev';

/**
 * Default {@link NangoHttpClient} over a self-hosted Nango's REST API. The
 * secret key rides every request as a bearer token and is never logged. Every
 * endpoint path and response field is a live-unverified assumption (see the
 * module doc); the shapes match Nango's self-host documentation and are isolated
 * here so a live verification never touches the provider.
 */
export class FetchNangoHttpClient implements NangoHttpClient {
  private readonly _secretKey: string;
  private readonly _baseUrl: string;
  private readonly _connectUrl: string;
  private readonly _fetch: typeof fetch;
  private readonly _timeoutMs: number;

  /**
   * Construct the client from the resolved secret key and self-host base URL.
   *
   * @param opts - Secret key, base URL, and optional connect-origin/fetch/timeout overrides.
   */
  constructor(opts: FetchNangoHttpClientOpts) {
    this._secretKey = opts.secretKey;
    this._baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this._connectUrl = (opts.connectUrl ?? DEFAULT_NANGO_CONNECT_URL).replace(/\/+$/, '');
    this._fetch = opts.fetchImpl ?? fetch;
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async listIntegrations(): Promise<NangoIntegration[]> {
    // ASSUMPTION (live-unverified): GET /integrations → { data: [...] }.
    const body = await this._request<{ data?: RawIntegration[] }>('GET', '/integrations');
    return (body.data ?? []).map((it) => ({
      uniqueKey: it.unique_key,
      provider: it.provider ?? it.unique_key,
      ...(it.display_name && { displayName: it.display_name }),
      ...(it.auth_mode && { authMode: it.auth_mode }),
    }));
  }

  async initiateConnection(input: {
    integration: string;
    label?: string;
  }): Promise<NangoConnectionRequest> {
    // ASSUMPTION (live-unverified): POST /connect/sessions with the allowed
    // integration + an end-user tag → { data: { token } }; the Connect UI opens
    // with that session token.
    const body = await this._request<RawConnectSession>('POST', '/connect/sessions', {
      allowed_integrations: [input.integration],
      ...(input.label && { end_user: { id: input.label, display_name: input.label } }),
    });
    const token = body.data?.token ?? body.token ?? '';
    return {
      connectionRequestId: token,
      authorizeUrl: token
        ? `${this._connectUrl}?connect_session_token=${encodeURIComponent(token)}`
        : '',
    };
  }

  async getConnectionState(connectionRequestId: string): Promise<NangoConnectionState> {
    // ASSUMPTION (live-unverified): GET /connect/sessions/{token} →
    // { status, connection: { connection_id, provider_config_key, ... } }.
    const body = await this._request<RawConnectSessionState>(
      'GET',
      `/connect/sessions/${encodeURIComponent(connectionRequestId)}`
    );
    const status = normalizeStatus(body.status);
    if (status === 'ACTIVE' && body.connection) {
      return { status, connection: toDomainConnection(body.connection) };
    }
    if (status === 'ERROR') {
      return { status, ...(body.error && { error: body.error }) };
    }
    return { status };
  }

  async listConnections(opts?: { integration?: string }): Promise<NangoConnection[]> {
    // ASSUMPTION (live-unverified): GET /connections?provider_config_key → { connections: [...] }.
    const query = new URLSearchParams();
    if (opts?.integration) query.set('provider_config_key', opts.integration);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const body = await this._request<{ connections?: RawConnection[] }>(
      'GET',
      `/connections${suffix}`
    );
    return (body.connections ?? []).map(toDomainConnection);
  }

  async deleteConnection(connectionId: string): Promise<void> {
    // ASSUMPTION (live-unverified): DELETE /connections/{connectionId}. A 404 is
    // idempotent success — the connection is already gone.
    try {
      await this._request('DELETE', `/connections/${encodeURIComponent(connectionId)}`);
    } catch (err) {
      if (err instanceof NangoApiError && err.status === 404) return;
      throw err;
    }
  }

  /**
   * Issue one authenticated Nango request, bounded by the timeout, mapping a
   * non-2xx to a {@link NangoApiError}. The secret key and any response body are
   * never logged.
   *
   * @param method - HTTP method.
   * @param path - API path (may include a query string).
   * @param json - Optional JSON request body.
   */
  private async _request<T>(method: string, path: string, json?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      const response = await this._fetch(`${this._baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this._secretKey}`,
          ...(json !== undefined && { 'content-type': 'application/json' }),
        },
        ...(json !== undefined && { body: JSON.stringify(json) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new NangoApiError(response.status, `Nango request failed (${response.status}).`);
      }
      // A 204/empty body resolves to an empty object.
      const text = await response.text();
      return text ? (JSON.parse(text) as T) : ({} as T);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Raw Nango integration JSON (snake_case, partial). */
interface RawIntegration {
  unique_key: string;
  provider?: string;
  display_name?: string;
  auth_mode?: string;
}

/** Raw Nango connect-session JSON. */
interface RawConnectSession {
  data?: { token?: string };
  token?: string;
}

/** Raw Nango connect-session state JSON. */
interface RawConnectSessionState {
  status?: string;
  connection?: RawConnection;
  error?: string;
}

/** Raw Nango connection JSON (snake_case, partial). */
interface RawConnection {
  connection_id: string;
  provider_config_key?: string;
  end_user?: { display_name?: string; id?: string };
  metadata?: { label?: string };
  status?: string;
}

/** Coerce Nango's status string to a known {@link NangoConnectionStatus}. */
function normalizeStatus(raw: string | undefined): NangoConnectionStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'ACTIVE':
    case 'OK':
      return 'ACTIVE';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'ERROR':
    case 'FAILED':
      return 'ERROR';
    default:
      // Anything else (PENDING, unknown) is still in-flight.
      return 'PENDING';
  }
}

/** Map a raw connection JSON to the client's domain shape. */
function toDomainConnection(raw: RawConnection): NangoConnection {
  const label = raw.metadata?.label ?? raw.end_user?.display_name ?? raw.end_user?.id;
  return {
    connectionId: raw.connection_id,
    integration: raw.provider_config_key ?? '',
    ...(label && { label }),
    status: normalizeStatus(raw.status),
  };
}
