/**
 * The Composio HTTP seam — the injectable boundary between
 * {@link ./composio.js | ComposioConnectorProvider} and Composio's cloud API.
 *
 * The provider depends only on the narrow {@link ComposioHttpClient} interface,
 * expressed in Composio-flavored domain shapes (a `ca_…` connected-account id, an
 * `ACTIVE`/`INITIATED` status, a Rube MCP session url). The default
 * {@link FetchComposioHttpClient} maps those operations onto Composio's v3 REST
 * API with the API key on every request. Tests inject a fake client, so the
 * provider's behavior (id mapping, connect flow, the null branch, the Rube
 * connection shape) is verified hermetically with no network.
 *
 * **Unverified against live Composio.** The concrete REST endpoints, request
 * bodies, and response fields in {@link FetchComposioHttpClient} are shaped from
 * Composio's v3 documentation (`research/20260718_connector-gateway-spike.md`
 * §1.3) but have NOT been exercised against a live account — DorkOS CI runs this
 * provider against the fake client. Every such assumption is marked
 * `ASSUMPTION (live-unverified)` inline. Because this seam is injectable, live
 * verification is a config change (swap the client), never a provider refactor.
 *
 * @module services/connectors/providers/composio-client
 */

/** Composio's default v3 API origin. `ASSUMPTION (live-unverified)`. */
const DEFAULT_COMPOSIO_BASE_URL = 'https://backend.composio.dev';

/** Per-request deadline so a hung Composio call can never block an aggregation. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A connectable Composio toolkit (service), reduced to what the connect picker
 * needs. `authScheme`/`maxAccountsPerToolkit` echo Composio's per-toolkit auth
 * config.
 */
export interface ComposioToolkitInfo {
  /** Stable Composio toolkit slug, e.g. `'gmail'`. */
  slug: string;
  /** Human-facing toolkit name, e.g. `'Gmail'`. */
  name: string;
  /** Composio auth scheme, e.g. `'OAUTH2'` | `'API_KEY'` | `'NO_AUTH'`. */
  authScheme?: string;
  /** Composio's `max_accounts_per_toolkit`, when the toolkit caps it. */
  maxAccountsPerToolkit?: number;
}

/** The reference-not-secret result of initiating a Composio connect flow. */
export interface ComposioConnectionRequest {
  /** Composio connection-request id, polled to completion. */
  connectionRequestId: string;
  /** Vendor consent URL to open (Google/Slack/… sign-in). */
  redirectUrl: string;
}

/**
 * Composio connected-account lifecycle status (v3 SDK). `INITIATED` while the
 * user is still completing consent; `ACTIVE` once usable; `EXPIRED`/`INACTIVE`/
 * `FAILED` are the unusable terminal states.
 */
export type ComposioAccountStatus = 'INITIATED' | 'ACTIVE' | 'EXPIRED' | 'INACTIVE' | 'FAILED';

/** One Composio connected account, keyed by its `ca_…` id. */
export interface ComposioConnectedAccount {
  /** Composio connected-account id (`ca_…` nanoid) — the raw vendor handle. */
  connectedAccountId: string;
  /** Toolkit slug this account belongs to, e.g. `'gmail'`. */
  toolkit: string;
  /** Human-readable alias set at connect time (the account disambiguator). */
  alias?: string;
  /** Composio lifecycle status. */
  status: ComposioAccountStatus;
}

/** The pollable state of a Composio connection request. */
export interface ComposioConnectionState {
  /** The request/account status; `INITIATED` means consent is still pending. */
  status: ComposioAccountStatus;
  /** The connected account, present once the request reaches `ACTIVE`. */
  account?: ComposioConnectedAccount;
  /** Failure detail, present on a `FAILED` request. */
  error?: string;
}

/**
 * A Rube MCP session for one account — a Tool Router pre-signed url plus any auth
 * headers. `null` from {@link ComposioHttpClient.mcpSessionForAccount} means the
 * account has no live session right now (the surfaced null branch).
 */
export interface ComposioMcpSession {
  /** The Rube MCP endpoint url (per-account/pre-signed, or the shared Rube url). */
  url: string;
  /** Auth headers to send with the MCP connection, when the url is not self-authorizing. */
  headers?: Record<string, string>;
}

/**
 * The narrow Composio operations the provider needs. The single seam a live
 * verification swaps; the provider is written entirely against this interface.
 */
