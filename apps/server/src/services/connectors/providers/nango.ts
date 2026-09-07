/**
 * The Nango self-host {@link ConnectorProvider} — the privacy-cohort backend
 * (spec §Detailed Design 1/4, spike §1.3). It connects a DorkOS agent to a
 * self-hosted Nango server so every OAuth token stays in the operator's own
 * Postgres, on infrastructure they control.
 *
 * Capabilities: `type: 'nango'`, `supportsMultiAccount: true`,
 * `custody: 'self-host'`. Custody is `self-host`
 * because DorkOS holds only a `file:` reference to the Nango secret key + the
 * self-host base URL; the upstream tokens live in the operator's Nango, never in
 * DorkOS's store. The `connectionId ↔ ConnectorExternalAccountRef` normalization is
 * confined to this file ({@link toExternalAccountRef} / {@link toNangoConnectionId}).
 *
 * Provider credentials and transport remain confined to this adapter. Account
 * management is available, while operation discovery and broker execution stay
 * typed unsupported until Nango can supply trusted immutable operation metadata.
 * No provider MCP endpoint is exposed to an agent runtime.
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
import { createHash } from 'node:crypto';
import type {
  ConnectorCapabilities,
  ConnectorExternalAccountRef,
  ConnectorProvider,
  ConnectorProviderInstanceId,
  ConnectorToolkit,
  ConnectPoll,
  ConnectStart,
  ProviderConnectedAccount,
} from '@dorkos/shared/connector-provider';
import type { ConnectorProviderExecuteCommand } from '@dorkos/shared/connector-schemas';
import type { CredentialProvider } from '../../core/credential-provider.js';
import {
  FetchNangoHttpClient,
  NangoApiError,
  type NangoConnection,
  type NangoConnectionStatus,
  type NangoHttpClient,
} from './nango-client.js';
import { legacyDefaultProviderInstanceId } from '../legacy-connection-migration.js';

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
 * Wrap a raw Nango `connectionId` as a private, provider-scoped
 * {@link ConnectorExternalAccountRef}. The prefix makes the inverse deterministic.
 *
 * @param connectionId - The raw Nango `connectionId` (random UUID).
 */
export function toExternalAccountRef(connectionId: string): ConnectorExternalAccountRef {
  return `${NANGO_PROVIDER_TYPE}:${connectionId}` as ConnectorExternalAccountRef;
}

/**
 * Unwrap a {@link ConnectorExternalAccountRef} back to the raw Nango `connectionId` for a
 * vendor API call. The inverse of {@link toExternalAccountRef}; confined to this
 * adapter so no raw handle leaks outside it.
 *
 * @param accountId - A private account reference minted by this provider.
 */
