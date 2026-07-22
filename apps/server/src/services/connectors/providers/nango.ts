/**
 * The Nango self-host {@link ConnectorProvider} — the privacy-cohort backend
 * (spec §Detailed Design 1/4, spike §1.3). It connects a DorkOS agent to a
 * self-hosted Nango server so every OAuth token stays in the operator's own
 * Postgres, on infrastructure they control.
 *
 * Capabilities: `type: 'nango'`, `supportsMultiAccount: true`,
 * `custody: 'self-host'`, **`exposesOverMcp: false`**. Custody is `self-host`
 * because DorkOS holds only a `file:` reference to the Nango secret key + the
 * self-host base URL; the upstream tokens live in the operator's Nango, never in
 * DorkOS's store. The `connectionId ↔ ConnectedAccountId` normalization is
 * confined to this file ({@link toConnectedAccountId} / {@link toNangoConnectionId}).
 *
 * **Why `exposesOverMcp: false` (the honest scope of this phase).** Free
 * self-hosted Nango gives Auth + a credentialed HTTP proxy and *no MCP server* —
 * Nango's own MCP server is Enterprise-gated, and this adapter must never depend
 * on it (spike §1.3, spec §Non-Goals). Turning Nango's Proxy into MCP tools is a
 * DorkOS-built wrapper that does not exist yet and would be an unverified surface
 * to ship, so this adapter declares `exposesOverMcp: false` and
 * {@link NangoConnectorProvider.toolServerForAccount} always resolves `null` —
 * exactly the port's documented null branch ("a transport this host cannot
 * independently reconnect", `connector-provider.ts`). An account still connects
 * and its custody is handled truthfully; tool exposure waits on the Proxy→MCP
 * wrapper. This mirrors a `FakeConnectorProvider` in false-mode and passes the
 * conformance suite's `exposesOverMcp: false` branch.
 *
 * **Self-host re-check (2026-07-21, DOR-371 P7 kickoff — spec OQ2 / spike §4.1).**
 * The spec mandates re-confirming Nango vs `oomol-lab/open-connector` (Apache-2.0)
 * before locking the self-host slot. Verdict: **Nango holds the slot.** As of
 * 2026-07-21 open-connector is still `v1.3.0` (2026-07-17 — no `>v1.3.0` release
 * since the spike), still single-vendor (owner `oomol-lab`, no second
 * maintainer/vendor), ~3,057 stars (spike measured ~2,900 — normal early-project
 * drift, not a step-change in adoption). None of the spec's watch signals
 * (second vendor, `>v1.3.0`, measurable adoption jump) tripped, so the evidence
 * still supports Nango; open-connector stays watch-only.
 *
 * @module services/connectors/providers/nango
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
  FetchNangoHttpClient,
  NangoApiError,
  type NangoConnection,
  type NangoConnectionStatus,
  type NangoHttpClient,
} from './nango-client.js';

/** The backend type identifier this provider registers and reports under. */
export const NANGO_PROVIDER_TYPE = 'nango';

/**
 * The credential-store name (and its `file:` reference) the Nango secret key is
 * read from — the single funnel that keeps the key out of config plaintext (the
 * relay `adapter-secrets.ts` / connect `credentials.ts` DOR-280 pattern). A
 * settings write path (later phase) stores the key under this name via
 * `credentialStore.put`; this provider only ever reads it.
 */
export const NANGO_CREDENTIAL_NAME = 'nango-secret-key';
/** The `file:` credential reference for {@link NANGO_CREDENTIAL_NAME}. */
export const NANGO_SECRET_KEY_REF = `file:${NANGO_CREDENTIAL_NAME}`;

/** A 256-bit encryption key is exactly 32 bytes once base64-decoded. */
const REQUIRED_ENCRYPTION_KEY_BYTES = 32;

/**
 * Thrown when the Nango self-host connector is configured (secret key + base URL
 * present) but `NANGO_ENCRYPTION_KEY` is missing or not a valid 256-bit base64
 * key. Refusing to operate is the point: without the key Nango stores tokens
 * unencrypted and the "your infrastructure, your keys" promise is false (spec
 * §Detailed Design 4, §Security Considerations).
 */
