/**
 * `ConnectorProviderBootstrapper` — the single owner of connector-provider
 * construction, registration, and live reload (connector-completion spec
 * §Detailed Design 1).
 *
 * Boot (`registerBootProviders`) registers the raw-MCP baseline always (an
 * empty server list is valid — the seam is live before anyone configures a
 * server) and the credential-gated backends (Composio, Nango) only when
 * configured, with exactly the semantics the old inline `index.ts` block had:
 * silent-null when unconfigured, loud `NangoEncryptionKeyError` refusal
 * logged-and-skipped when Nango is configured without a valid encryption key —
 * the server still boots.
 *
 * Reload (`reload('composio' | 'nango')`) re-runs the same factory and swaps
 * the registration atomically (unregister-if-present → `maybeCreate*` →
 * connection check → register-if-it-answers), so saving a vendor key through
 * `PUT /api/connectors/providers/:provider/credential` registers the provider
 * live and deleting it unregisters — no restart ever required.
 *
 * **Registered means it actually answers.** Before a provider is registered
 * (at boot and on every reload), the bootstrapper runs one cheap authenticated
 * read against it. First real contact (DOR-703) proved why: a wrong-kind
 * Composio key (the CLI's `uak_…` user key instead of a project key) passes
 * the credential gate and then 401s on every call — without the check the UI
 * said Ready over a dead service grid. A failed check leaves the provider
 * unregistered and carries the API's own secret-free error message on the
 * status DTO, where the provider card renders it verbatim.
 *
 * Under `DORKOS_TEST_RUNTIME` a third credential-gated spec, `test-connector`,
 * joins the set so e2e can exercise the save-key step end to end; its factory
 * is injected (Slice E supplies the real scripted provider).
 *
 * @module services/connectors/bootstrap
 */
import type {
  ConnectorCustody,
  ConnectorKeyKind,
  ConnectorProvider,
  ConnectorProviderStatus,
} from '@dorkos/shared/connector-provider';
import { logger } from '../../lib/logger.js';
import type { CredentialProvider } from '../core/credential-provider.js';
import { custodyDisclosure, MANAGED_CUSTODY_CANONICAL_SENTENCE } from './custody-disclosure.js';
import type { ConnectorRegistry } from './registry.js';
import {
  maybeCreateComposioProvider,
  COMPOSIO_API_KEY_REF,
  type MaybeCreateComposioProviderDeps,
} from './providers/composio.js';
import {
  maybeCreateNangoProvider,
  NangoEncryptionKeyError,
  NANGO_SECRET_KEY_REF,
  type MaybeCreateNangoProviderDeps,
} from './providers/nango.js';
import type { NangoProxyMcp } from './providers/nango-proxy-mcp.js';
import { RawMcpConnectorProvider, type RawMcpServerDescriptor } from './providers/raw-mcp.js';

/** The test-mode provider type the credential route accepts under `DORKOS_TEST_RUNTIME`. */
export const TEST_CONNECTOR_PROVIDER_TYPE = 'test-connector';

/** The credential-store name the test-mode connector key is stored under. */
export const TEST_CONNECTOR_CREDENTIAL_NAME = 'test-connector-api-key';

/** The `file:` credential reference for {@link TEST_CONNECTOR_CREDENTIAL_NAME}. */
export const TEST_CONNECTOR_API_KEY_REF = `file:${TEST_CONNECTOR_CREDENTIAL_NAME}`;

/** Construction options for {@link ConnectorProviderBootstrapper}. */
export interface ConnectorProviderBootstrapperOpts {
  /** The registry providers are (un)registered on. */
  registry: ConnectorRegistry;
  /** The credential read port the provider factories resolve their key refs through. */
  credentials: CredentialProvider;
  /** Env-derived Nango settings (base URL, encryption key), re-read per reload. */
  nangoEnv: () => { baseUrl?: string; encryptionKey?: string };
  /** The Nango Proxy→MCP wrapper handed to every Nango provider instance (DOR-415). */
  nangoProxy: NangoProxyMcp;
  /** Raw-MCP server descriptors from user config (`connectors.rawMcpServers`), read at boot. */
  rawMcpServers: () => RawMcpServerDescriptor[];
  /**
   * Present only under `DORKOS_TEST_RUNTIME`: enables the `test-connector`
   * credential-gated spec. The factory builds the scripted test provider once a
   * key is saved (Slice E supplies it; until then a factory resolving `null`
   * keeps the route honest: key saved, nothing registered).
   */
  testConnector?: {
    /** Build the test provider, or `null` while its key is unconfigured. */
    create: () => Promise<ConnectorProvider | null>;
  };
  /**
   * Fired when a swap takes a previously-registered provider AWAY (credential
   * deleted, or a reload refused it). Boot wires it to drop the provider's
   * cached session attachments and (for Nango) its proxy tokens, so a deleted
   * key revokes live sessions too — not just new connections.
   */
  onUnregistered?: (providerType: string) => void;
  /**
   * Test-only client-factory passthroughs for the two vendor providers, so the
   * post-registration connection check (`_swap`'s probe) never touches the
   * network in tests. Production omits both and gets the real fetch clients.
   */
  makeComposioClient?: MaybeCreateComposioProviderDeps['makeClient'];
  /** See {@link makeComposioClient} — the Nango counterpart. */
  makeNangoClient?: MaybeCreateNangoProviderDeps['makeClient'];
}

