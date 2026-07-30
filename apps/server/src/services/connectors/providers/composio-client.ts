/**
 * The Composio HTTP seam — the injectable boundary between
 * {@link ./composio.js | ComposioConnectorProvider} and Composio's cloud API.
 *
 * The provider depends only on the narrow {@link ComposioHttpClient} interface,
 * expressed in Composio-flavored domain shapes (a nanoid connected-account id,
 * an `ACTIVE`/`INITIALIZING` status, a Tool Router MCP url). The default
 * {@link FetchComposioHttpClient} maps those operations onto Composio's v3.1
 * REST API with the API key on every request. Tests inject a fake client, so
 * the provider's behavior (id mapping, connect flow, the null branch, the MCP
 * connection shape) is verified hermetically with no network.
 *
 * **Verification status (first real API contact, DOR-703 follow-up).** The
 * endpoint paths, request bodies, and response envelopes below were re-derived
 * from Composio's current public API reference (docs.composio.dev, read
 * 2026-07-29) after the original spike-derived assumptions failed against a
 * real account. Each shape is marked inline:
 *
 * - `VERIFIED-LIVE (2026-07-29 / 2026-07-30)` — exercised against the real
 *   API. That covers the error envelope
 *   (`{ error: { message, status, suggested_fix } }`) and the TWO auth header
 *   kinds: a project key authenticates via `x-api-key`, while a `uak_…`
 *   user-account key (what the `composio` CLI holds) authenticates via
 *   `x-user-api-key` (200 on `/api/v3.1/toolkits`; the same key under
 *   `x-api-key` is 401 `APIKey_InvalidAPIKey`) with its project resolved via
 *   `GET /api/v3/auth/session/info` and carried as `x-project-id`.
 * - `VERIFIED-DOCS (2026-07-29)` — matches the published reference verbatim
 *   but was exercised only with a user-account key.
 *
 * A failing call now surfaces as a thrown {@link ComposioApiError} carrying
 * Composio's own (secret-free) error message — never silently degraded — so
 * the registry aggregation can turn it into an honest per-provider warning.
 *
 * @module services/connectors/providers/composio-client
 */

import type { ConnectorKeyKind } from '@dorkos/shared/connector-provider';

/** Composio's API origin. `VERIFIED-LIVE (2026-07-29)`. */
const DEFAULT_COMPOSIO_BASE_URL = 'https://backend.composio.dev';

/**
 * Prefix of Composio user-account keys — the kind the `composio` CLI holds.
 * `VERIFIED-LIVE (2026-07-30)`: a `uak_…` key authenticates via
 * `x-user-api-key` (200 on `/api/v3.1/toolkits`), while the same key via
 * `x-api-key` is rejected with 401 `APIKey_InvalidAPIKey`.
 */
const USER_KEY_PREFIX = 'uak_';

/**
 * Resolves a user-account key's project. `VERIFIED-LIVE (2026-07-30)`:
 * `GET /api/v3/auth/session/info` with `x-user-api-key` → 200 with
 * `{ project: { nano_id: 'pr_…' } }`, and `x-project-id: pr_…` is accepted on
 * v3.1 calls to scope them to that project.
 */
const SESSION_INFO_PATH = '/api/v3/auth/session/info';

/** The header each key kind authenticates with. `VERIFIED-LIVE (2026-07-30)`. */
type ComposioAuthHeaderKind = 'project' | 'user';

/** Per-request deadline so a hung Composio call can never block an aggregation. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Page size requested when listing toolkits. */
const TOOLKIT_PAGE_LIMIT = 100;

/**
 * Upper bound on toolkit pages followed per `listToolkits` call. Composio hosts
 * 800+ toolkits; the bound keeps one listing from issuing an unbounded request
 * chain if the cursor ever fails to terminate.
 */
const MAX_TOOLKIT_PAGES = 20;

/**
 * A connectable Composio toolkit (service), reduced to what the connect picker
 * needs. `authScheme` echoes Composio's primary per-toolkit auth scheme.
 */
export interface ComposioToolkitInfo {
  /** Stable Composio toolkit slug, e.g. `'gmail'`. */
  slug: string;
  /** Human-facing toolkit name, e.g. `'Gmail'`. */
  name: string;
  /** Composio auth scheme, e.g. `'OAUTH2'` | `'API_KEY'` | `'NO_AUTH'`. */
  authScheme?: string;
}