export interface ComposioHttpClient {
  /** List the toolkits (services) this Composio account can connect. */
  listToolkits(): Promise<ComposioToolkitInfo[]>;
  /**
   * Begin connecting `toolkit`, carrying `alias` as the human account label.
   *
   * @param input - The toolkit slug and optional account alias.
   */
  initiateConnection(input: {
    toolkit: string;
    alias?: string;
  }): Promise<ComposioConnectionRequest>;
  /**
   * Poll a connection request to its current state.
   *
   * @param connectionRequestId - The id from {@link initiateConnection}.
   */
  getConnectionState(connectionRequestId: string): Promise<ComposioConnectionState>;
  /**
   * List the connected accounts, optionally filtered to one toolkit.
   *
   * @param opts - Optional `toolkit` filter.
   */
  listConnectedAccounts(opts?: { toolkit?: string }): Promise<ComposioConnectedAccount[]>;
  /**
   * Delete (revoke) a connected account. Idempotent — deleting an unknown/
   * already-deleted id resolves without throwing.
   *
   * @param connectedAccountId - The raw `ca_…` id to revoke.
   */
  deleteConnectedAccount(connectedAccountId: string): Promise<void>;
  /**
   * Mint (or fetch) the Rube MCP session for one account, or `null` when the
   * account has no live session (unusable status, no pre-signed url yet).
   *
   * @param connectedAccountId - The raw `ca_…` id to expose over MCP.
   */
  mcpSessionForAccount(connectedAccountId: string): Promise<ComposioMcpSession | null>;
}

/** Construction options for {@link FetchComposioHttpClient}. */
export interface FetchComposioHttpClientOpts {
  /** The Composio API key (resolved from the credential store; never logged). */
  apiKey: string;
  /**
   * The Composio `user_id` this DorkOS instance scopes accounts under. OQ1
   * (spec §Open Questions): one fixed id per single-operator instance suffices;
   * per-user scoping is post-launch.
   */
  userId: string;
  /** Override the API origin (defaults to Composio's cloud). */
  baseUrl?: string;
  /** Injectable `fetch` (tests never need this — they inject a fake client). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 10s). */
  timeoutMs?: number;
}

/** A Composio API error carrying the HTTP status for honest surfacing. */
export class ComposioApiError extends Error {
  /** The HTTP status Composio returned. */
  readonly status: number;
  /**
   * Construct an error carrying the failing HTTP status.
   *
   * @param status - The HTTP status code.
   * @param message - A secret-free error message.
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ComposioApiError';
    this.status = status;
  }
}

/**
 * Default {@link ComposioHttpClient} over Composio's v3 REST API. The API key is
 * sent on every request as `x-api-key` and is never logged. Every endpoint path
 * and response field is a live-unverified assumption (see the module doc); the
 * shapes match Composio's v3 documentation and are isolated here so a live
 * verification never touches the provider.
 */
export class FetchComposioHttpClient implements ComposioHttpClient {
  private readonly _apiKey: string;
  private readonly _userId: string;
  private readonly _baseUrl: string;
  private readonly _fetch: typeof fetch;
  private readonly _timeoutMs: number;

