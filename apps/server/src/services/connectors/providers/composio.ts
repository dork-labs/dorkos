/**
 * The Composio managed-custody {@link ConnectorProvider} — the flagship gateway
 * backend (spec §Detailed Design 1, spike §1.3). It connects a DorkOS agent to
 * any Composio toolkit (Gmail, Slack, …), holds N accounts of one service, and
 * exposes each account's tools to a session as Composio's Rube MCP endpoint.
 *
 * Capabilities: `type: 'composio'`, `supportsMultiAccount: true`,
 * `custody: 'managed'`, `exposesOverMcp: true`. Custody is `managed` because the
 * upstream OAuth tokens live in Composio's cloud vault, never in DorkOS's store —
 * the only DorkOS-held secret is the Composio API key (a `file:` credential
 * reference), and the only per-account state is the opaque `ca_…` handle. That is
 * the whole custody point (spec §Security Considerations): the managed-vault
 * trade is acceptable *because* it is disclosed before connect.
 *
 * **The HTTP boundary is injectable** ({@link ComposioHttpClient}), so this
 * provider is verified hermetically against a fake client (DorkOS CI is
 * mock-backed; a live Composio account is an external dependency exercised out of
 * band). The `ca_… ↔ ConnectedAccountId` normalization is confined to this file
 * ({@link toConnectedAccountId} / {@link toComposioAccountId}); no `ca_` handle
 * ever leaks past the port.
 *
 * @module services/connectors/providers/composio
 */
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import type {
  ConnectedAccount,
  ConnectedAccountId,
  ConnectedAccountStatus,
  ConnectorCapabilities,
  ConnectorProvider,
  ConnectorToolkit,
  ConnectPoll,
  ConnectStart,
} from '@dorkos/shared/connector-provider';
import type { CredentialProvider } from '../../core/credential-provider.js';
import { logger } from '../../../lib/logger.js';
import {
  ComposioApiError,
  FetchComposioHttpClient,
  type ComposioAccountStatus,
  type ComposioConnectedAccount,
  type ComposioHttpClient,
} from './composio-client.js';

/** The backend type identifier this provider registers and reports under. */
export const COMPOSIO_PROVIDER_TYPE = 'composio';

/**
 * The `user_id` a single-operator DorkOS instance scopes Composio accounts
 * under. OQ1 (spec §Open Questions): one fixed id suffices pre-launch; per-user
 * scoping is deferred to multi-user DorkOS.
 */
export const DEFAULT_COMPOSIO_USER_ID = 'dorkos-operator';

/**
 * The credential-store name (and its `file:` reference) the Composio API key is
 * read from — the single funnel that keeps the key out of config plaintext (the
 * relay `adapter-secrets.ts` / connect `credentials.ts` DOR-280 pattern). A
 * settings write path (later phase) stores the key under this name via
 * `credentialStore.put`; this provider only ever reads it.
 */
export const COMPOSIO_CREDENTIAL_NAME = 'composio-api-key';
/** The `file:` credential reference for {@link COMPOSIO_CREDENTIAL_NAME}. */
export const COMPOSIO_API_KEY_REF = `file:${COMPOSIO_CREDENTIAL_NAME}`;

/**
 * Wrap a raw Composio `ca_…` handle as an opaque, provider-scoped
 * {@link ConnectedAccountId}. The `composio:` prefix namespaces the id (mirrors
 * raw-MCP's `mcp:` scheme) and makes the inverse deterministic; session code
 * treats it as opaque and never parses it.
 *
 * @param composioAccountId - The raw Composio `ca_…` connected-account id.
 */
export function toConnectedAccountId(composioAccountId: string): ConnectedAccountId {
  return `${COMPOSIO_PROVIDER_TYPE}:${composioAccountId}` as ConnectedAccountId;
}

/**
 * Unwrap a {@link ConnectedAccountId} back to the raw Composio `ca_…` handle for
 * a vendor API call. The inverse of {@link toConnectedAccountId}; confined to
 * this adapter so no `ca_` string leaks outside it.
 *
 * @param accountId - An opaque account id minted by this provider.
 */
export function toComposioAccountId(accountId: ConnectedAccountId): string {
  const prefix = `${COMPOSIO_PROVIDER_TYPE}:`;
  return accountId.startsWith(prefix) ? accountId.slice(prefix.length) : accountId;
}

/**
 * Whether an error is a routine Composio transport failure the read/expose
 * methods must degrade over rather than throw through the port: a
 * {@link ComposioApiError} (any HTTP status — a stale key's 401, a 5xx, a
 * swallowed-elsewhere 404) or a `fetch` timeout (`AbortError`). A non-transport
 * error (a genuine bug) is deliberately NOT matched, so it still surfaces.
 *
 * @param err - The caught error.
 */
function isTransportError(err: unknown): boolean {
  return err instanceof ComposioApiError || (err instanceof Error && err.name === 'AbortError');
}

