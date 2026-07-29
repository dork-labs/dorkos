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
 * register-if-non-null), so saving a vendor key through
 * `PUT /api/connectors/providers/:provider/credential` registers the provider
 * live and deleting it unregisters — no restart ever required.
 *
 * Under `DORKOS_TEST_RUNTIME` a third credential-gated spec, `test-connector`,
 * joins the set so e2e can exercise the save-key step end to end; its factory
 * is injected (Slice E supplies the real scripted provider).
 *
 * @module services/connectors/bootstrap
 */
import type {
  ConnectorCustody,
  ConnectorProvider,
  ConnectorProviderStatus,
} from '@dorkos/shared/connector-provider';
import { logger } from '../../lib/logger.js';
import type { CredentialProvider } from '../core/credential-provider.js';
import { custodyDisclosure, MANAGED_CUSTODY_CANONICAL_SENTENCE } from './custody-disclosure.js';
import type { ConnectorRegistry } from './registry.js';
import { maybeCreateComposioProvider, COMPOSIO_API_KEY_REF } from './providers/composio.js';
import {
  maybeCreateNangoProvider,
  NangoEncryptionKeyError,
  NANGO_SECRET_KEY_REF,
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

/**
 * Owns connector-provider construction, registration, and live reload; see the
 * module docs for boot vs reload semantics.
 */
export class ConnectorProviderBootstrapper {
  private readonly _registry: ConnectorRegistry;
  private readonly _rawMcpServers: () => RawMcpServerDescriptor[];
  private readonly _specs = new Map<string, ManagedProviderSpec>();
  /** Last refusal message per provider type, surfaced on the status DTO. */
  private readonly _lastRefusal = new Map<string, string>();

  /**
   * Construct the bootstrapper over its provider factories.
   *
   * @param opts - Registry, credential port, env readers, and the optional
   *   test-mode spec; see {@link ConnectorProviderBootstrapperOpts}.
   */
  constructor(opts: ConnectorProviderBootstrapperOpts) {
    this._registry = opts.registry;
    this._rawMcpServers = opts.rawMcpServers;

    const { credentials, nangoEnv, nangoProxy } = opts;
    const specs: ManagedProviderSpec[] = [
      {
        type: 'composio',
        logLabel: 'Composio managed backend',
        custody: 'managed',
        credentialName: credentialNameOf(COMPOSIO_API_KEY_REF),
        configured: async () => (await credentials.resolve(COMPOSIO_API_KEY_REF)).ok,
        create: () => maybeCreateComposioProvider({ credentials }),
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
   * unregister-if-present → `maybeCreate*` → register-if-non-null. Called by
   * the credential routes after a key write/delete; no restart ever required.
   *
   * @param provider - A provider type this bootstrapper owns.
   * @returns The provider's fresh status.
   * @throws If `provider` is unknown, or the factory failed with a non-refusal error.
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

  /** Unregister → create → register-if-non-null, recording any refusal. */
  private async _swap(spec: ManagedProviderSpec): Promise<void> {
    this._registry.unregister(spec.type);
    this._lastRefusal.delete(spec.type);
    try {
      const provider = await spec.create();
      if (provider) {
        this._registry.register(provider);
        logger.info(`[Connectors] ${spec.logLabel} registered`);
      }
    } catch (err) {
      if (spec.isRefusal(err)) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[Connectors] ${spec.logLabel} refused: ${message}`);
        this._lastRefusal.set(spec.type, message);
        return;
      }
      throw err;
    }
  }

  /** Build one provider's reference-free status DTO. */
  private async _statusFor(spec: ManagedProviderSpec): Promise<ConnectorProviderStatus> {
    const error = this._lastRefusal.get(spec.type);
    return {
      type: spec.type,
      configured: await spec.configured(),
      registered: this._registry.resolveProvider(spec.type) !== undefined,
      custody: spec.custody,
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