export class NangoEncryptionKeyError extends Error {
  /**
   * Construct the loud, helpful refusal.
   *
   * @param message - A secret-free explanation the operator can act on.
   */
  constructor(message: string) {
    super(message);
    this.name = 'NangoEncryptionKeyError';
  }
}

/**
 * Wrap a raw Nango `connectionId` as an opaque, provider-scoped
 * {@link ConnectedAccountId}. The `nango:` prefix namespaces the id (mirrors
 * `composio:`/`mcp:`) and makes the inverse deterministic; session code treats
 * it as opaque and never parses it.
 *
 * @param connectionId - The raw Nango `connectionId` (random UUID).
 */
export function toConnectedAccountId(connectionId: string): ConnectedAccountId {
  return `${NANGO_PROVIDER_TYPE}:${connectionId}` as ConnectedAccountId;
}

/**
 * Unwrap a {@link ConnectedAccountId} back to the raw Nango `connectionId` for a
 * vendor API call. The inverse of {@link toConnectedAccountId}; confined to this
 * adapter so no raw handle leaks outside it.
 *
 * @param accountId - An opaque account id minted by this provider.
 */
export function toNangoConnectionId(accountId: ConnectedAccountId): string {
  const prefix = `${NANGO_PROVIDER_TYPE}:`;
  return accountId.startsWith(prefix) ? accountId.slice(prefix.length) : accountId;
}

/**
 * Assert that `key` is a valid 256-bit base64 encryption key, throwing a
 * {@link NangoEncryptionKeyError} otherwise. This is the enforced-not-just-
 * disclosed gate (spec §4): DorkOS refuses to run the self-host connector until
 * the operator sets the same `NANGO_ENCRYPTION_KEY` its Nango server uses.
 *
 * @param key - The candidate `NANGO_ENCRYPTION_KEY` value, or undefined when unset.
 */
export function assertNangoEncryptionKey(key: string | undefined): void {
  if (!key) {
    throw new NangoEncryptionKeyError(
      'NANGO_ENCRYPTION_KEY is not set. Self-hosted Nango stores logins unencrypted without it, ' +
        'so DorkOS will not run the self-host connector. Set a 256-bit base64 key (the same value ' +
        'your Nango server uses) — see docs/connectors/nango.mdx.'
    );
  }
  const decoded = Buffer.from(key, 'base64');
  if (decoded.length !== REQUIRED_ENCRYPTION_KEY_BYTES) {
    throw new NangoEncryptionKeyError(
      `NANGO_ENCRYPTION_KEY must be a 256-bit key written in base64 (32 bytes decoded); ` +
        `the value provided decodes to ${decoded.length} bytes. See docs/connectors/nango.mdx.`
    );
  }
}

/**
 * Whether an error is a routine Nango transport failure the read methods must
 * degrade over rather than throw through the port: a {@link NangoApiError} (any
 * HTTP status) or a `fetch` timeout (`AbortError`). A non-transport error (a
 * genuine bug) is deliberately NOT matched, so it still surfaces.
 *
 * @param err - The caught error.
 */
function isTransportError(err: unknown): boolean {
  return err instanceof NangoApiError || (err instanceof Error && err.name === 'AbortError');
}

/** A secret-free message for a caught transport error (NangoApiError messages are secret-free by design). */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map a Nango auth mode onto the port's {@link ConnectorToolkit.authKind}. */
function toAuthKind(authMode: string | undefined): ConnectorToolkit['authKind'] {
  const mode = (authMode ?? '').toUpperCase();
  if (mode === 'API_KEY' || mode === 'BASIC') return 'api-key';
  if (mode === 'NONE') return 'none';
  return 'oauth2';
}

/** Map a Nango connection status onto the port's {@link ConnectedAccountStatus}. */
function toPortStatus(status: NangoConnectionStatus): ConnectedAccountStatus {
  switch (status) {
    case 'ACTIVE':
      return 'active';
    case 'EXPIRED':
      return 'expired';
    case 'PENDING':
      return 'pending';
    case 'ERROR':
      return 'revoked';
  }
}

/** Construction options for {@link NangoConnectorProvider}. */
export interface NangoConnectorProviderOpts {
  /** The Nango HTTP boundary (a fake in tests, {@link FetchNangoHttpClient} in prod). */
  client: NangoHttpClient;
}

