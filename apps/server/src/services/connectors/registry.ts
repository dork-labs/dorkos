/**
 * The `ConnectorRegistry` — the server-side seam that holds the registered
 * {@link ConnectorProvider} backends, routes an opaque `ConnectionId` to
 * its owning provider, and aggregates accounts across every backend with
 * per-provider degradation.
 *
 * It is the connector analogue of `runtimeRegistry`: stable connection ids
 * resolve through private instance/account bindings, and cross-provider `listAccounts` aggregation
 * degrades one unreachable provider to a `warnings[]` entry rather than failing
 * the whole call (ADR-0310), exactly as session listing degrades per runtime.
 *
 * The canonical `connections` table owns DorkOS identity and private provider
 * routing. The registry reconciles it after provider reads and tombstones it on
 * disconnect; provider vaults remain the source of truth for tokens.
 *
 * @module services/connectors/registry
 */
import type { Db } from '@dorkos/db';
import type {
  ConnectedAccount,
  ConnectorProvider,
  ConnectorProviderInstanceId,
  ConnectorToolkit,
  ProviderConnectedAccount,
} from '@dorkos/shared/connector-provider';
import type { ConnectionId } from '@dorkos/shared/connector-schemas';
import { connectorExecutionConfigDigest } from './execution/execution-config.js';
import {
  ConnectionStore,
  type ConnectorProviderDeploymentMode,
  type StableConnectionBinding,
} from './connection-store.js';
import type {
  ConnectorMigrationResult,
  LegacyConnectionMigrationInput,
} from './legacy-connection-migration.js';

/** Default per-provider deadline for an aggregation call, in milliseconds. */
const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;

/** One provider's degradation notice — a backend that failed or timed out. */
export interface ConnectorWarning {
  /** The backend type that degraded, e.g. `'composio'`. */
  provider: string;
  /** Human-readable reason the provider's accounts are missing from the aggregate. */
  message: string;
}

/** The result of a cross-provider `listAccounts` aggregation. */
export interface AggregatedAccounts {
  /** Every account returned by a reachable provider, merged. */
  accounts: ConnectedAccount[];
  /** One entry per provider that failed or timed out (never a hard failure). */
  warnings: ConnectorWarning[];
}

/** The result of a cross-provider `listToolkits` aggregation. */
export interface AggregatedToolkits {
  /** Every connectable toolkit returned by a reachable provider, deduped by slug. */
  toolkits: ConnectorToolkit[];
  /** One entry per provider that failed or timed out (never a hard failure). */
  warnings: ConnectorWarning[];
}

/** Construction options for {@link ConnectorRegistry}. */
export interface ConnectorRegistryOpts {
  /** The DorkOS database holding canonical connector identity and authority. */
  db: Db;
  /** Override the per-provider aggregation timeout (default 5s). */
  providerTimeoutMs?: number;
  /** Already-resolved application migration input. Production P1 supplies no operation set. */
  migration?: LegacyConnectionMigrationInput;
  /** Inject an authoritative store in focused tests. */
  connectionStore?: ConnectionStore;
  /** Verified account or installation that owns configured provider instances. */
  configuredOwner?: {
    readonly ownerKind: 'user' | 'local_install';
    readonly ownerId: string;
  };
}

/**
 * Reject after `ms` so one slow vendor can never block the aggregate.
 *
 * @param promise - The provider call to bound.
 * @param ms - The deadline in milliseconds.
 * @param label - A label for the timeout error message.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/**
 * Registry of connector backends with id → provider routing and degrading
 * cross-provider aggregation.
 */
export class ConnectorRegistry {
  private readonly _providerTimeoutMs: number;
  private readonly _connections: ConnectionStore;
  private readonly _providers = new Map<string, ConnectorProvider>();
  private readonly _defaultInstanceByType = new Map<string, ConnectorProviderInstanceId>();