/** The reference-not-secret result of initiating a Composio connect flow. */
export interface ComposioConnectionRequest {
  /** Composio connected-account nanoid, polled to completion. */
  connectionRequestId: string;
  /** Vendor consent URL to open (Google/Slack/… sign-in). */
  redirectUrl: string;
}

/**
 * Composio connected-account lifecycle status (v3.1). `INITIALIZING`/
 * `INITIATED` while the user is still completing consent; `ACTIVE` once usable;
 * `EXPIRED`/`INACTIVE`/`FAILED` are the unusable terminal states.
 */
export type ComposioAccountStatus = 'INITIATED' | 'ACTIVE' | 'EXPIRED' | 'INACTIVE' | 'FAILED';

/** One Composio connected account, keyed by its nanoid. */
export interface ComposioConnectedAccount {
  /** Composio connected-account nanoid — the raw vendor handle. */
  connectedAccountId: string;
  /** Toolkit slug this account belongs to, e.g. `'gmail'`. */
  toolkit: string;
  /** Human-readable alias set at connect time (the account disambiguator). */
  alias?: string;
  /** Composio lifecycle status (normalized; `INITIATED` covers `INITIALIZING`). */
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
 * A Tool Router MCP session for one account — the session's MCP url plus any
 * auth headers. `null` from {@link ComposioHttpClient.mcpSessionForAccount}
 * means the account has no live session right now (the surfaced null branch).
 */
export interface ComposioMcpSession {
  /** The Tool Router MCP endpoint url for the session. */
  url: string;
  /** Auth headers to send with the MCP connection, when the url is not self-authorizing. */
  headers?: Record<string, string>;
}

/**
 * The narrow Composio operations the provider needs. The single seam a live
 * verification swaps; the provider is written entirely against this interface.
 */
export interface ComposioHttpClient {
  /**
   * Which credential kind the key validated as, when the client tracks it —
   * `'unknown'` until a real call has succeeded. Surfaced on the provider
   * status so the setup card can say what it is using.
   */
  keyKind?(): ConnectorKeyKind;
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
   * @param connectedAccountId - The raw nanoid to revoke.
   */
  deleteConnectedAccount(connectedAccountId: string): Promise<void>;
  /**
   * Mint (or fetch) the Tool Router MCP session for one account, or `null` when
   * the account has no live session (unusable status, no url minted).
   *
   * @param connectedAccountId - The raw nanoid to expose over MCP.
   */
  mcpSessionForAccount(connectedAccountId: string): Promise<ComposioMcpSession | null>;
}

/** Construction options for {@link FetchComposioHttpClient}. */
export interface FetchComposioHttpClientOpts {
  /**
   * The Composio API key (resolved from the credential store; never logged).
   * EITHER kind works (`VERIFIED-LIVE 2026-07-30`): a project API key rides
   * `x-api-key`; a `uak_…` user-account key (the `composio` CLI's kind) rides
   * `x-user-api-key` with its project resolved via session-info. The client
   * detects the kind by prefix and falls back to the other header once on a
   * 401, so unknown future prefixes still find their header.
   */
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
 * Default {@link ComposioHttpClient} over Composio's v3.1 REST API. Composio
 * issues TWO key kinds with different auth headers (`VERIFIED-LIVE
 * 2026-07-30`): project keys → `x-api-key`; user-account keys (`uak_…`, what
 * the `composio` CLI holds) → `x-user-api-key` plus `x-project-id` resolved
 * once via session-info. The kind is guessed by prefix and, on a 401 before
 * the key has ever validated, retried once with the other header — the honest
 * catch-all for prefixes we have not seen (e.g. org keys). The key is never
 * logged. See the module doc for the per-shape verification status.
 */
export class FetchComposioHttpClient implements ComposioHttpClient {
  private readonly _apiKey: string;
  private readonly _userId: string;
  private readonly _baseUrl: string;
  private readonly _fetch: typeof fetch;
  private readonly _timeoutMs: number;
  /** The auth header currently in use (prefix-guessed until validated). */
  private _headerKind: ComposioAuthHeaderKind;
  /** True once any call has succeeded — locks the header kind for the instance. */
  private _validated = false;
  /** The `pr_…` project id resolved for a user-account key (not a secret). */
  private _projectId: string | undefined;
  /** Re-entrancy guard: the session-info call must not resolve itself. */
  private _resolvingProjectId = false;
  /**
   * toolkit slug → managed auth-config id, resolved once per process. Auth
   * configs are stable per project+toolkit, so re-resolving on every connect
   * would only add latency and rate-limit pressure.
   */
  private readonly _authConfigIds = new Map<string, string>();

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
    this._headerKind = opts.apiKey.startsWith(USER_KEY_PREFIX) ? 'user' : 'project';
  }