/**
 * Self-host-custody connector over Nango. Multi-account by construction:
 * distinct connects of one integration yield distinct `connectionId`s, each an
 * independently-addressable {@link ConnectedAccountId}, disambiguated by a label
 * carried as a Nango tag.
 *
 * **Throw-free contract** (a Nango API call can fail — a stale key's 401, a 5xx,
 * a `fetch` timeout — so each method declares how it degrades):
 *
 * - `listToolkits`, `listAccounts` — throw-free; a transport failure degrades to
 *   an empty list (logged). The registry aggregation records a warning upstream.
 * - `pollConnect` — throw-free; maps a transport failure to a failure-typed
 *   `{ status: 'failed' }`.
 * - `disconnect` — idempotent: the client swallows a 404 (an unknown/already-
 *   revoked id resolves cleanly). A genuine 5xx surfaces (throws), like connect.
 * - `startConnect` — MAY throw: connect is an interactive settings action with no
 *   failure type on the port, so a transport failure or a missing authorize URL
 *   throws a clear error the UI surfaces for retry.
 * - `toolServerForAccount` — always resolves `null` (`exposesOverMcp: false`); it
 *   touches no network, so it is inherently throw-free.
 *
 * A non-transport error (a genuine bug, not a routine API failure) is never
 * swallowed — it surfaces from every method.
 */
export class NangoConnectorProvider implements ConnectorProvider {
  readonly type = NANGO_PROVIDER_TYPE;

  private readonly _client: NangoHttpClient;

  /**
   * Construct the provider over an injected Nango HTTP client.
   *
   * @param opts - The HTTP client seam; see {@link NangoConnectorProviderOpts}.
   */
  constructor(opts: NangoConnectorProviderOpts) {
    this._client = opts.client;
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      type: this.type,
      supportsMultiAccount: true,
      custody: 'self-host',
      // Free self-hosted Nango has no MCP server (Enterprise-gated); the
      // Proxy→MCP wrapper is a separate deliverable, so no tool server yet.
      exposesOverMcp: false,
      features: {},
    };
  }

  async listToolkits(): Promise<ConnectorToolkit[]> {
    try {
      const integrations = await this._client.listIntegrations();
      return integrations.map((it) => ({
        slug: it.uniqueKey,
        displayName: it.displayName ?? it.provider ?? it.uniqueKey,
        authKind: toAuthKind(it.authMode),
      }));
    } catch (err) {
      // Throw-free: a transport failure degrades to an empty list. The registry
      // aggregation still records a warning upstream (it also races each provider
      // under a timeout), but the adapter itself must not throw through the port.
      if (isTransportError(err)) {
        logger.warn(`[Connectors] nango listToolkits degraded: ${errText(err)}`);
        return [];
      }
      throw err;
    }
  }

  async startConnect(toolkit: string, opts?: { label?: string }): Promise<ConnectStart> {
    // Connect is an interactive settings action with NO failure type on the port,
    // so a transport failure here throws a clear error rather than degrading — the
    // UI shows it and the user retries. The label rides as a Nango tag, the
    // disambiguator between two connections of one integration.
    const request = await this._client.initiateConnection({
      integration: toolkit,
      ...(opts?.label && { label: opts.label }),
    });
    if (!request.authorizeUrl) {
      // A missing consent URL is unusable — fail loudly instead of returning an
      // empty `authorizeUrl` the picker would silently open to nowhere.
      throw new Error(`Nango returned no authorize URL for integration '${toolkit}'.`);
    }
    return { authorizeUrl: request.authorizeUrl, flowId: request.connectionRequestId };
  }

  async pollConnect(flowId: string): Promise<ConnectPoll> {
    try {
      const state = await this._client.getConnectionState(flowId);
      if (state.status === 'ACTIVE' && state.connection) {
        return { status: 'connected', account: this._toPortAccount(state.connection) };
      }
      if (state.status === 'PENDING') {
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
      const connections = await this._client.listConnections(
        opts?.toolkit ? { integration: opts.toolkit } : undefined
      );
      return connections.map((connection) => this._toPortAccount(connection));
    } catch (err) {
      // Throw-free: a transport failure degrades to an empty list (see listToolkits).
      if (isTransportError(err)) {
        logger.warn(`[Connectors] nango listAccounts degraded: ${errText(err)}`);
        return [];
      }
      throw err;
    }
  }

  async disconnect(accountId: ConnectedAccountId): Promise<void> {
    // Idempotent: the client swallows a 404, so revoking an unknown/already-
    // revoked id resolves without throwing (conformance requires this).
    await this._client.deleteConnection(toNangoConnectionId(accountId));
  }

  toolServerForAccount(_accountId: ConnectedAccountId): Promise<McpAppServerConnection | null> {
    // exposesOverMcp: false — free self-hosted Nango has no MCP server (its own is
    // Enterprise-gated, spike §1.3), and the DorkOS Proxy→MCP wrapper is a
    // separate deliverable. So every account resolves null (the port's documented
    // "transport this host cannot independently reconnect" branch), never a throw,
    // and this never depends on Nango's Enterprise MCP.
    return Promise.resolve(null);
  }

  /** Map a Nango domain connection onto the provider-neutral {@link ConnectedAccount}. */
  private _toPortAccount(connection: NangoConnection): ConnectedAccount {
    return {
      id: toConnectedAccountId(connection.connectionId),
      provider: this.type,
      toolkit: connection.integration,
      label: connection.label ?? connection.integration,
      status: toPortStatus(connection.status),
      custody: 'self-host',
    };
  }
}