  /**
   * Construct the registry over the canonical connector database.
   *
   * @param opts - The database and optional timeout; see {@link ConnectorRegistryOpts}.
   */
  constructor(opts: ConnectorRegistryOpts) {
    this._providerTimeoutMs = opts.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    this._connections =
      opts.connectionStore ??
      new ConnectionStore({
        db: opts.db,
        migration: opts.migration,
        ...(opts.configuredOwner && { configuredOwner: opts.configuredOwner }),
      });
  }

  /** Current source-of-truth migration health for route-level 503 responses. */
  migrationHealth(): ConnectorMigrationResult {
    return this._connections.health();
  }

  /** Reject connector work while the stable source-of-truth migration is unavailable. */
  assertAvailable(): void {
    this._connections.assertAvailable();
  }

  /** Revoke all durable connector authority owned by one removed agent. */
  removeAgentAccess(agentId: string): string[] {
    return this._connections.removeAgentAccess(agentId);
  }

  /** Revoke one agent's durable authority for one exact stable connection. */
  removeAgentConnectionAccess(agentId: string, connectionId: ConnectionId): void {
    this._connections.removeAgentConnectionAccess(agentId, connectionId);
  }

  /** Fence retained legacy consent before an agent is removed. */
  recordAgentRemoval(agentId: string): void {
    this._connections.recordAgentRemoval(agentId);
  }

  /**
   * Register an exact backend instance. The most recently registered instance
   * becomes the compatibility default for its type; other instances remain
   * independently registered and routable.
   *
   * @param provider - The backend to register.
   * @param executionConfigDigest - Secret-free fingerprint of execution material.
   * @param mode - Server-owned deployment and payer mode; direct registrations are BYO.
   */
  register(
    provider: ConnectorProvider,
    executionConfigDigest?: string,
    mode: ConnectorProviderDeploymentMode = 'byo'
  ): void {
    if (this._connections.health().status === 'ready') {
      this._connections.registerProvider(
        provider,
        executionConfigDigest ??
          connectorExecutionConfigDigest({
            source: 'direct-registration',
            instanceId: provider.instanceId,
            type: provider.type,
            capabilities: provider.getCapabilities(),
          }),
        mode
      );
    }
    this._providers.set(provider.instanceId, provider);
    this._defaultInstanceByType.set(provider.type, provider.instanceId);
  }

  /**
   * Resolve the durable material generation only while this exact provider
   * object remains registered for its configured instance.
   *
   * @param provider - Exact object captured when an upstream flow began.
   */
  providerExecutionConfigGeneration(provider: ConnectorProvider): number | undefined {
    if (this._providers.get(provider.instanceId) !== provider) return undefined;
    return this._connections.providerExecutionConfigGeneration(provider.instanceId);
  }

