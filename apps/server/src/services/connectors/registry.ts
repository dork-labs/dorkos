/**
 * The `ConnectorRegistry` — the server-side seam that holds the registered
 * {@link ConnectorProvider} backends, routes an opaque `ConnectedAccountId` to
 * its owning provider, and aggregates accounts across every backend with
 * per-provider degradation.
 *
 * It is the connector analogue of `runtimeRegistry`: id → provider binding is
 * first-write-wins (ADR-0255), and cross-provider `listAccounts` aggregation
 * degrades one unreachable provider to a `warnings[]` entry rather than failing
 * the whole call (ADR-0310), exactly as session listing degrades per runtime.
 *
 * The `connected_accounts` table (`@dorkos/db`) is the derived routing cache
 * (ADR-0043): the registry writes a row on a successful `pollConnect`
 * (first-write-wins) and clears it on `disconnect`; the provider vaults remain
 * the source of truth for the tokens themselves.
 *
 * @module services/connectors/registry
 */
import { connectedAccounts, eq, type Db } from '@dorkos/db';
import type {
  ConnectedAccount,
  ConnectedAccountId,
  ConnectorProvider,
  ConnectorToolkit,
} from '@dorkos/shared/connector-provider';

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
  /** The DorkOS database holding the `connected_accounts` routing cache. */
  db: Db;
  /** Override the per-provider aggregation timeout (default 5s). */
  providerTimeoutMs?: number;
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
  private readonly _db: Db;
  private readonly _providerTimeoutMs: number;
  private readonly _providers = new Map<string, ConnectorProvider>();

  /**
   * Construct the registry over the routing-cache database.
   *
   * @param opts - The database and optional timeout; see {@link ConnectorRegistryOpts}.
   */
  constructor(opts: ConnectorRegistryOpts) {
    this._db = opts.db;
    this._providerTimeoutMs = opts.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  /**
   * Register a backend under its `type`. Last registration of a type wins (a
   * reconfigured provider replaces the old instance).
   *
   * @param provider - The backend to register.
   */
  register(provider: ConnectorProvider): void {
    this._providers.set(provider.type, provider);
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
    return this._providers.get(type);
  }

  /**
   * Route an opaque account id to the provider that owns it, via the
   * `connected_accounts` binding. Returns `undefined` when the id is unknown or
   * its owning provider is no longer registered.
   *
   * @param accountId - The opaque account handle to route.
   */
  providerForAccount(accountId: ConnectedAccountId): ConnectorProvider | undefined {
    const row = this._db
      .select({ provider: connectedAccounts.provider })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.accountId, accountId))
      .get();
    if (!row) return undefined;
    return this.resolveProvider(row.provider);
  }

  /**
   * Bind an account id to its owning provider (first-write-wins). Called after a
   * successful `pollConnect`. Re-recording an already-bound id is a no-op, so
   * the first provider to claim an id keeps it (mirrors `runtimeRegistry`).
   *
   * @param account - The freshly connected account to persist for routing.
   */
  recordConnect(account: ConnectedAccount): void {
    this._db
      .insert(connectedAccounts)
      .values({
        accountId: account.id,
        provider: account.provider,
        toolkit: account.toolkit,
        label: account.label,
        custody: account.custody,
        status: account.status,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Clear an account id's routing binding. Called on `disconnect`. Idempotent —
   * clearing an unknown id is a no-op.
   *
   * @param accountId - The opaque account handle to unbind.
   */
  recordDisconnect(accountId: ConnectedAccountId): void {
    this._db.delete(connectedAccounts).where(eq(connectedAccounts.accountId, accountId)).run();
  }

  /**
   * Aggregate accounts across every registered provider in parallel, degrading
   * per provider: one backend that throws or times out becomes a `warnings[]`
   * entry while the others still return (ADR-0310).
   *
   * @param opts - Optional filter; `toolkit` narrows to one service slug.
   */
  async listAccounts(opts?: { toolkit?: string }): Promise<AggregatedAccounts> {
    const { items, warnings } = await this._aggregate((provider) => provider.listAccounts(opts));
    return { accounts: items, warnings };
  }

  /**
   * Aggregate connectable toolkits across every registered provider in parallel
   * with the same per-provider degradation, deduped by slug (first provider to
   * offer a service wins the row) so the discovery picker shows each service
   * once.
   */
  async listToolkits(): Promise<AggregatedToolkits> {
    const { items, warnings } = await this._aggregate((provider) => provider.listToolkits());
    const bySlug = new Map<string, ConnectorToolkit>();
    for (const toolkit of items) if (!bySlug.has(toolkit.slug)) bySlug.set(toolkit.slug, toolkit);
    return { toolkits: [...bySlug.values()], warnings };
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