/** A secret-free message for a caught transport error (ComposioApiError messages are secret-free by design). */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map a Composio toolkit auth scheme onto the port's {@link ConnectorToolkit.authKind}. */
function toAuthKind(authScheme: string | undefined): ConnectorToolkit['authKind'] {
  if (authScheme === 'API_KEY') return 'api-key';
  if (authScheme === 'NO_AUTH') return 'none';
  return 'oauth2';
}

/** Map a Composio lifecycle status onto the port's {@link ConnectedAccountStatus}. */
function toPortStatus(status: ComposioAccountStatus): ConnectedAccountStatus {
  switch (status) {
    case 'ACTIVE':
      return 'active';
    case 'EXPIRED':
      return 'expired';
    case 'INITIATED':
      return 'pending';
    case 'INACTIVE':
    case 'FAILED':
      return 'revoked';
  }
}

/** Construction options for {@link ComposioConnectorProvider}. */
export interface ComposioConnectorProviderOpts {
  /** The Composio HTTP boundary (a fake in tests, {@link FetchComposioHttpClient} in prod). */
  client: ComposioHttpClient;
}

/**
 * Managed-custody connector over Composio. Multi-account by construction:
 * distinct connects of one toolkit (distinguished by `alias`) yield distinct
 * `ca_…` handles, each an independently-addressable {@link ConnectedAccountId}.
 *
 * **Throw-free contract** (a Composio API call can fail — a stale key's 401, a
 * 5xx, a `fetch` timeout — so each method declares how it degrades):
 *
 * - `listToolkits`, `listAccounts` — throw-free; a transport failure degrades to
 *   an empty list (logged). The registry aggregation records a warning upstream.
 * - `toolServerForAccount` — throw-free; a transport failure resolves `null` (the
 *   surfaced per-account null branch), because its consumer
 *   (`session-exposure.attach`) awaits it unguarded and a throw would 500 the
 *   attach route instead of recording attach-with-warning.
 * - `pollConnect` — throw-free; maps a transport failure to a failure-typed
 *   `{ status: 'failed' }`.
 * - `disconnect` — idempotent: the client swallows a 404 (an unknown/already-
 *   revoked id resolves cleanly). A genuine 5xx on a revoke surfaces (throws)
 *   rather than falsely reporting success — like `startConnect`, revoke is an
 *   interactive action.
 * - `startConnect` — MAY throw: connect is an interactive settings action with no
 *   failure type on the port (mirrors raw-MCP rejecting a duplicate connect), so
 *   a transport failure or a missing authorize URL throws a clear error the UI
 *   surfaces for retry.
 *
 * A non-transport error (a genuine bug, not a routine API failure) is never
 * swallowed — it surfaces from every method.
 */
export class ComposioConnectorProvider implements ConnectorProvider {
  readonly type = COMPOSIO_PROVIDER_TYPE;

  private readonly _client: ComposioHttpClient;