/** Injectable dependencies for {@link maybeCreateNangoProvider}. */
export interface MaybeCreateNangoProviderDeps {
  /** The credential read port that resolves the secret-key reference. */
  credentials: CredentialProvider;
  /** The reference to resolve for the secret key (defaults to {@link NANGO_SECRET_KEY_REF}). */
  secretKeyRef?: string;
  /** The self-hosted Nango base URL (absent = the connector is unconfigured). */
  baseUrl?: string;
  /** The `NANGO_ENCRYPTION_KEY` value the enforced gate validates. */
  encryptionKey?: string;
  /**
   * Build the HTTP client from the resolved key + base URL (tests inject a fake,
   * bypassing `fetch`). Defaults to {@link FetchNangoHttpClient}.
   *
   * @param opts - The resolved secret key and self-host base URL.
   */
  makeClient?: (opts: { secretKey: string; baseUrl: string }) => NangoHttpClient;
}

/**
 * Build the Nango provider ONLY when it is configured — the registry gate. Nango
 * is "configured" when BOTH the secret key resolves AND a self-host base URL is
 * given; an install with neither keeps the registry exactly as it was (no
 * `nango` provider, no crash), returning `null`.
 *
 * When Nango IS configured, the encryption-key gate fires: a missing/invalid
 * `NANGO_ENCRYPTION_KEY` throws {@link NangoEncryptionKeyError} rather than
 * silently registering an unsafe connector — the caller logs it and skips
 * registration, so the connector refuses to run while the server still boots.
 *
 * @param deps - The credential port + base URL + encryption key + optional overrides.
 * @returns A ready {@link NangoConnectorProvider}, or `null` when unconfigured.
 * @throws NangoEncryptionKeyError when configured but the encryption key is absent/invalid.
 */
export async function maybeCreateNangoProvider(
  deps: MaybeCreateNangoProviderDeps
): Promise<NangoConnectorProvider | null> {
  const ref = deps.secretKeyRef ?? NANGO_SECRET_KEY_REF;
  const resolution = await deps.credentials.resolve(ref);
  // Unconfigured (no secret key or no base URL) → silent null, like Composio.
  if (!resolution.ok || !deps.baseUrl) return null;

  // Configured → the enforced gate: refuse loudly without a valid encryption key.
  assertNangoEncryptionKey(deps.encryptionKey);

  const baseUrl = deps.baseUrl;
  const makeClient =
    deps.makeClient ??
    ((opts): NangoHttpClient =>
      new FetchNangoHttpClient({ secretKey: opts.secretKey, baseUrl: opts.baseUrl }));

  const client = makeClient({ secretKey: resolution.secret, baseUrl });
  return new NangoConnectorProvider({ client });
}
