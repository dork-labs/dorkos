/**
 * The community registry — the dispatcher behind the `CommunityAdapter` port.
 *
 * Mirrors `runtimeRegistry`: one instance per configured community, keyed on its
 * {@link CommunityRef}. Two differences from the runtime registry are
 * deliberate:
 *
 * - **Dispatch is on `community`, never on a room id.** A bare room id is
 *   ambiguous by construction — Buzz addresses channels by a UUID unique only
 *   within one host, and our own `rooms` table has no community column at all.
 *   That is the strongest argument for the pair address.
 * - **The registry is where a ref becomes legible.** It holds the `label`, so a
 *   ULID never has to be rendered, logged or matched by eye. The adapter is
 *   never asked for it and never has to be told about a rename.
 *
 * @module services/communities/registry
 */
import type {
  CommunityAdapter,
  CommunityCapabilities,
  CommunityConnection,
  CommunityDescriptor,
  CommunityRef,
} from '@dorkos/shared/community-adapter';
import { logger } from '../../lib/logger.js';

/**
 * Thrown when a community ref is not registered on this server.
 *
 * Surfacing this explicitly — rather than silently falling back to the local
 * community — is the {@link RuntimeNotRegisteredError} precedent: masking a
 * mismatch hides a routing bug, and here it would quietly answer a question
 * about someone else's community with this machine's own rooms.
 */
export class CommunityNotRegisteredError extends Error {
  /**
   * Name the community that was asked for and is not configured here.
   *
   * @param community - The unregistered community ref.
   */
  constructor(readonly community: CommunityRef) {
    super(`Community '${community}' is not registered on this server.`);
    this.name = 'CommunityNotRegisteredError';
  }
}

/** One registered community: its adapter, how a person names it, and its last connection result. */
export interface RegisteredCommunity {
  /** The adapter serving this community. */
  adapter: CommunityAdapter;
  /** Ref, label and type — everything a list needs without asking the adapter. */
  descriptor: CommunityDescriptor;
  /** The most recent {@link CommunityAdapter.connect} result, once one has been driven. */
  connection?: CommunityConnection;
}

/**
 * Registry of configured communities, keyed by {@link CommunityRef}.
 *
 * The local community is always registered by the composition root; the others
 * are additive, and each may fail to construct without taking the server down —
 * the tolerance `registerOptionalRuntime` already establishes, and ADR-0310's
 * per-backend degradation principle.
 */
export class CommunityRegistry {
  private readonly communities = new Map<CommunityRef, RegisteredCommunity>();

  /**
   * Register an adapter under the name a person calls it.
   *
   * The label is supplied here rather than reported by the adapter so a rename
   * never has to reach one. Re-registering a ref replaces it.
   *
   * @param adapter - The adapter serving exactly one community.
   * @param label - What a person calls this community.
   */
  register(adapter: CommunityAdapter, label: string): void {
    this.communities.set(adapter.community, {
      adapter,
      descriptor: { community: adapter.community, label, type: adapter.type },
    });
  }

  /**
   * Get the adapter for a community.
   *
   * @param community - The community to dispatch to.
   * @throws {CommunityNotRegisteredError} When the ref is not registered.
   */
  get(community: CommunityRef): CommunityAdapter {
    return this.require(community).adapter;
  }

  /**
   * Get a community's registration, descriptor and last connection included.
   *
   * @param community - The community to look up.
   * @throws {CommunityNotRegisteredError} When the ref is not registered.
   */
  require(community: CommunityRef): RegisteredCommunity {
    const registered = this.communities.get(community);
    if (!registered) throw new CommunityNotRegisteredError(community);
    return registered;
  }

  /**
   * Whether a community is registered.
   *
   * @param community - The community to check.
   */
  has(community: CommunityRef): boolean {
    return this.communities.has(community);
  }

  /** Every configured community, in registration order. */
  list(): CommunityDescriptor[] {
    return [...this.communities.values()].map((entry) => ({ ...entry.descriptor }));
  }

  /** Every registration, for a caller that needs the adapters themselves (aggregation). */
  entries(): RegisteredCommunity[] {
    return [...this.communities.values()];
  }

  /** Capabilities for every registered community, keyed by ref. */
  getCapabilities(): Record<CommunityRef, CommunityCapabilities> {
    const capabilities = {} as Record<CommunityRef, CommunityCapabilities>;
    for (const [community, entry] of this.communities) {
      capabilities[community] = entry.adapter.getCapabilities();
    }
    return capabilities;
  }

  /**
   * Connect one community and remember the result.
   *
   * The registry drives connect (rather than each caller) because the result is
   * what a listing needs afterwards: a `'not-admitted'` community contributes a
   * warning carrying its disclosure and **none of the rooms it listed before**,
   * and nothing downstream can know that without the connection.
   *
   * Failure is typed on the result, so this never rejects for a connection
   * outcome — only for an unregistered ref.
   *
   * @param community - The community to connect.
   * @param signal - Aborts a connect attempt that is taking too long.
   * @throws {CommunityNotRegisteredError} When the ref is not registered.
   */
  async connect(community: CommunityRef, signal?: AbortSignal): Promise<CommunityConnection> {
    const entry = this.require(community);
    const connection = await entry.adapter.connect(signal);
    entry.connection = connection;
    if (connection.status !== 'connected') {
      logger.warn('[CommunityRegistry] community did not connect', {
        community,
        label: entry.descriptor.label,
        status: connection.status,
      });
    }
    return connection;
  }

  /**
   * The last connection result for a community, or `undefined` when none has
   * been driven yet.
   *
   * @param community - The community to look up.
   */
  getConnection(community: CommunityRef): CommunityConnection | undefined {
    return this.communities.get(community)?.connection;
  }
}

/** Singleton — initialized at server startup. */
export const communityRegistry = new CommunityRegistry();