  keyKind(): ConnectorKeyKind {
    // 'unknown' until a real call validates — a prefix guess is not knowledge.
    return this._validated ? this._headerKind : 'unknown';
  }

  async listToolkits(): Promise<ComposioToolkitInfo[]> {
    // VERIFIED-DOCS (2026-07-29): GET /api/v3.1/toolkits →
    // { items: [{ slug, name, auth_schemes?: string[], no_auth?: boolean }],
    //   next_cursor } — `auth_schemes` is an ARRAY and there is no
    // max-accounts field (both wrong in the original spike-derived shape).
    // Composio hosts 800+ toolkits, so the listing paginates by cursor.
    const toolkits: ComposioToolkitInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOLKIT_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(TOOLKIT_PAGE_LIMIT) });
      if (cursor) query.set('cursor', cursor);
      const body = await this._request<{ items?: RawToolkit[]; next_cursor?: string | null }>(
        'GET',
        `/api/v3.1/toolkits?${query.toString()}`
      );
      for (const tk of body.items ?? []) {
        const authScheme = tk.no_auth ? 'NO_AUTH' : tk.auth_schemes?.[0];
        toolkits.push({
          slug: tk.slug,
          name: tk.name ?? tk.slug,
          ...(authScheme && { authScheme }),
        });
      }
      if (!body.next_cursor) break;
      cursor = body.next_cursor;
    }
    return toolkits;
  }

  async initiateConnection(input: {
    toolkit: string;
    alias?: string;
  }): Promise<ComposioConnectionRequest> {
    // VERIFIED-DOCS (2026-07-29): creating a connected account requires an AUTH
    // CONFIG id, not a toolkit slug (the original assumption sent
    // { user_id, toolkit } — a shape the API never accepted). Resolve or create
    // the Composio-managed auth config for the toolkit first, then:
    // POST /api/v3.1/connected_accounts
    //   { auth_config: { id }, connection: { user_id, alias? } }
    // → { id, status, redirect_url, connectionData: { val: { redirectUrl } } }.
    const authConfigId = await this._authConfigIdFor(input.toolkit);
    const body = await this._request<RawCreatedConnectedAccount>(
      'POST',
      '/api/v3.1/connected_accounts',
      {
        auth_config: { id: authConfigId },
        connection: {
          user_id: this._userId,
          ...(input.alias && { alias: input.alias }),
        },
      }
    );
    return {
      connectionRequestId: body.id,
      redirectUrl: body.redirect_url ?? body.connectionData?.val?.redirectUrl ?? '',
    };
  }

  async getConnectionState(connectionRequestId: string): Promise<ComposioConnectionState> {
    // VERIFIED-DOCS (2026-07-29): GET /api/v3.1/connected_accounts/{nanoid} →
    // { id, status, toolkit: { slug } } — `toolkit` is an OBJECT carrying the
    // slug. `INITIALIZING` is the documented in-flight status.
    const body = await this._request<RawConnectedAccount>(
      'GET',
      `/api/v3.1/connected_accounts/${encodeURIComponent(connectionRequestId)}`
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
    // VERIFIED-DOCS (2026-07-29): GET /api/v3.1/connected_accounts filters by
    // PLURAL params — `user_ids` and `toolkit_slugs` (the original `user_id` /
    // `toolkit` names are not in the reference) → { items: [...] }.
    const query = new URLSearchParams({ user_ids: this._userId });
    if (opts?.toolkit) query.set('toolkit_slugs', opts.toolkit);
    const body = await this._request<{ items?: RawConnectedAccount[] }>(
      'GET',
      `/api/v3.1/connected_accounts?${query.toString()}`
    );
    return (body.items ?? []).map(toDomainAccount);
  }

  async deleteConnectedAccount(connectedAccountId: string): Promise<void> {
    // VERIFIED-DOCS (2026-07-29): DELETE /api/v3.1/connected_accounts/{nanoid}.
    // A 404 is idempotent success — the account is already gone.
    try {
      await this._request(
        'DELETE',
        `/api/v3.1/connected_accounts/${encodeURIComponent(connectedAccountId)}`
      );
    } catch (err) {
      if (err instanceof ComposioApiError && err.status === 404) return;
      throw err;
    }
  }

  async mcpSessionForAccount(connectedAccountId: string): Promise<ComposioMcpSession | null> {
    // VERIFIED-DOCS (2026-07-29): POST /api/v3.1/tool_router/session
    //   { user_id, toolkits: [slug], connected_accounts: { [slug]: [nanoid] } }
    // → { session_id, mcp: { type, url } }. The `connected_accounts` map pins
    // the session to THIS account, which is what makes two Gmail accounts two
    // addressable tool servers. When Composio cannot mint a session for the
    // account (404, or a session with no url), this resolves null — the
    // surfaced null branch, never a throw.
    try {
      const account = await this._request<RawConnectedAccount>(
        'GET',
        `/api/v3.1/connected_accounts/${encodeURIComponent(connectedAccountId)}`
      );
      const toolkit = typeof account.toolkit === 'string' ? account.toolkit : account.toolkit?.slug;
      if (!toolkit || normalizeStatus(account.status) !== 'ACTIVE') return null;

      const session = await this._request<{ mcp?: { url?: string } }>(
        'POST',
        '/api/v3.1/tool_router/session',
        {
          user_id: this._userId,
          toolkits: [toolkit],
          connected_accounts: { [toolkit]: [connectedAccountId] },
        }
      );
      const url = session.mcp?.url;
      if (!url) return null;
      // The session url is minted per user/session; the key rides under
      // whichever header kind validated for this instance. VERIFIED-DOCS:
      // header carriage is the SDK's `session.mcp.headers` behavior.
      return { url, headers: this._authHeaders(this._headerKind) };
    } catch (err) {
      // A 404 (no session for this account) degrades to null, not an error.
      if (err instanceof ComposioApiError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Resolve the Composio-managed auth-config id for a toolkit, creating one on
   * first use and caching per process.
   *
   * VERIFIED-DOCS (2026-07-29):
   * - GET /api/v3.1/auth_configs?toolkit_slug={slug} → { items: [{ id, … }] }
   * - POST /api/v3.1/auth_configs
   *     { toolkit: { slug }, auth_config: { type: 'use_composio_managed_auth' } }
   *   → { auth_config: { id } }
   *
   * @param toolkit - The toolkit slug to resolve an auth config for.
   */
  private async _authConfigIdFor(toolkit: string): Promise<string> {
    const cached = this._authConfigIds.get(toolkit);
    if (cached) return cached;

    const query = new URLSearchParams({ toolkit_slug: toolkit });
    const existing = await this._request<{ items?: RawAuthConfig[] }>(
      'GET',
      `/api/v3.1/auth_configs?${query.toString()}`
    );
    let id = existing.items?.find((config) => !config.is_disabled)?.id ?? existing.items?.[0]?.id;

    if (!id) {
      const created = await this._request<{ auth_config?: { id?: string } }>(
        'POST',
        '/api/v3.1/auth_configs',
        {
          toolkit: { slug: toolkit },
          auth_config: { type: 'use_composio_managed_auth' },
        }
      );
      id = created.auth_config?.id;
    }
    if (!id) {
      throw new ComposioApiError(
        502,
        `Composio returned no auth config id for toolkit '${toolkit}'.`
      );
    }
    this._authConfigIds.set(toolkit, id);
    return id;
  }

  /** The auth headers for one header kind. `VERIFIED-LIVE (2026-07-30)`. */
  private _authHeaders(kind: ComposioAuthHeaderKind): Record<string, string> {
    if (kind === 'user') {
      return {
        'x-user-api-key': this._apiKey,
        // The project id scopes v3.1 calls for a user-account key; it is an
        // identifier (pr_…), not a secret, and is never persisted.
        ...(this._projectId && { 'x-project-id': this._projectId }),
      };
    }
    return { 'x-api-key': this._apiKey };
  }

  /**
   * Resolve (once) the project a user-account key belongs to, so subsequent
   * v3.1 calls carry `x-project-id`. Failure degrades silently: calls without
   * the header still answer against the key's default project
   * (`VERIFIED-LIVE 2026-07-30` — bare `x-user-api-key` returns 200s).
   */
  private async _ensureProjectId(): Promise<void> {
    if (this._headerKind !== 'user' || this._projectId || this._resolvingProjectId) return;
    this._resolvingProjectId = true;
    try {
      const { response, text } = await this._issue('GET', SESSION_INFO_PATH, undefined, 'user');
      if (!response.ok) return;
      const body = JSON.parse(text) as { project?: { nano_id?: string } };
      this._projectId = body.project?.nano_id;
    } catch {
      // Unreachable session-info is not fatal — proceed without the header.
    } finally {
      this._resolvingProjectId = false;
    }
  }

  /**
   * Issue one authenticated Composio request with the retry rung: the header
   * kind is guessed by key prefix, and a 401 BEFORE the key has ever validated
   * retries once with the other header (`VERIFIED-LIVE 2026-07-30`: the same
   * key answers 200 or 401 purely by which header carries it). A success locks
   * the kind; a 401 after validation is a real revocation and fails honestly.
   * Non-2xx maps to a {@link ComposioApiError} carrying Composio's own
   * secret-free message + suggested fix (`VERIFIED-LIVE 2026-07-29`: the error
   * envelope is `{ error: { message, status, suggested_fix } }`, and Composio
   * masks key material itself, e.g. `uak**…`). The key and response bodies are
   * never logged.
   *
   * @param method - HTTP method.
   * @param path - API path (may include a query string).
   * @param json - Optional JSON request body.
   */
  private async _request<T>(method: string, path: string, json?: unknown): Promise<T> {
    await this._ensureProjectId();
    let { response, text } = await this._issue(method, path, json, this._headerKind);

    if (response.status === 401 && !this._validated) {
      const alternate: ComposioAuthHeaderKind = this._headerKind === 'user' ? 'project' : 'user';
      const retry = await this._issue(method, path, json, alternate);
      if (retry.response.ok) {
        this._headerKind = alternate;
        ({ response, text } = retry);
      }
    }

    if (!response.ok) {
      throw new ComposioApiError(response.status, composioErrorMessage(response.status, text));
    }
    this._validated = true;
    // A 204/empty body resolves to an empty object.
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  /** One raw fetch, bounded by the timeout, under the given header kind. */
  private async _issue(
    method: string,
    path: string,
    json: unknown,
    kind: ComposioAuthHeaderKind
  ): Promise<{ response: Response; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      const response = await this._fetch(`${this._baseUrl}${path}`, {
        method,
        headers: {
          ...this._authHeaders(kind),
          ...(json !== undefined && { 'content-type': 'application/json' }),
        },
        ...(json !== undefined && { body: JSON.stringify(json) }),
        signal: controller.signal,
      });
      const text = await response.text();
      return { response, text };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build an honest, secret-free error message from a Composio error response.
 * Composio's envelope is `{ error: { message, suggested_fix } }`
 * (`VERIFIED-LIVE 2026-07-29`); its messages mask key material themselves. A
 * non-JSON body falls back to the bare status.
 *
 * @param status - The failing HTTP status.
 * @param bodyText - The raw response body text.
 */
function composioErrorMessage(status: number, bodyText: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string; suggested_fix?: string };
    };
    const parts = [parsed.error?.message, parsed.error?.suggested_fix].filter(Boolean);
    detail = parts.join(' ');
  } catch {
    // Not JSON — keep the bare status; never echo an arbitrary body wholesale.
  }
  return detail
    ? `Composio request failed (${status}): ${detail}`
    : `Composio request failed (${status}).`;
}

/** Raw Composio toolkit JSON (v3.1, partial). */
interface RawToolkit {
  slug: string;
  name?: string;
  auth_schemes?: string[];
  no_auth?: boolean;
}

/** Raw Composio auth-config JSON (v3.1, partial). */
interface RawAuthConfig {
  id?: string;
  is_disabled?: boolean;
}

/** Raw create-connected-account response JSON (v3.1, partial). */
interface RawCreatedConnectedAccount {
  id: string;
  status?: string;
  redirect_url?: string | null;
  connectionData?: { val?: { redirectUrl?: string } };
}

/** Raw Composio connected-account JSON (v3.1, partial). */
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
    case 'INITIALIZING':
    case 'INITIATED':
      return 'INITIATED';
    default:
      // An unknown status must not read as still-in-flight — a poller would
      // spin forever on an unrecognized terminal state (the same fail-closed
      // rule as the Nango client, DOR-415 nit).
      return 'FAILED';
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