/** One credential-gated provider the bootstrapper owns end to end. */
interface ManagedProviderSpec {
  /** The backend type (= the `:provider` route segment). */
  type: string;
  /** The log label boot/reload messages use, e.g. `'Composio managed backend'`. */
  logLabel: string;
  /** Custody stance echoed onto the status DTO. */
  custody: ConnectorCustody;
  /** The credential-store NAME (not the `file:` ref) the routes write/delete. */
  credentialName: string;
  /** Whether the provider counts as configured (credential + any required env). */
  configured(): Promise<boolean>;
  /** Run the provider factory; `null` = unconfigured, may throw a refusal. */
  create(): Promise<ConnectorProvider | null>;
  /** Whether a thrown factory error is a log-and-skip refusal (vs a genuine bug). */
  isRefusal(err: unknown): boolean;
}

/** Strip a `file:` prefix down to the credential-store name. */
function credentialNameOf(ref: string): string {
  return ref.replace(/^file:/, '');
}

/** Whether a registered provider reports which credential kind validated. */
function reportsKeyKind(provider: unknown): provider is { keyKind(): ConnectorKeyKind } {
  return (
    typeof provider === 'object' &&
    provider !== null &&
    typeof (provider as { keyKind?: unknown }).keyKind === 'function'
  );
}

/**
 * Owns connector-provider construction, registration, and live reload; see the
 * module docs for boot vs reload semantics.
 */
export class ConnectorProviderBootstrapper {
  private readonly _registry: ConnectorRegistry;
  private readonly _rawMcpServers: () => RawMcpServerDescriptor[];
  private readonly _onUnregistered: ((providerType: string) => void) | undefined;
  private readonly _specs = new Map<string, ManagedProviderSpec>();
  /** Last refusal/connection-check failure per provider type, surfaced on the status DTO. */
  private readonly _lastError = new Map<string, string>();

  /**
   * Construct the bootstrapper over its provider factories.
   *
   * @param opts - Registry, credential port, env readers, and the optional
   *   test-mode spec; see {@link ConnectorProviderBootstrapperOpts}.
   */
  constructor(opts: ConnectorProviderBootstrapperOpts) {
    this._registry = opts.registry;
    this._rawMcpServers = opts.rawMcpServers;
    this._onUnregistered = opts.onUnregistered;

    const { credentials, nangoEnv, nangoProxy } = opts;
    const specs: ManagedProviderSpec[] = [
      {
        type: 'composio',
        logLabel: 'Composio managed backend',
        custody: 'managed',
        credentialName: credentialNameOf(COMPOSIO_API_KEY_REF),
        configured: async () => (await credentials.resolve(COMPOSIO_API_KEY_REF)).ok,
        create: () =>
          maybeCreateComposioProvider({
            credentials,
            ...(opts.makeComposioClient && { makeClient: opts.makeComposioClient }),
          }),
        isRefusal: () => false,
      },
      {
        type: 'nango',
        logLabel: 'Nango self-host backend',
        custody: 'self-host',
        credentialName: credentialNameOf(NANGO_SECRET_KEY_REF),
        configured: async () =>
          (await credentials.resolve(NANGO_SECRET_KEY_REF)).ok && Boolean(nangoEnv().baseUrl),
        create: () => {
          const env = nangoEnv();
          return maybeCreateNangoProvider({
            credentials,
            proxy: nangoProxy,
            ...(env.baseUrl !== undefined && { baseUrl: env.baseUrl }),
            ...(env.encryptionKey !== undefined && { encryptionKey: env.encryptionKey }),
            ...(opts.makeNangoClient && { makeClient: opts.makeNangoClient }),
          });
        },
        // Configured-but-unsafe refuses loudly and is skipped; the server boots.
        isRefusal: (err) => err instanceof NangoEncryptionKeyError,
      },
    ];
    if (opts.testConnector) {
      const { create } = opts.testConnector;
      specs.push({
        type: TEST_CONNECTOR_PROVIDER_TYPE,
        logLabel: 'Test connector backend',
        custody: 'managed',
        credentialName: TEST_CONNECTOR_CREDENTIAL_NAME,
        configured: async () => (await credentials.resolve(TEST_CONNECTOR_API_KEY_REF)).ok,
        create,
        isRefusal: () => false,
      });
    }
    for (const spec of specs) this._specs.set(spec.type, spec);
  }