  /**
   * Remove one exact provider instance while retaining every sibling instance.
   * If it was the type's compatibility default, choose the lexically first
   * remaining instance so legacy type selectors continue deterministically.
   *
   * @param instanceId - Exact configured provider instance to disable.
   */
  unregisterProviderInstance(instanceId: ConnectorProviderInstanceId): void {
    const provider = this._providers.get(instanceId);
    if (!provider) return;
    this._providers.delete(instanceId);
    if (this._defaultInstanceByType.get(provider.type) === instanceId) {
      const fallback = [...this._providers.values()]
        .filter((candidate) => candidate.type === provider.type)
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId))[0];
      if (fallback) this._defaultInstanceByType.set(provider.type, fallback.instanceId);
      else this._defaultInstanceByType.delete(provider.type);
    }
    if (this._connections.health().status === 'ready') {
      this._connections.unregisterProvider(instanceId);
    }
  }

  /**
   * Remove a backend registration. Idempotent — unregistering an absent type is
   * a no-op, so a credential-delete reload can call it unconditionally.
   *
   * Canonical account bindings survive: `providerForAccount`
   * already tolerates a missing provider (returns `undefined`) and every route
   * degrades rather than throws, so re-registering the type later restores
   * routing for the same accounts.
   *
   * @param type - The backend type to remove, e.g. `'composio'`.
   */
  unregister(type: string): void {
    const instanceId = this._defaultInstanceByType.get(type);
    if (!instanceId) return;
    this.unregisterProviderInstance(instanceId);
  }

  /** Every registered provider, in registration order. */
  listProviders(): ConnectorProvider[] {
    return [...this._providers.values()];
  }

  /**
   * Resolve a provider by its backend type.
   *
   * @param type - The backend type, e.g. `'composio'`.
   */
  resolveProvider(type: string): ConnectorProvider | undefined {
    const instanceId = this._defaultInstanceByType.get(type);
    return instanceId ? this._providers.get(instanceId) : undefined;
  }

  /** Resolve one exact configured provider instance. */
  resolveProviderInstance(instanceId: ConnectorProviderInstanceId): ConnectorProvider | undefined {
    return this._providers.get(instanceId);
  }

  /**
   * Route an active account id to the provider that owns it, via the canonical
   * private binding. Returns `undefined` when the id is unknown, locally paused
   * or disconnected, provider-expired, or its exact provider is unavailable.
   * Disconnect reads the tombstone with {@link accountBinding} instead.
   *
   * @param connectionId - The stable connection id to route.
   */
  providerForAccount(connectionId: ConnectionId): ConnectorProvider | undefined {
    const binding = this.accountBinding(connectionId);
    if (!binding || binding.status !== 'active') return undefined;
    return this.resolveProviderInstance(binding.providerInstanceId);
  }

  /**
   * Read the canonical private binding for an account id — the provider-neutral
   * metadata (owning provider, toolkit, label, custody, status) used by owner
   * management, broker routing, and retained access status. Returns
   * `undefined` when the id is unknown.
   *
   * @param connectionId - The stable connection id to look up.
   */
  accountBinding(connectionId: ConnectionId): StableConnectionBinding | undefined {
    return this._connections.binding(connectionId);
  }

  /** Resolve the one disconnected connection a provider connect flow can safely restore. */
  disconnectedConnectionFor(
    provider: ConnectorProvider,
    toolkit: string,
    label?: string
  ): ConnectionId | undefined {
    return this._connections.disconnectedConnectionFor(provider.instanceId, toolkit, label);
  }

  /**
   * Reconcile a provider-owned account to its stable DorkOS connection. Called
   * after a successful `pollConnect` and provider inventory refresh.
   *
   * @param account - The freshly connected account to persist for routing.
   */
  recordConnect(
    provider: ConnectorProvider,
    account: ProviderConnectedAccount,
    options: { allowRemovedReplacement?: boolean } = {}
  ): ConnectedAccount {
    return this._connections.reconcile(provider, account, {
      restoreDisconnected: true,
      ...options,
    });
  }

  /**
   * Tombstone a stable connection and revoke its active local authority. Called
   * on `disconnect`; an unknown id is a no-op.
   *
   * **Cascades to every persisted connector attachment of this account**
   * (connection-scoping spec `specs/connection-scoping/` §Part 1 Revocation):
   * both the agent-level standing table and the session-level override table
   * are cleared for `connectionId`, across every agent/session that ever
   * attached it. A disconnected account's credential is gone — leaving a
   * consent row pointing at it would let the same private provider account
   * silently inherit stale consent after a future reconnect. This method does not, by
   * itself, call the provider's disconnect operation; the owner route does that
   * first, then commits this durable tombstone and authority cleanup.
   *
   * @param connectionId - The stable connection id to disconnect.
   */
  recordDisconnect(connectionId: ConnectionId): void {
    this._connections.revokeConnection(connectionId);
  }

  /** Pause or resume a stable connection without changing provider authentication state. */
  setPaused(connectionId: ConnectionId, paused: boolean): void {
    this._connections.setPaused(connectionId, paused);
  }

  /** Replace the operator-facing label of one stable connection. */
  setLabel(connectionId: ConnectionId, label: string): void {
    this._connections.setLabel(connectionId, label);
  }

  /**
   * Aggregate accounts across every registered provider in parallel, degrading
   * per provider: one backend that throws or times out becomes a `warnings[]`
   * entry while the others still return (ADR-0310).
   *
   * @param opts - Optional filter; `toolkit` narrows to one service slug.
   */
  async listAccounts(opts?: { toolkit?: string }): Promise<AggregatedAccounts> {
    this._connections.assertAvailable();
    const providers = this.listProviders();
    const settled = await Promise.allSettled(
      providers.map((provider) =>
        withTimeout(provider.listAccounts(opts), this._providerTimeoutMs, provider.type)
      )
    );
    const accounts: ConnectedAccount[] = [];
    const warnings: ConnectorWarning[] = [];
    settled.forEach((result, index) => {
      const provider = providers[index]!;
      if (result.status === 'fulfilled') {
        accounts.push(
          ...result.value
            .map((account) => this._connections.reconcile(provider, account))
            .filter((account) => !this._connections.isRemoved(account.id))
        );
      } else {
        warnings.push({
          provider: provider.type,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
    return { accounts, warnings };
  }

  /**
   * Aggregate connectable toolkits across every registered provider in parallel
   * with the same per-provider degradation, deduped by slug (first provider to
   * offer a service wins the row) so the discovery picker shows each service
   * once.
   */
  async listToolkits(): Promise<AggregatedToolkits> {
    this._connections.assertAvailable();
    const { items, warnings } = await this._aggregate((provider) => provider.listToolkits());
    const bySlug = new Map<string, ConnectorToolkit>();
    for (const toolkit of items) if (!bySlug.has(toolkit.slug)) bySlug.set(toolkit.slug, toolkit);
    return { toolkits: [...bySlug.values()], warnings };
  }

  /**
   * Find every registered provider that lists `toolkitSlug`, with the same
   * per-provider timeout + degradation as the aggregation paths: a provider
   * that throws or hangs on `listToolkits` becomes a `warnings[]` entry rather
   * than blocking the caller. Used by the provider-neutral recommendation
   * capability so discovery degrades on a slow provider instead of hanging.
   *
   * @param toolkitSlug - The service slug to match against each provider's toolkits.
   */
  async providersForToolkit(
    toolkitSlug: string
  ): Promise<{ providers: ConnectorProvider[]; warnings: ConnectorWarning[] }> {
    this._connections.assertAvailable();
    const providers = this.listProviders();
    const settled = await Promise.allSettled(
      providers.map((provider) =>
        withTimeout(provider.listToolkits(), this._providerTimeoutMs, provider.type)
      )
    );

    const matching: ConnectorProvider[] = [];
    const warnings: ConnectorWarning[] = [];
    settled.forEach((result, i) => {
      const provider = providers[i]!;
      if (result.status === 'fulfilled') {
        if (result.value.some((tk) => tk.slug === toolkitSlug)) matching.push(provider);
      } else {
        const reason: unknown = result.reason;
        warnings.push({
          provider: provider.type,
          message: reason instanceof Error ? reason.message : String(reason),
        });
      }
    });

    return { providers: matching, warnings };
  }

  /**
   * Run `call` against every registered provider in parallel with a per-provider
   * timeout, collecting the fulfilled results and degrading each rejection or
   * timeout to a `warnings[]` entry — the shared aggregation/degradation core
   * (ADR-0310).
   *
   * @param call - The per-provider call to fan out.
   */
  private async _aggregate<T>(
    call: (provider: ConnectorProvider) => Promise<T[]>
  ): Promise<{ items: T[]; warnings: ConnectorWarning[] }> {
    const providers = this.listProviders();
    const settled = await Promise.allSettled(
      providers.map((provider) =>
        withTimeout(call(provider), this._providerTimeoutMs, provider.type)
      )
    );

    const items: T[] = [];
    const warnings: ConnectorWarning[] = [];
    settled.forEach((result, i) => {
      const provider = providers[i]!;
      if (result.status === 'fulfilled') {
        items.push(...result.value);
      } else {
        const reason: unknown = result.reason;
        warnings.push({
          provider: provider.type,
          message: reason instanceof Error ? reason.message : String(reason),
        });
      }
    });

    return { items, warnings };
  }
}