export function toNangoConnectionId(accountId: ConnectorExternalAccountRef): string {
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
        'your Nango server uses) — see docs/connections/nango.mdx.'
    );
  }
  const decoded = Buffer.from(key, 'base64');
  if (decoded.length !== REQUIRED_ENCRYPTION_KEY_BYTES) {
    throw new NangoEncryptionKeyError(
      `NANGO_ENCRYPTION_KEY must be a 256-bit key written in base64 (32 bytes decoded); ` +
        `the value provided decodes to ${decoded.length} bytes. See docs/connections/nango.mdx.`
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
function toPortStatus(status: NangoConnectionStatus): ProviderConnectedAccount['status'] {
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
  /** Stable configured provider instance id. */
  instanceId?: ConnectorProviderInstanceId;
  /** Digest of the exact secret and server-owned construction values. */
  executionConfigDigest?: string;
}

/**
 * Self-host-custody connector over Nango. Multi-account by construction:
 * distinct connects of one integration yield distinct `connectionId`s, each an
 * independently addressable private provider reference, disambiguated by a label
 * carried as a Nango tag.
 *
 * **Degrade contract** (a Nango API call can fail — a stale key's 401, a 5xx,
 * a `fetch` timeout — so each method declares how it degrades):
 *
 * - `listToolkits`, `listAccounts` — a transport failure PROPAGATES: the
 *   registry's aggregation paths turn a rejection into an honest per-provider
 *   `warnings[]` entry (ADR-0310). An empty success and a failure must never be
 *   indistinguishable (the composio silent-401 lesson, DOR-703).
 * - `pollConnect` — throw-free; maps a transport failure to a failure-typed
 *   `{ status: 'failed' }`.
 * - `disconnect` — idempotent: the client swallows a 404 (an unknown/already-
 *   revoked id resolves cleanly). A genuine 5xx surfaces (throws), like connect.
 * - `startConnect` — MAY throw: connect is an interactive settings action with no
 *   failure type on the port, so a transport failure or a missing authorize URL
 *   throws a clear error the UI surfaces for retry.
 *
 * A non-transport error (a genuine bug, not a routine API failure) is never
 * swallowed — it surfaces from every method.
 */
export class NangoConnectorProvider implements ConnectorProvider {
  readonly instanceId: ConnectorProviderInstanceId;
  readonly type = NANGO_PROVIDER_TYPE;

  private readonly _client: NangoHttpClient;
  readonly #executionConfigDigest: string | undefined;

  /**
   * Construct the provider over an injected Nango HTTP client.
   *
   * @param opts - The HTTP client and server-owned config; see {@link NangoConnectorProviderOpts}.
   */
  constructor(opts: NangoConnectorProviderOpts) {
    this._client = opts.client;
    this.#executionConfigDigest = opts.executionConfigDigest;
    this.instanceId =
      opts.instanceId ??
      (legacyDefaultProviderInstanceId(this.type) as ConnectorProviderInstanceId);
  }

  /** Server-only evidence for the exact configuration used to construct this instance. */
  get executionConfigDigest(): string | undefined {
    return this.#executionConfigDigest;
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      instanceId: this.instanceId,
      type: this.type,
      supportsMultiAccount: true,
      custody: 'self-host',
      // The external account reference remains provider-confined. Nango does not
      // expose an arbitrary proxy or vendor MCP surface to runtimes.
      capabilities: {
        catalog: { status: 'available' },
        authentication: { status: 'available' },
        accounts: { status: 'available' },
        operations: {
          status: 'unsupported',
          reason:
            'Nango does not provide trusted immutable operation metadata for brokered execution.',
        },
        execution: {
          status: 'unsupported',
          reason: 'Nango execution is unavailable without trusted exact-revision semantics.',
        },
        triggers: { status: 'unsupported', reason: 'Trigger support is not configured.' },
      },
      features: {},
    };
  }

  async listToolkitPage(request: {
    cursor?: string;
    query?: string;
    limit: number;
    signal: AbortSignal;
  }) {
    request.signal.throwIfAborted();
    const all = (await this.listToolkits()).filter((toolkit) =>
      request.query ? toolkit.displayName.toLowerCase().includes(request.query.toLowerCase()) : true
    );
    const offset = request.cursor ? Number(request.cursor) : 0;
    const toolkits = all.slice(offset, offset + request.limit);
    const next = offset + toolkits.length;
    return {
      status: 'ok' as const,
      toolkits,
      ...(next < all.length && { nextCursor: String(next) }),
      truncated: next < all.length,
    };
  }

  async resolveToolkitVersion(_toolkit: string, _signal: AbortSignal) {
    _signal.throwIfAborted();
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Nango operation version discovery is unavailable.',
    });
  }

  async listOperationSchemas(_request: {
    toolkit: string;
    toolkitVersion: string;
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }) {
    _request.signal.throwIfAborted();
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Nango does not provide trusted immutable operation metadata for brokered execution.',
    });
  }

  execute(_command: ConnectorProviderExecuteCommand) {
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Nango execution is unavailable without trusted exact-revision semantics.',
    });
  }

  listTriggerTypes(_toolkit: string) {
    return Promise.resolve({
      status: 'unsupported' as const,
      reason: 'Trigger support is not configured.',
    });
  }

  async listToolkits(): Promise<ConnectorToolkit[]> {
    // A failure propagates on purpose: the registry aggregation converts it to
    // a per-provider warning the client renders (never a silent empty list).
    const integrations = await this._client.listIntegrations();
    return integrations.map((it) => ({
      slug: it.uniqueKey,
      displayName: it.displayName ?? it.provider ?? it.uniqueKey,
      authKind: toAuthKind(it.authMode),
    }));
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

  async listAccounts(opts?: { toolkit?: string }): Promise<ProviderConnectedAccount[]> {
    // Propagates on failure — see listToolkits.
    const connections = await this._client.listConnections(
      opts?.toolkit ? { integration: opts.toolkit } : undefined
    );
    return connections.map((connection) => this._toPortAccount(connection));
  }

  async disconnect(accountId: ConnectorExternalAccountRef): Promise<void> {
    // Idempotent: the client swallows a 404, so revoking an unknown/already-
    // revoked id resolves without throwing (conformance requires this).
    await this._client.deleteConnection(toNangoConnectionId(accountId));
  }

  /** Map a Nango connection onto private provider account metadata. */
  private _toPortAccount(connection: NangoConnection): ProviderConnectedAccount {
    return {
      externalAccountRef: toExternalAccountRef(connection.connectionId),
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
  /** Stable configured provider instance id. */
  instanceId?: ConnectorProviderInstanceId;
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
  const providerInstanceId =
    deps.instanceId ??
    (legacyDefaultProviderInstanceId(NANGO_PROVIDER_TYPE) as ConnectorProviderInstanceId);
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        provider: NANGO_PROVIDER_TYPE,
        secretKey: resolution.secret,
        encryptionKey: deps.encryptionKey,
        baseUrl,
        providerInstanceId,
      })
    )
    .digest('hex');
  return new NangoConnectorProvider({
    client,
    instanceId: providerInstanceId,
    executionConfigDigest: digest,
  });
}