  /**
   * The credential-store name for a provider type, or `undefined` for a type
   * this bootstrapper does not own — the credential routes' single validity
   * check (so `test-connector` is accepted exactly when its spec exists).
   *
   * @param provider - The `:provider` route segment.
   */
  credentialNameFor(provider: string): string | undefined {
    return this._specs.get(provider)?.credentialName;
  }

  /**
   * Boot registration: raw-MCP always; each credential-gated provider when
   * configured. Same semantics as the old inline `index.ts` block, moved here.
   */
  async registerBootProviders(): Promise<void> {
    // The raw-MCP baseline registers unconditionally — with the empty list too,
    // so the seam is live before anyone configures a server (gap 3).
    this._registry.register(new RawMcpConnectorProvider({ servers: this._rawMcpServers() }));
    for (const spec of this._specs.values()) {
      await this._swap(spec);
    }
  }

  /**
   * Re-run one provider's factory and swap its registration atomically:
   * unregister-if-present → `maybeCreate*` → connection check →
   * register-if-it-answers. Called by the credential routes after a key
   * write/delete; no restart ever required. A factory or connection-check
   * failure never throws — it lands on the returned status as `error` with
   * `registered: false`, so a wrong key answers the PUT honestly instead of
   * 500ing.
   *
   * @param provider - A provider type this bootstrapper owns.
   * @returns The provider's fresh status.
   * @throws If `provider` is unknown.
   */
  async reload(provider: string): Promise<ConnectorProviderStatus> {
    const spec = this._specs.get(provider);
    if (!spec) {
      throw new Error(`Unknown connector provider '${provider}'.`);
    }
    await this._swap(spec);
    return this._statusFor(spec);
  }

  /** The setup status of every credential-gated provider, for `GET /providers`. */
  async listStatuses(): Promise<ConnectorProviderStatus[]> {
    return Promise.all([...this._specs.values()].map((spec) => this._statusFor(spec)));
  }

  /** Unregister → create → probe → register-if-it-answers, recording any failure. */
  private async _swap(spec: ManagedProviderSpec): Promise<void> {
    const wasRegistered = this._registry.resolveProvider(spec.type) !== undefined;
    this._registry.unregister(spec.type);
    this._lastError.delete(spec.type);
    try {
      const provider = await spec.create();
      if (provider) {
        // "Registered" must mean "actually answers", not "a key is stored":
        // probe with the cheapest authenticated read before registering. First
        // real contact (DOR-703) showed a wrong-kind API key passing the
        // credential gate and 401ing on every call — without this check the
        // card said Ready over a dead service grid. The failure message
        // (Composio's own, secret-free) lands on the status DTO instead.
        await provider.listAccounts();
        this._registry.register(provider);
        logger.info(`[Connectors] ${spec.logLabel} registered`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (spec.isRefusal(err)) {
        logger.error(`[Connectors] ${spec.logLabel} refused: ${message}`);
        this._lastError.set(spec.type, message);
      } else {
        // The connection check failed (or the factory hit a transport error).
        // Record it and leave the provider unregistered — a key re-save
        // re-probes; the server keeps booting either way.
        logger.error(`[Connectors] ${spec.logLabel} failed its connection check: ${message}`);
        this._lastError.set(spec.type, message);
      }
    } finally {
      // A swap that took a live provider AWAY revokes what it was serving:
      // cached session attachments (and, for Nango, proxy tokens) must not keep
      // running on a credential the operator just deleted.
      if (wasRegistered && this._registry.resolveProvider(spec.type) === undefined) {
        this._onUnregistered?.(spec.type);
      }
    }
  }

  /** Build one provider's reference-free status DTO. */
  private async _statusFor(spec: ManagedProviderSpec): Promise<ConnectorProviderStatus> {
    const error = this._lastError.get(spec.type);
    const live = this._registry.resolveProvider(spec.type);
    // Which credential kind validated (Composio has two, with different auth
    // headers) — a fact the card states, never a secret or a reference.
    const keyKind = live !== undefined && reportsKeyKind(live) ? live.keyKind() : undefined;
    return {
      type: spec.type,
      configured: await spec.configured(),
      registered: live !== undefined,
      custody: spec.custody,
      ...(keyKind !== undefined && { keyKind }),
      // Managed custody reuses the ADR-canonical sentence verbatim; other
      // stances render their service-independent disclosure copy. Copy stays
      // server-owned either way (custody-disclosure module).
      disclosure:
        spec.custody === 'managed'
          ? MANAGED_CUSTODY_CANONICAL_SENTENCE
          : custodyDisclosure(spec.custody, { service: spec.logLabel }),
      ...(error !== undefined && { error }),
    };
  }
}
