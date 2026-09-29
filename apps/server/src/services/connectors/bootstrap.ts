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
 * **A way that stops answering comes back by itself.** A check that failed for
 * a reason that can pass (no answer, a timeout, a 5xx) is re-run on its own,
 * waiting longer after each failure in a row ({@link WAY_RECHECK_DELAYS_MS});
 * once those run out it stops, and the person is offered the one fix
 * (checking it again, or fixing the key). A refused key (401/403), a link the
 * DorkOS account refuses, or a refused setup waits for the person at once.
 * While a check runs, {@link ConnectorProviderBootstrapper.wayHealth} says
 * so, and readiness shows a wait rather than a fix that isn't needed yet.
 * {@link ConnectorProviderBootstrapper.nextWayCheckAt} says when the next
 * automatic check is due. A registered way whose periodic account listing
 * fails is checked again at once
 * ({@link ConnectorProviderBootstrapper.recheckWay}) and taken down only if it
 * still does not answer. Every successful check lists the way's
 * accounts, so it also records each kept account's sign-in status.
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
  ProviderConnectedAccount,
} from '@dorkos/shared/connector-provider';
import type {
  ConnectorAppConnections,
  ConnectorAppWay,
} from '@dorkos/shared/connector-resource-schemas';
import { logger } from '../../lib/logger.js';
import { ManagedConnectorCloudError } from '../core/auth/cloud-link-client.js';
import {
  chooseNewAppsWay,
  signInThroughFor,
  wayProblemFor,
  type ConnectorWayProblem,
} from './app-connection-way.js';
import {
  keyCanFixActions,
  wayHealthOf,
  type ConnectionWayHealth,
} from './readiness/connection-readiness.js';
import type { CredentialProvider } from '../core/credential-provider.js';
import { custodyDisclosure, MANAGED_CUSTODY_CANONICAL_SENTENCE } from './custody-disclosure.js';
import type { ConnectorRegistry } from './registry.js';
import type { ClosedConnection } from './connection-store.js';
import {
  legacyDefaultProviderInstanceId,
  type ConnectorMigrationResult,
} from './legacy-connection-migration.js';
import { connectorExecutionConfigDigest } from './execution/execution-config.js';
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
import { MANAGED_CLOUD_PROVIDER_TYPE } from './providers/managed/managed-cloud.js';
import {
  RawMcpConnectorProvider,
  type RawMcpServerDescriptor,
  type RawMcpPendingConnectResolver,
} from './providers/raw-mcp.js';
import { TEST_CONNECTOR_PROVIDER_TYPE } from './connection-store.js';

/**
 * The test-mode provider type the credential route accepts under
 * `DORKOS_TEST_RUNTIME` — re-exported for every consumer that already imports
 * it from here (`test-mode.ts`, `index.ts`). Defined in `connection-store.js`,
 * the lower layer that enforces it as a purge guard
 * ({@link ConnectionStore.purgeTestConnectorConnections}).
 */
export { TEST_CONNECTOR_PROVIDER_TYPE };

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
  /** Owner-scoped signing reference, read privately whenever Composio is reloaded. */
  composioWebhookSecretRef?: () => string | undefined;
  /** Env-derived Nango settings (base URL, encryption key), re-read per reload. */
  nangoEnv: () => { baseUrl?: string; encryptionKey?: string };
  /** Raw-MCP server descriptors from user config (`connectors.rawMcpServers`), read at boot. */
  rawMcpServers: () => RawMcpServerDescriptor[];
  /** Canonical owner/generation admission for restart-safe raw MCP polls. */
  rawMcpPendingConnect: RawMcpPendingConnectResolver;
  /** Hosted managed provider backed by the current linked-instance token. */
  managedCloud?: {
    /** Stable provider instance registered for every valid linked key. */
    instanceId: ConnectorProvider['instanceId'];
    /** Whether a linked-instance key is currently present. */
    configured: () => boolean;
    /** Hash of the current key material, never the token itself. */
    executionConfigDigest: () => string | undefined;
    /** Construct the tokenless provider adapter. */
    create: () => ConnectorProvider;
  };
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
   * Told about the kept accounts closed because the DorkOS account was linked
   * again with a different link that does not list them. Boot records one
   * Activity entry per account.
   */
  onClosedByNewLink?: (closed: readonly ClosedConnection[]) => void;
  /**
   * Told when the DorkOS account's route registered under a link it hadn't
   * worked through before (the account was linked again). The accounts that
   * link still lists keep the access they were given; this is where what the
   * old link refused or never applied is sent again.
   */
  onRelinked?: (providerInstanceId: ConnectorProvider['instanceId']) => void;
  /**
   * Test-only client-factory passthroughs for the two vendor providers, so the
   * post-registration connection check (`_swap`'s probe) never touches the
   * network in tests. Production omits both and gets the real fetch clients.
   */
  makeComposioClient?: MaybeCreateComposioProviderDeps['makeClient'];
  /** Private offline test upstream; production leaves the real vendor origin intact. */
  composioBaseUrl?: string;
  /** See {@link makeComposioClient} — the Nango counterpart. */
  makeNangoClient?: MaybeCreateNangoProviderDeps['makeClient'];
}