  /**
   * Construct the client from the resolved API key and instance scope.
   *
   * @param opts - API key, `user_id`, and optional origin/fetch/timeout overrides.
   */
  constructor(opts: FetchComposioHttpClientOpts) {
    this._apiKey = opts.apiKey;
    this._userId = opts.userId;
    this._baseUrl = (opts.baseUrl ?? DEFAULT_COMPOSIO_BASE_URL).replace(/\/+$/, '');
    this._fetch = opts.fetchImpl ?? fetch;
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async listToolkits(): Promise<ComposioToolkitInfo[]> {
    // ASSUMPTION (live-unverified): GET /api/v3/toolkits → { items: [...] }.
    const body = await this._request<{ items?: RawToolkit[] }>('GET', '/api/v3/toolkits');
    return (body.items ?? []).map((tk) => ({
      slug: tk.slug,
      name: tk.name ?? tk.slug,
      ...(tk.auth_scheme && { authScheme: tk.auth_scheme }),
      ...(typeof tk.max_accounts_per_toolkit === 'number' && {
        maxAccountsPerToolkit: tk.max_accounts_per_toolkit,
      }),
    }));
  }

  async initiateConnection(input: {
    toolkit: string;
    alias?: string;
  }): Promise<ComposioConnectionRequest> {
    // ASSUMPTION (live-unverified): POST /api/v3/connected_accounts with the
    // user_id + toolkit + alias → { connectionRequest: { id, redirectUrl } }.
    const body = await this._request<RawConnectionRequest>('POST', '/api/v3/connected_accounts', {
      user_id: this._userId,
      toolkit: input.toolkit,
      ...(input.alias && { alias: input.alias }),
    });
    const request = body.connectionRequest ?? body;
    return {
      connectionRequestId: request.id,
      redirectUrl: request.redirectUrl ?? request.redirect_url ?? '',
    };
  }

  async getConnectionState(connectionRequestId: string): Promise<ComposioConnectionState> {
    // ASSUMPTION (live-unverified): GET /api/v3/connected_accounts/{id} →
    // { id, status, toolkit, alias }.
    const body = await this._request<RawConnectedAccount>(
      'GET',
      `/api/v3/connected_accounts/${encodeURIComponent(connectionRequestId)}`
    );
    const status = normalizeStatus(body.status);
    if (status === 'ACTIVE') {
      return { status, account: toDomainAccount(body) };
    }
    if (status === 'FAILED') {
      return { status, ...(body.error && { error: body.error }) };
    }
    return { status };
  }

  async listConnectedAccounts(opts?: { toolkit?: string }): Promise<ComposioConnectedAccount[]> {
    // ASSUMPTION (live-unverified): GET /api/v3/connected_accounts?user_id&toolkit
    // → { items: [...] }.
    const query = new URLSearchParams({ user_id: this._userId });
    if (opts?.toolkit) query.set('toolkit', opts.toolkit);
    const body = await this._request<{ items?: RawConnectedAccount[] }>(
      'GET',
      `/api/v3/connected_accounts?${query.toString()}`
    );
    return (body.items ?? []).map(toDomainAccount);
  }

  async deleteConnectedAccount(connectedAccountId: string): Promise<void> {
    // ASSUMPTION (live-unverified): DELETE /api/v3/connected_accounts/{ca_id}.
    // A 404 is idempotent success — the account is already gone.
    try {
      await this._request(
        'DELETE',
        `/api/v3/connected_accounts/${encodeURIComponent(connectedAccountId)}`
      );
    } catch (err) {
      if (err instanceof ComposioApiError && err.status === 404) return;
      throw err;
    }
  }

  async mcpSessionForAccount(connectedAccountId: string): Promise<ComposioMcpSession | null> {
    // ASSUMPTION (live-unverified): Tool Router mints a per-account MCP session
    // url via POST /api/v3/mcp/sessions → { url }. When Composio has no live url
    // for the account, this resolves null (the surfaced null branch), never a
    // throw. The Rube endpoint (rube.app/mcp) is the shared fallback surface.
    try {
      const body = await this._request<{ url?: string; mcp_url?: string }>(
        'POST',
        '/api/v3/mcp/sessions',
        { user_id: this._userId, connected_account_id: connectedAccountId }
      );
      const url = body.url ?? body.mcp_url;
      if (!url) return null;
      // The session url is pre-signed per user/account; the API key rides as a
      // header for hosts that require it. ASSUMPTION (live-unverified): header shape.
      return { url, headers: { 'x-api-key': this._apiKey } };
    } catch (err) {
      // A 404 (no session for this account) degrades to null, not an error.
      if (err instanceof ComposioApiError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Issue one authenticated Composio request, bounded by the timeout, mapping a
   * non-2xx to a {@link ComposioApiError}. The API key and any response body are
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
          'x-api-key': this._apiKey,
          ...(json !== undefined && { 'content-type': 'application/json' }),
        },
        ...(json !== undefined && { body: JSON.stringify(json) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ComposioApiError(
          response.status,
          `Composio request failed (${response.status}).`
        );
      }
      // A 204/empty body resolves to an empty object.
      const text = await response.text();
      return text ? (JSON.parse(text) as T) : ({} as T);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Raw Composio toolkit JSON (snake_case, partial). */
interface RawToolkit {
  slug: string;
  name?: string;
  auth_scheme?: string;
  max_accounts_per_toolkit?: number;
}

/** Raw Composio connection-request JSON. */
interface RawConnectionRequest {
  connectionRequest?: { id: string; redirectUrl?: string; redirect_url?: string };
  id: string;
  redirectUrl?: string;
  redirect_url?: string;
}

/** Raw Composio connected-account JSON (snake_case, partial). */
interface RawConnectedAccount {
  id: string;
  toolkit?: string | { slug?: string };
  alias?: string;
  status?: string;
  error?: string;
}

/** Coerce Composio's status string to a known {@link ComposioAccountStatus}. */
function normalizeStatus(raw: string | undefined): ComposioAccountStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'ACTIVE':
      return 'ACTIVE';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'INACTIVE':
      return 'INACTIVE';
    case 'FAILED':
      return 'FAILED';
    default:
      // Anything else (INITIATED, PENDING, unknown) is still in-flight.
      return 'INITIATED';
  }
}

/** Map a raw connected-account JSON to the client's domain shape. */
function toDomainAccount(raw: RawConnectedAccount): ComposioConnectedAccount {
  const toolkit = typeof raw.toolkit === 'string' ? raw.toolkit : (raw.toolkit?.slug ?? '');
  return {
    connectedAccountId: raw.id,
    toolkit,
    ...(raw.alias && { alias: raw.alias }),
    status: normalizeStatus(raw.status),
  };
}