  /**
   * Construct the provider over an injected Composio HTTP client.
   *
   * @param opts - The HTTP client seam; see {@link ComposioConnectorProviderOpts}.
   */
  constructor(opts: ComposioConnectorProviderOpts) {
    this._client = opts.client;
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      type: this.type,
      supportsMultiAccount: true,
      custody: 'managed',
      exposesOverMcp: true,
      features: {},
    };
  }

  async listToolkits(): Promise<ConnectorToolkit[]> {
    try {
      const toolkits = await this._client.listToolkits();
      return toolkits.map((tk) => ({
        slug: tk.slug,
        displayName: tk.name,
        authKind: toAuthKind(tk.authScheme),
        ...(typeof tk.maxAccountsPerToolkit === 'number' && {
          maxAccountsPerUser: tk.maxAccountsPerToolkit,
        }),
      }));
    } catch (err) {
      // Throw-free: a transport failure degrades to an empty list. The registry
      // aggregation still records a warning upstream (it also races each provider
      // under a timeout), but the adapter itself must not throw through the port.
      if (isTransportError(err)) {
        logger.warn(`[Connectors] composio listToolkits degraded: ${errText(err)}`);
        return [];
      }
      throw err;
    }
  }

  async startConnect(toolkit: string, opts?: { label?: string }): Promise<ConnectStart> {
    // Connect is an interactive settings action with NO failure type on the port
    // (mirrors raw-MCP rejecting a duplicate connect), so a transport failure
    // here throws a clear error rather than degrading — the UI shows it and the
    // user retries. The label is carried as Composio's human-readable account
    // alias, the disambiguator between two accounts of one toolkit (spike §1.3).
    const request = await this._client.initiateConnection({
      toolkit,
      ...(opts?.label && { alias: opts.label }),
    });
    if (!request.redirectUrl) {
      // A missing consent URL is unusable — fail loudly instead of returning an
      // empty `authorizeUrl` the picker would silently open to nowhere.
      throw new Error(`Composio returned no authorize URL for toolkit '${toolkit}'.`);
    }
    return { authorizeUrl: request.redirectUrl, flowId: request.connectionRequestId };
  }

  async pollConnect(flowId: string): Promise<ConnectPoll> {
    try {
      const state = await this._client.getConnectionState(flowId);
      if (state.status === 'ACTIVE' && state.account) {
        return { status: 'connected', account: this._toPortAccount(state.account) };
      }
      if (state.status === 'INITIATED') {
        return { status: 'pending' };
      }
      // Any unusable terminal state is a typed failure, never a throw.
      return {
        status: 'failed',
        error: state.error ?? `connect ended in status '${state.status}'`,
      };
    } catch (err) {
      // The port makes failure typed on pollConnect — a transport failure while
      // polling maps to a failed poll, never a throw.
      if (isTransportError(err)) {
        return { status: 'failed', error: errText(err) };
      }
      throw err;
    }
  }

  async listAccounts(opts?: { toolkit?: string }): Promise<ConnectedAccount[]> {
    try {
      const accounts = await this._client.listConnectedAccounts(opts);
      return accounts.map((account) => this._toPortAccount(account));
    } catch (err) {
      // Throw-free: a transport failure degrades to an empty list (see listToolkits).
      if (isTransportError(err)) {
        logger.warn(`[Connectors] composio listAccounts degraded: ${errText(err)}`);
        return [];
      }
      throw err;
    }
  }

  async disconnect(accountId: ConnectedAccountId): Promise<void> {
    // Idempotent: the client swallows a 404, so revoking an unknown/already-
    // revoked id resolves without throwing (conformance requires this).
    await this._client.deleteConnectedAccount(toComposioAccountId(accountId));
  }

  async toolServerForAccount(
    accountId: ConnectedAccountId
  ): Promise<McpAppServerConnection | null> {
    // Route the opaque id back to its Composio handle and mint the Rube MCP
    // session. A null session (unusable account, no live url) surfaces as null —
    // the per-account warning path (spec §Detailed Design 3), never a throw.
    // Its consumer (session-exposure attach) awaits this UNGUARDED, so a stale
    // key's 401, a 5xx, or a timeout must also resolve null (attach-recorded,
    // surfaced-as-warning), not throw a 500 out of the attach route.
    try {
      const session = await this._client.mcpSessionForAccount(toComposioAccountId(accountId));
      if (!session) return null;
      return {
        transport: 'http',
        url: session.url,
        ...(session.headers && { headers: session.headers }),
      };
    } catch (err) {
      if (isTransportError(err)) {
        logger.warn(`[Connectors] composio toolServerForAccount degraded to null: ${errText(err)}`);
        return null;
      }
      throw err;
    }
  }

  /** Map a Composio domain account onto the provider-neutral {@link ConnectedAccount}. */
  private _toPortAccount(account: ComposioConnectedAccount): ConnectedAccount {
    return {
      id: toConnectedAccountId(account.connectedAccountId),
      provider: this.type,
      toolkit: account.toolkit,
      label: account.alias ?? account.toolkit,
      status: toPortStatus(account.status),
      custody: 'managed',
    };
  }
}

/** Injectable dependencies for {@link maybeCreateComposioProvider}. */
export interface MaybeCreateComposioProviderDeps {
  /** The credential read port that resolves the API-key reference. */
  credentials: CredentialProvider;
  /** The reference to resolve for the API key (defaults to {@link COMPOSIO_API_KEY_REF}). */
  apiKeyRef?: string;
  /** The Composio `user_id` scope (defaults to {@link DEFAULT_COMPOSIO_USER_ID}). */
  userId?: string;
  /** Override the Composio API origin. */
  baseUrl?: string;
  /**
   * Build the HTTP client from the resolved key (tests inject a fake, bypassing
   * `fetch`). Defaults to {@link FetchComposioHttpClient}.
   *
   * @param opts - The resolved API key, `user_id`, and optional origin.
   */
  makeClient?: (opts: { apiKey: string; userId: string; baseUrl?: string }) => ComposioHttpClient;
}

/**
 * Build the Composio provider ONLY when the API key is configured — the
 * registry gate (task 5.1 #6). Resolves the API-key reference through the
 * existing credential machinery; a dangling/absent reference means the provider
 * is unconfigured and this returns `null`, so an install without a Composio key
 * keeps the registry exactly as it was (no `composio` provider registered, no
 * crash). The resolved key is held only inside the HTTP client, never logged.
 *
 * @param deps - The credential port + optional ref/scope/client overrides.
 * @returns A ready {@link ComposioConnectorProvider}, or `null` when unconfigured.
 */
export async function maybeCreateComposioProvider(
  deps: MaybeCreateComposioProviderDeps
): Promise<ComposioConnectorProvider | null> {
  const ref = deps.apiKeyRef ?? COMPOSIO_API_KEY_REF;
  const resolution = await deps.credentials.resolve(ref);
  if (!resolution.ok) return null;

  const makeClient =
    deps.makeClient ??
    ((opts): ComposioHttpClient =>
      new FetchComposioHttpClient({
        apiKey: opts.apiKey,
        userId: opts.userId,
        ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }),
      }));

  const client = makeClient({
    apiKey: resolution.secret,
    userId: deps.userId ?? DEFAULT_COMPOSIO_USER_ID,
    ...(deps.baseUrl !== undefined && { baseUrl: deps.baseUrl }),
  });
  return new ComposioConnectorProvider({ client });
}