/** One credential-gated provider the bootstrapper owns end to end. */
interface ManagedProviderSpec {
  /** The backend type (= the `:provider` route segment). */
  type: string;
  /** Exact default instance owned by this legacy type-scoped configuration. */
  defaultInstanceId: ConnectorProvider['instanceId'];
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

/**
 * How long a way that failed its check waits before the next automatic check,
 * one entry per failure in a row. Short at first so a blip clears in seconds,
 * and no more often than the periodic sign-in refresh once an outage lasts.
 * After the last one DorkOS stops checking on its own: a way that hasn't
 * answered for about 25 minutes settles on the person's one fix. A failed
 * listing seen by the periodic sign-in refresh starts the count again.
 */
export const WAY_RECHECK_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 900_000] as const;

/**
 * Whether a failed check means the service refused the key itself (HTTP 401
 * or 403). That never passes on its own, so it is not re-checked
 * automatically; the person saves a working key. Anything else (no answer, a
 * timeout, a 5xx, a rate limit) can, so it is.
 */
function isCredentialRefusal(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

/**
 * Whether the DorkOS account refused the link itself: its credential is not
 * accepted, or it needs a permission the owner must grant by linking again.
 * Only those wait for the owner. A plain refused request (even a 403) or a
 * network failure can pass, so the way is re-checked.
 */
function isLinkRefusal(err: unknown): boolean {
  return (
    err instanceof ManagedConnectorCloudError &&
    (err.code === 'unauthorized' || err.code === 'permission_upgrade_required')
  );
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

/** Read a provider-confined digest without learning or re-resolving its construction secrets. */
function providerExecutionConfigDigest(provider: ConnectorProvider): string | undefined {
  const digest = (provider as ConnectorProvider & { readonly executionConfigDigest?: unknown })
    .executionConfigDigest;
  return typeof digest === 'string' && digest.length > 0 ? digest : undefined;
}

/** Hash only raw-MCP fields that can change the server reached during execution. */
function rawMcpExecutionConfigDigest(
  provider: ConnectorProvider,
  servers: RawMcpServerDescriptor[]
): string {
  return connectorExecutionConfigDigest({
    provider: provider.type,
    instanceId: provider.instanceId,
    servers: servers
      .map((server) => ({
        slug: server.slug,
        authKind: server.authKind ?? 'none',
        connection: server.connection,
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug)),
  });
}

/**
 * Owns connector-provider construction, registration, and live reload; see the
 * module docs for boot vs reload semantics.
 */
export class ConnectorProviderBootstrapper {
  private readonly _registry: ConnectorRegistry;
  private readonly _rawMcpServers: () => RawMcpServerDescriptor[];
  private readonly _rawMcpPendingConnect: RawMcpPendingConnectResolver;
  private readonly _specs = new Map<string, ManagedProviderSpec>();
  private readonly _managedCloud: ConnectorProviderBootstrapperOpts['managedCloud'];
  private readonly _onClosedByNewLink: ConnectorProviderBootstrapperOpts['onClosedByNewLink'];
  private readonly _onRelinked: ConnectorProviderBootstrapperOpts['onRelinked'];
  /** Ways being checked right now (spec type, or the DorkOS account's type). */
  private readonly _checking = new Set<string>();
  private _managedCloudReload: Promise<void> = Promise.resolve();
  private _managedCloudRecovery: Promise<void> | undefined;
  private readonly _instanceBySpecType = new Map<string, ConnectorProvider['instanceId']>();
  /** Last refusal/connection-check failure per provider type, surfaced on the status DTO. */
  private readonly _lastError = new Map<string, string>();
  /** Swaps and re-checks per own-key way, run one after another. */
  private readonly _wayQueues = new Map<string, Promise<void>>();
  /** The waiting automatic check per way (spec type, or the DorkOS account's type). */
  private readonly _rechecks = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; dueAt: number }
  >();
  /** Failed checks in a row per way, which sets how long the next one waits. */
  private readonly _consecutiveFailures = new Map<string, number>();
  private _stopped = false;

  /**
   * Construct the bootstrapper over its provider factories.
   *
   * @param opts - Registry, credential port, env readers, and the optional
   *   test-mode spec; see {@link ConnectorProviderBootstrapperOpts}.
   */
  constructor(opts: ConnectorProviderBootstrapperOpts) {
    this._registry = opts.registry;
    this._rawMcpServers = opts.rawMcpServers;
    this._rawMcpPendingConnect = opts.rawMcpPendingConnect;
    this._managedCloud = opts.managedCloud;
    this._onClosedByNewLink = opts.onClosedByNewLink;
    this._onRelinked = opts.onRelinked;

    const { credentials, nangoEnv } = opts;
    const specs: ManagedProviderSpec[] = [
      {
        type: 'composio',
        defaultInstanceId: legacyDefaultProviderInstanceId(
          'composio'
        ) as ConnectorProvider['instanceId'],
        logLabel: 'Composio managed backend',
        custody: 'managed',
        credentialName: credentialNameOf(COMPOSIO_API_KEY_REF),
        configured: async () => (await credentials.resolve(COMPOSIO_API_KEY_REF)).ok,
        create: () =>
          maybeCreateComposioProvider({
            credentials,
            webhookSecretRef: opts.composioWebhookSecretRef?.(),
            ...(opts.composioBaseUrl && { baseUrl: opts.composioBaseUrl }),
            ...(opts.makeComposioClient && { makeClient: opts.makeComposioClient }),
          }),
        isRefusal: () => false,
      },
      {
        type: 'nango',
        defaultInstanceId: legacyDefaultProviderInstanceId(
          'nango'
        ) as ConnectorProvider['instanceId'],
        logLabel: 'Nango self-host backend',
        custody: 'self-host',
        credentialName: credentialNameOf(NANGO_SECRET_KEY_REF),
        configured: async () =>
          (await credentials.resolve(NANGO_SECRET_KEY_REF)).ok && Boolean(nangoEnv().baseUrl),
        create: () => {
          const env = nangoEnv();
          return maybeCreateNangoProvider({
            credentials,
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
        defaultInstanceId: legacyDefaultProviderInstanceId(
          TEST_CONNECTOR_PROVIDER_TYPE
        ) as ConnectorProvider['instanceId'],
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

  /** Connector source-of-truth health used to stop provider writes after a failed backfill. */
  migrationHealth(): ConnectorMigrationResult {
    return this._registry.migrationHealth();
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
    const rawMcpServers = this._rawMcpServers();
    const rawMcpProvider = new RawMcpConnectorProvider({
      servers: rawMcpServers,
      resolvePendingConnect: this._rawMcpPendingConnect,
    });
    this._registry.register(
      rawMcpProvider,
      rawMcpExecutionConfigDigest(rawMcpProvider, rawMcpServers),
      'byo'
    );
    for (const spec of this._specs.values()) {
      this._clearRecheck(spec.type);
      await this._queueSwap(spec);
    }
    await this.reloadManagedCloud();
  }

  /** Reconcile the hosted managed provider with the current linked-instance key. */
  reloadManagedCloud(): Promise<void> {
    const reload = this._managedCloudReload.then(() =>
      this._checkingWhile(MANAGED_CLOUD_PROVIDER_TYPE, () => this._reloadManagedCloud())
    );
    this._managedCloudReload = reload.catch(() => {});
    return reload;
  }

  /**
   * Restore an absent hosted provider after a transient startup failure.
   *
   * Unlike {@link reloadManagedCloud}, this path never removes a live provider.
   * Concurrent catalog reads share one probe, and the linked-key digest is
   * revalidated after the probe so an unlinked or rotated key cannot register a
   * provider created from stale state.
   */
  recoverManagedCloud(): Promise<void> {
    if (this._managedCloudRecovery) return this._managedCloudRecovery;
    const recovery = this._managedCloudReload.then(() =>
      this._checkingWhile(MANAGED_CLOUD_PROVIDER_TYPE, () => this._recoverManagedCloud())
    );
    this._managedCloudReload = recovery.catch(() => {});
    const sharedRecovery = recovery.finally(() => {
      if (this._managedCloudRecovery === sharedRecovery) this._managedCloudRecovery = undefined;
    });
    this._managedCloudRecovery = sharedRecovery;
    return sharedRecovery;
  }

  private async _recoverManagedCloud(): Promise<void> {
    const managed = this._managedCloud;
    if (!managed) return;
    if (this._registry.resolveProviderInstance(managed.instanceId)) {
      this._clearRecheck(MANAGED_CLOUD_PROVIDER_TYPE);
      return;
    }
    const expectedDigest = managed.executionConfigDigest();
    if (!managed.configured() || !expectedDigest) {
      this._clearRecheck(MANAGED_CLOUD_PROVIDER_TYPE);
      return;
    }
    try {
      const provider = managed.create();
      const listingStartedAt = new Date().toISOString();
      const accounts = await provider.listAccounts();
      if (
        !managed.configured() ||
        managed.executionConfigDigest() !== expectedDigest ||
        this._registry.resolveProviderInstance(managed.instanceId)
      ) {
        return;
      }
      // A reload whose listing failed leaves the new link to this recovery,
      // so the same gated close runs here too.
      this._registerManaged(provider, expectedDigest, accounts, listingStartedAt);
      logger.info('[Connectors] DorkOS managed provider recovered');
    } catch (error) {
      logger.error(
        `[Connectors] DorkOS managed provider recovery check failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this._managedWayFailed(error);
    }
  }

  private async _reloadManagedCloud(): Promise<void> {
    const managed = this._managedCloud;
    if (!managed) return;
    // A reload is a fresh start: it replaces any re-check still waiting.
    this._clearRecheck(MANAGED_CLOUD_PROVIDER_TYPE);
    this._registry.unregisterProviderInstance(managed.instanceId);
    try {
      if (!managed.configured()) return;
      const provider = managed.create();
      const listingStartedAt = new Date().toISOString();
      const accounts = await provider.listAccounts();
      this._registerManaged(provider, managed.executionConfigDigest(), accounts, listingStartedAt);
      logger.info('[Connectors] DorkOS managed provider registered');
    } catch (error) {
      logger.error(
        `[Connectors] DorkOS managed provider failed its connection check: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this._managedWayFailed(error);
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
    // A key saved or removed is a fresh start: it replaces any re-check waiting.
    this._clearRecheck(spec.type);
    await this._queueSwap(spec);
    return this._statusFor(spec);
  }

  /**
   * Check again, now, a way whose account listing just failed while it was
   * registered (the periodic sign-in refresh reports it). If the service
   * answers this time the way stays as it is and the listing's sign-in facts
   * are recorded; if not, the way is taken down so nothing reads it as
   * working, and re-checked on its own with a growing wait until it answers
   * again. A refused key or setup is not re-checked: the person fixes it.
   *
   * @param providerInstanceId - The registered instance whose listing failed.
   */
  recheckWay(providerInstanceId: ConnectorProvider['instanceId']): Promise<void> {
    const managed = this._managedCloud;
    if (managed?.instanceId === providerInstanceId) {
      const recheck = this._managedCloudReload.then(() =>
        this._checkingWhile(MANAGED_CLOUD_PROVIDER_TYPE, () => this._recheckLiveManaged())
      );
      this._managedCloudReload = recheck.catch(() => {});
      return recheck;
    }
    const spec = [...this._specs.values()].find(
      (candidate) => this._instanceBySpecType.get(candidate.type) === providerInstanceId
    );
    if (!spec) return Promise.resolve();
    return this._queue(spec.type, () =>
      this._checkingWhile(spec.type, () => this._recheckLiveOwnKey(spec))
    );
  }

  /**
   * When DorkOS will next check, on its own, a way that failed its last check
   * for a reason that can pass (see {@link WAY_RECHECK_DELAYS_MS}). Connection
   * readiness (DOR-2500, landing right after this) reads it to show "DorkOS
   * will try again at …" beside a way that is down. `undefined` when
   * no automatic check is waiting: the way answered, is not set up, or its key
   * was refused and waits for the owner.
   *
   * @param providerInstanceId - The instance the way registers as (the DorkOS
   *   account's instance, or an own-key way's live or default instance).
   * @returns The ISO-8601 time of the next automatic check, or `undefined`.
   */
  nextWayCheckAt(providerInstanceId: string): string | undefined {
    const key = this._wayKey(providerInstanceId);
    const dueAt = key === undefined ? undefined : this._rechecks.get(key)?.dueAt;
    return dueAt === undefined ? undefined : new Date(dueAt).toISOString();
  }

  /** The way an instance registers as: its spec type, or the DorkOS account's. */
  private _wayKey(providerInstanceId: string): string | undefined {
    return this._managedCloud?.instanceId === providerInstanceId
      ? MANAGED_CLOUD_PROVIDER_TYPE
      : [...this._specs.values()].find(
          (spec) =>
            spec.defaultInstanceId === providerInstanceId ||
            this._instanceBySpecType.get(spec.type) === providerInstanceId
        )?.type;
  }

  /** Run one way's check, saying it is being checked while it runs. */
  private async _checkingWhile(key: string, check: () => Promise<void>): Promise<void> {
    this._checking.add(key);
    try {
      await check();
    } finally {
      this._checking.delete(key);
    }
  }

  /** Stop every waiting re-check; nothing is scheduled after this. */
  stop(): void {
    this._stopped = true;
    for (const { timer } of this._rechecks.values()) clearTimeout(timer);
    this._rechecks.clear();
    this._consecutiveFailures.clear();
    this._checking.clear();
  }

  private async _recheckLiveOwnKey(spec: ManagedProviderSpec): Promise<void> {
    const instanceId = this._instanceBySpecType.get(spec.type);
    const live = instanceId ? this._registry.resolveProviderInstance(instanceId) : undefined;
    if (!instanceId || !live) return;
    const listingStartedAt = new Date().toISOString();
    try {
      this._registry.recordSignInStatus(live, await live.listAccounts(), listingStartedAt);
    } catch (err) {
      // Replaced while the check ran: the newer registration speaks for itself.
      if (this._registry.resolveProviderInstance(instanceId) !== live) return;
      const message = err instanceof Error ? err.message : String(err);
      this._registry.unregisterProviderInstance(instanceId);
      this._instanceBySpecType.delete(spec.type);
      this._lastError.set(spec.type, message);
      logger.error(`[Connectors] ${spec.logLabel} stopped answering: ${message}`);
      this._ownKeyWayFailed(spec, err);
    }
  }

  private async _recheckLiveManaged(): Promise<void> {
    const managed = this._managedCloud;
    const live = managed ? this._registry.resolveProviderInstance(managed.instanceId) : undefined;
    if (!managed || !live) return;
    const listingStartedAt = new Date().toISOString();
    try {
      this._registry.recordSignInStatus(live, await live.listAccounts(), listingStartedAt);
    } catch (error) {
      if (this._registry.resolveProviderInstance(managed.instanceId) !== live) return;
      this._registry.unregisterProviderInstance(managed.instanceId);
      logger.error(
        `[Connectors] DorkOS managed provider stopped answering: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this._managedWayFailed(error);
    }
  }

  /** An own-key way failed its check: re-check it later unless the key itself was refused. */
  private _ownKeyWayFailed(spec: ManagedProviderSpec, err: unknown): void {
    if (isCredentialRefusal(err)) {
      this._clearRecheck(spec.type);
      return;
    }
    this._wayFailed(spec.type, () => this._queueSwap(spec));
  }

  /**
   * The DorkOS account's way failed its check: re-check it later while it is
   * still linked, unless the account refused the link itself.
   */
  private _managedWayFailed(err: unknown): void {
    if (!this._managedCloud?.configured() || isLinkRefusal(err)) {
      this._clearRecheck(MANAGED_CLOUD_PROVIDER_TYPE);
      return;
    }
    this._wayFailed(MANAGED_CLOUD_PROVIDER_TYPE, () => this.recoverManagedCloud());
  }

  /**
   * Schedule one way's next automatic check, waiting longer after each failure
   * in a row ({@link WAY_RECHECK_DELAYS_MS}). Once those run out, nothing more
   * is scheduled: the way settles on the person's one fix, and a check they
   * start (or a periodic listing that fails again later) begins a fresh count.
   * A check already waiting is left alone, so a failure seen by some other
   * read never pushes it later.
   */
  private _wayFailed(key: string, recheck: () => Promise<void>): void {
    if (this._stopped || this._rechecks.has(key)) return;
    const failures = (this._consecutiveFailures.get(key) ?? 0) + 1;
    if (failures > WAY_RECHECK_DELAYS_MS.length) {
      this._consecutiveFailures.delete(key);
      return;
    }
    this._consecutiveFailures.set(key, failures);
    const delay = WAY_RECHECK_DELAYS_MS[failures - 1]!;
    const timer = setTimeout(() => {
      this._rechecks.delete(key);
      void recheck().catch((err: unknown) =>
        logger.warn('[Connectors] Automatic way check failed', { key, err: String(err) })
      );
    }, delay);
    timer.unref();
    this._rechecks.set(key, { timer, dueAt: Date.now() + delay });
  }

  /** The way answered, or needs the person: forget its failures and any waiting check. */
  private _clearRecheck(key: string): void {
    const waiting = this._rechecks.get(key);
    if (waiting) clearTimeout(waiting.timer);
    this._rechecks.delete(key);
    this._consecutiveFailures.delete(key);
  }

  /** The setup status of every credential-gated provider, for `GET /providers`. */
  async listStatuses(): Promise<ConnectorProviderStatus[]> {
    return Promise.all([...this._specs.values()].map((spec) => this._statusFor(spec)));
  }

  /**
   * Every way the person has set up to reach apps, and the one new apps use
   * ({@link chooseNewAppsWay}). A way is ready while its route is registered
   * (it answered its last check) and its provider reports sign-in available at
   * the provider level; a key that failed its check is set up but unavailable.
   * Today every real provider reports sign-in available, so that second half
   * only bites for a provider that says otherwise. Whether one particular app
   * can be signed in to is a per-route fact the client reads from the catalog
   * route's own authentication status (`needsFirstConnectStep`).
   */
  async appConnections(): Promise<ConnectorAppConnections> {
    const ways: ConnectorAppWay[] = [];
    for (const spec of this._specs.values()) {
      if (!(await spec.configured())) continue;
      const instanceId = this._instanceBySpecType.get(spec.type);
      const live = instanceId ? this._registry.resolveProviderInstance(instanceId) : undefined;
      ways.push(this._way('own_key', spec.type, live));
    }
    const managed = this._managedCloud;
    if (managed?.configured()) {
      ways.push(
        this._way(
          'dorkos_account',
          MANAGED_CLOUD_PROVIDER_TYPE,
          this._registry.resolveProviderInstance(managed.instanceId)
        )
      );
    } else if (managed && this._registry.hasLiveConnections(managed.instanceId)) {
      // No longer linked (by the person, or ended from the account's side)
      // while apps connected through it are still kept: say that, rather than
      // "nothing set up". Linking this computer again with the same account can
      // bring them back: a continued link lists them again (DOR-2521).
      ways.push({
        ...this._way('dorkos_account', MANAGED_CLOUD_PROVIDER_TYPE, undefined),
        status: 'unlinked',
      });
    }
    return { ways, newApps: chooseNewAppsWay(ways) };
  }

  /**
   * Whether the way a connected account goes through is working, and when it
   * is not, which fix brings the account back ({@link wayProblemFor}).
   *
   * @param providerInstanceId - The instance the account was connected through.
   */
  wayProblem(providerInstanceId: string): ConnectorWayProblem | undefined {
    const managed = this._managedCloud;
    const ownKey = [...this._specs.values()].some(
      (spec) =>
        spec.defaultInstanceId === providerInstanceId ||
        this._instanceBySpecType.get(spec.type) === providerInstanceId
    );
    // Only a way this server sets up has a fix to name. Anything else (a raw
    // MCP server dropped from config) says nothing rather than something wrong.
    if (!ownKey && managed?.instanceId !== providerInstanceId) return undefined;
    return wayProblemFor({
      registered:
        this._registry.resolveProviderInstance(
          providerInstanceId as ConnectorProvider['instanceId']
        ) !== undefined,
      managed: managed?.instanceId === providerInstanceId,
      managedLinked: managed?.configured() === true,
    });
  }

  /**
   * The live health of the way one account goes through, as readiness reads
   * it ({@link ConnectionWayHealth}): down with its fix when its route isn't
   * registered, or up, and whether agents can act through it.
   *
   * @param providerInstanceId - The instance the account was connected through.
   * @param toolkit - The account's app, which another way has to reach to count.
   */
  wayHealth(providerInstanceId: string, toolkit: string): ConnectionWayHealth {
    return wayHealthOf(
      this._registry.resolveProviderInstance(providerInstanceId as ConnectorProvider['instanceId']),
      () => this.wayProblem(providerInstanceId),
      () => this._anotherWayWorks(providerInstanceId, toolkit),
      () => {
        const key = this._wayKey(providerInstanceId);
        const nextCheckAt = this.nextWayCheckAt(providerInstanceId);
        return {
          ...(key !== undefined && this._checking.has(key) && { checking: true }),
          ...(nextCheckAt !== undefined && { nextCheckAt }),
        };
      }
    );
  }

  /**
   * Whether a way other than this one answers, can both sign in to apps and
   * run their actions, and reaches this very app, so connecting the app again
   * through it would help. A way whose app list isn't known yet doesn't count.
   */
  private _anotherWayWorks(providerInstanceId: string, toolkit: string): boolean {
    const instances = [
      ...this._instanceBySpecType.values(),
      ...(this._managedCloud ? [this._managedCloud.instanceId] : []),
    ];
    return instances.some((instanceId) => {
      if (instanceId === providerInstanceId) return false;
      const capabilities = this._registry
        .resolveProviderInstance(instanceId as ConnectorProvider['instanceId'])
        ?.getCapabilities().capabilities;
      return (
        capabilities?.authentication.status === 'available' &&
        capabilities.execution.status === 'available' &&
        this._registry.reachesApp(instanceId as ConnectorProvider['instanceId'], toolkit)
      );
    });
  }

  /** A ready way's instance, whether it runs actions and, if not, whether a key would fix it. */
  private _wayActions(
    ready: ConnectorProvider
  ): Pick<ConnectorAppWay, 'providerInstanceId' | 'canRunActions' | 'keyCanFix'> {
    const canRunActions = ready.getCapabilities().capabilities.execution.status === 'available';
    return {
      providerInstanceId: ready.instanceId,
      canRunActions,
      ...(!canRunActions && { keyCanFix: keyCanFixActions(ready) }),
    };
  }

  private _way(
    kind: ConnectorAppWay['kind'],
    type: string,
    live: ConnectorProvider | undefined
  ): ConnectorAppWay {
    const signInThrough = signInThroughFor(type);
    const ready =
      live?.getCapabilities().capabilities.authentication.status === 'available' ? live : undefined;
    return {
      kind,
      type,
      status: ready ? 'ready' : 'unavailable',
      ...(ready && this._wayActions(ready)),
      ...(signInThrough !== undefined && { signInThrough }),
    };
  }

  /**
   * Register the DorkOS account's route from a listing that succeeded in full,
   * and when the link changed since the route last worked, close the kept
   * accounts that listing does not have.
   */
  private _registerManaged(
    provider: ConnectorProvider,
    digest: string | undefined,
    accounts: readonly ProviderConnectedAccount[],
    listingStartedAt: string
  ): void {
    // Read before registering, which overwrites it: the fingerprint of the
    // link this instance last worked through, kept across unlinking and
    // restarts. None stored means a first registration, which closes nothing.
    const previousDigest = this._registry.storedExecutionConfigDigest(provider.instanceId);
    const relinked =
      previousDigest !== undefined && digest !== undefined && previousDigest !== digest;
    // The same account, still listed by the new link, keeps the access it was
    // given: linking again is not a reason to ask the owner to review it.
    this._registry.register(provider, digest, 'managed', {
      ...(relinked && {
        keepAccessFor: new Set(accounts.map((account) => account.externalAccountRef)),
      }),
    });
    this._clearRecheck(MANAGED_CLOUD_PROVIDER_TYPE);
    // A changed key fingerprint may be a new link or a continued one (the same
    // link with a replaced key, DOR-2521). Either way only the accounts this
    // full listing lacks are closed, so a continued link keeps its accounts.
    if (relinked) {
      this._closeUnlistedManagedConnections(provider, accounts);
      try {
        this._onRelinked?.(provider.instanceId);
      } catch (error) {
        logger.warn('[Connectors] Could not send changes again after linking again', { error });
      }
    }
    // The connection check listed the accounts: what it says about each
    // kept account's sign-in is the freshest fact there is.
    this._registry.recordSignInStatus(provider, accounts, listingStartedAt);
  }

  /**
   * After the DorkOS account was linked again with a different key, and its
   * route answered with its whole account list, close only the kept accounts
   * that list does not have. A continued link (DOR-2521) is the same link with
   * a replaced key, so it lists the accounts made through it and they stay. A
   * genuinely new link (a different account, or the earlier link was removed
   * from it) does not list them, so they would otherwise look healthy while
   * nothing could use them; closed, each reads as disconnected and the owner
   * is offered to connect the app again. Only a listing that succeeded in
   * full reaches here: a failed read throws before it, and a partial one
   * throws inside the route's own `listAccounts`.
   */
  private _closeUnlistedManagedConnections(
    provider: ConnectorProvider,
    accounts: readonly ProviderConnectedAccount[]
  ): void {
    const closed = this._registry.closeUnlistedConnections(provider, accounts);
    if (closed.length === 0) return;
    logger.info(
      `[Connectors] Closed ${closed.length} DorkOS account connection(s) the new link does not list`
    );
    try {
      this._onClosedByNewLink?.(closed);
    } catch (error) {
      logger.warn('[Connectors] Could not record connections closed by a new link', { error });
    }
  }

  /**
   * Run one way's swap after any swap or re-check of it still in flight, so a
   * key saved mid-check is never overtaken by the check that began before it.
   */
  private _queueSwap(spec: ManagedProviderSpec): Promise<void> {
    return this._queue(spec.type, () => this._checkingWhile(spec.type, () => this._swap(spec)));
  }

  /** Run `work` after everything already queued for one way. */
  private _queue(key: string, work: () => Promise<void>): Promise<void> {
    const next = (this._wayQueues.get(key) ?? Promise.resolve()).then(work);
    this._wayQueues.set(
      key,
      next.catch(() => {})
    );
    return next;
  }

  /**
   * Unregister → create → probe → register-if-it-answers, recording any
   * failure. A check that failed for a reason that can pass by itself is
   * re-run on its own ({@link _wayFailed}); a refused key or setup waits for
   * the person to change it.
   */
  private async _swap(spec: ManagedProviderSpec): Promise<void> {
    const previousInstanceId = this._instanceBySpecType.get(spec.type) ?? spec.defaultInstanceId;
    if (previousInstanceId) this._registry.unregisterProviderInstance(previousInstanceId);
    this._instanceBySpecType.delete(spec.type);
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
        const listingStartedAt = new Date().toISOString();
        const accounts = await provider.listAccounts();
        this._registry.register(provider, providerExecutionConfigDigest(provider), 'byo');
        this._instanceBySpecType.set(spec.type, provider.instanceId);
        logger.info(`[Connectors] ${spec.logLabel} registered`);
        // The probe listed the accounts: record what it says about each kept
        // account's sign-in, so boot starts from the service's word.
        this._registry.recordSignInStatus(provider, accounts, listingStartedAt);
        await this._renameServices(provider, spec.logLabel);
      }
      this._clearRecheck(spec.type);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._lastError.set(spec.type, message);
      if (spec.isRefusal(err)) {
        logger.error(`[Connectors] ${spec.logLabel} refused: ${message}`);
        this._clearRecheck(spec.type);
      } else {
        // The connection check failed (or the factory hit a transport error).
        // Record it and leave the provider unregistered; the server keeps
        // booting either way.
        logger.error(`[Connectors] ${spec.logLabel} failed its connection check: ${message}`);
        this._ownKeyWayFailed(spec, err);
      }
    }
  }

  /**
   * Move saved accounts to the ids a provider now lists their apps under
   * (DOR-2436). Best effort: the provider is already registered and working,
   * so a failure here is logged and retried at the next registration, never
   * allowed to take the provider away.
   *
   * Nothing kept needs dropping here. A rename only changes saved account
   * rows; the ids a kept app list or action list is keyed by come from the
   * provider itself, and this runs inside {@link _swap}, whose unregister
   * already told `onProviderInstanceRemoved` listeners to drop everything
   * kept for the instance. What gets kept afterwards is keyed by the new ids.
   */
  private async _renameServices(provider: ConnectorProvider, logLabel: string): Promise<void> {
    if (!reportsServiceRenames(provider)) return;
    try {
      this._registry.renameServices(provider, await provider.serviceRenames());
    } catch (err) {
      logger.error(
        `[Connectors] ${logLabel} could not move saved accounts to their apps: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /** Build one provider's reference-free status DTO. */
  private async _statusFor(spec: ManagedProviderSpec): Promise<ConnectorProviderStatus> {
    const error = this._lastError.get(spec.type);
    const liveInstanceId = this._instanceBySpecType.get(spec.type);
    const live = liveInstanceId
      ? this._registry.resolveProviderInstance(liveInstanceId)
      : undefined;
    // Which credential kind validated (Composio has two, with different auth
    // headers) — a fact the card states, never a secret or a reference.
    const keyKind = live !== undefined && reportsKeyKind(live) ? live.keyKind() : undefined;
    return {
      type: spec.type,
      // The live instance when registered; otherwise the deterministic id the
      // spec registers as, which is also what its existing connections carry.
      providerInstanceId: liveInstanceId ?? spec.defaultInstanceId,
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

/** A provider that lists some apps under a new id and says which (Nango, DOR-2436). */
interface ServiceRenamingProvider extends ConnectorProvider {
  /** Old service id → the id the provider now lists its accounts under. */
  serviceRenames(): Promise<ReadonlyMap<string, string>>;
}

/** Whether a provider reports the service ids it renamed. */
function reportsServiceRenames(provider: ConnectorProvider): provider is ServiceRenamingProvider {
  return typeof (provider as Partial<ServiceRenamingProvider>).serviceRenames === 'function';
}
