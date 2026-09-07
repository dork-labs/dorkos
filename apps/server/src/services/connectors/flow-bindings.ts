/**
 * Shared public-flow to private-provider binding map.
 *
 * Provider flow ids are private and provider-scoped. Owner REST and durable
 * management-review paths share one instance so every approved connect routes
 * to the exact provider object and material generation that started it.
 * Terminal responses are cached for idempotent polling, and a material swap or
 * disconnect invalidates the corresponding flow. The bounded LRU removes old
 * and abandoned state.
 *
 * The map is process-scoped. Durable review rows detect a restart-lost approved
 * flow and return an explicit expired/recovery outcome; they never replay an
 * ambiguous upstream create.
 *
 * @module services/connectors/flow-bindings
 */
import { ulid } from 'ulidx';
import {
  ConnectPollSchema,
  ConnectorConnectPollResponseSchema,
  type ConnectPoll,
  type ConnectedAccountId,
  type ConnectorConnectPollResponse,
  type ConnectorExternalAccountRef,
  type ConnectorProvider,
} from '@dorkos/shared/connector-provider';

/** Exact private routing information for one active public connect-flow id. */
export interface ActiveConnectorFlowBinding {
  /** Discriminator for an active provider flow. */
  state: 'active';
  /** Configured provider instance that owns the flow. */
  provider: ConnectorProvider;
  /** Provider-owned flow reference passed only back to that instance. */
  providerFlowId: string;
  /** Durable execution-material generation captured before the flow started. */
  executionConfigGeneration: number;
  /** Existing stable connection this flow may explicitly restore. */
  reconnectConnectionId?: ConnectedAccountId;
  /** Shared public-resolution promise while one provider poll is active. */
  pollPromise?: Promise<ConnectorConnectPollResponse | undefined>;
}

/** Public terminal result retained for idempotent polling without a provider dependency. */
export interface TerminalConnectorFlowBinding {
  /** Discriminator for a completed or failed flow. */
  state: 'terminal';
  /** Secret-free response returned identically to later poll attempts. */
  result: ConnectorConnectPollResponse;
  /** Exact provider retained only to reject replay after its material changes. */
  provider: ConnectorProvider;
  /** Durable execution-material generation that authorized this result. */
  executionConfigGeneration: number;
}

/** Active private routing or a terminal public replay record. */
export type ConnectorFlowBinding = ActiveConnectorFlowBinding | TerminalConnectorFlowBinding;

/** Parsed private provider result held only until stable reconciliation completes. */
export interface ConnectorProviderFlowPoll {
  /** Exact provider instance that produced the result. */
  provider: ConnectorProvider;
  /** Runtime-validated provider result, including its private account reference. */
  result: ConnectPoll;
}

/** Default number of active or terminal flow records retained by one process. */
const DEFAULT_MAX_ENTRIES = 100;

/** Process-scoped bounded map of active and recently completed connect flows. */
export class ConnectorFlowBindings {
  private readonly _flows = new Map<string, ConnectorFlowBinding>();
  private readonly _createId: () => string;
  private readonly _maxEntries: number;
  private readonly _resolveProviderGeneration: (provider: ConnectorProvider) => number | undefined;

  /** Construct a bounded binding cache with optional deterministic test seams. */
  constructor(
    createId: () => string = ulid,
    maxEntries = DEFAULT_MAX_ENTRIES,
    resolveProviderGeneration: (provider: ConnectorProvider) => number | undefined = () => 1
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('Connector flow binding capacity must be a positive integer.');
    }
    this._createId = createId;
    this._maxEntries = maxEntries;
    this._resolveProviderGeneration = resolveProviderGeneration;
  }

  /**
   * Bind a provider flow to a new DorkOS flow id and its exact provider instance.
   *
   * @param providerFlowId - The private flow id from `startConnect`.
   * @param provider - The exact configured backend instance that minted it.
   * @param executionConfigGeneration - Material generation current before start.
   * @param reconnectConnectionId - Unambiguous disconnected connection this flow may restore.
   */
  record(
    providerFlowId: string,
    provider: ConnectorProvider,
    executionConfigGeneration: number,
    reconnectConnectionId?: ConnectedAccountId
  ): string {
    if (this._resolveProviderGeneration(provider) !== executionConfigGeneration) {
      throw new Error('Connector provider configuration changed. Start connecting again.');
    }
    if (this._flows.size >= this._maxEntries) {
      const oldestIdle = [...this._flows].find(
        ([, binding]) => binding.state === 'terminal' || binding.pollPromise === undefined
      )?.[0];
      if (oldestIdle === undefined) {
        throw new Error('Too many connection checks are already in progress. Try again shortly.');
      }
      this._flows.delete(oldestIdle);
    }
    let flowId: string;
    do {
      flowId = this._createId();
    } while (this._flows.has(flowId));
    this._flows.set(flowId, {
      state: 'active',
      provider,
      providerFlowId,
      executionConfigGeneration,
      ...(reconnectConnectionId && { reconnectConnectionId }),
    });
    return flowId;
  }

  /**
   * Resolve a public flow id to its exact active route or retained terminal result,
   * or `undefined` for a flow this process never started or already evicted.
   *
   * @param flowId - The opaque flow id to route.
   */
  providerFor(flowId: string): ConnectorFlowBinding | undefined {
    const binding = this._flows.get(flowId);
    if (!binding) return undefined;
    if (this._resolveProviderGeneration(binding.provider) !== binding.executionConfigGeneration) {
      this._flows.delete(flowId);
      return undefined;
    }
    this._flows.delete(flowId);
    this._flows.set(flowId, binding);
    return binding;
  }

  /**
   * Resolve one public flow through a single shared provider poll. An in-flight
   * binding is pinned against capacity eviction, and concurrent REST/MCP polls
   * await the same promise. Terminal output is schema-parsed before caching so
   * extra provider fields cannot enter the replay record.
   *
   * @param flowId - Public DorkOS flow id.
   * @param poller - Exact-instance provider poll, without canonical side effects.
   * @param publicize - Stable reconciliation run only after the binding remains current.
   */
  async poll(
    flowId: string,
    poller: (binding: ActiveConnectorFlowBinding) => Promise<ConnectPoll | undefined>,
    publicize: (poll: ConnectorProviderFlowPoll) => ConnectorConnectPollResponse
  ): Promise<ConnectorConnectPollResponse | undefined> {
    const binding = this.providerFor(flowId);
    if (!binding) return undefined;
    if (binding.state === 'terminal') return structuredClone(binding.result);
    if (binding.pollPromise) return binding.pollPromise;

    const promise = (async () => {
      const providerPoll = await poller(binding);
      if (!providerPoll || !this.isCurrent(flowId, binding)) return undefined;
      const parsedPoll = ConnectPollSchema.parse(providerPoll);
      const result = ConnectorConnectPollResponseSchema.parse(
        publicize({ provider: binding.provider, result: parsedPoll })
      );
      this.recordTerminal(flowId, binding, result);
      return result;
    })();
    binding.pollPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.isCurrent(flowId, binding)) binding.pollPromise = undefined;
    }
  }

  /**
   * Confirm that an awaited provider poll still belongs to the active record.
   * A capacity eviction or public-id replacement makes the late result inert.
   *
   * @param flowId - Public DorkOS flow id.
   * @param binding - Active object captured before awaiting the provider.
   */
  isCurrent(flowId: string, binding: ActiveConnectorFlowBinding): boolean {
    const current =
      this._flows.get(flowId) === binding &&
      this._resolveProviderGeneration(binding.provider) === binding.executionConfigGeneration;
    if (!current && this._flows.get(flowId) === binding) this._flows.delete(flowId);
    return current;
  }

  /**
   * Replace an active private route with its terminal public result. This
   * releases the provider instance and private flow references while keeping
   * repeat public polls idempotent until LRU eviction.
   *
   * @param flowId - Public DorkOS flow id.
   * @param binding - Active object captured before awaiting the provider.
   * @param result - Secret-free terminal response to replay.
   */
  recordTerminal(
    flowId: string,
    binding: ActiveConnectorFlowBinding,
    result: ConnectorConnectPollResponse
  ): boolean {
    if (result.status === 'pending' || !this.isCurrent(flowId, binding)) return false;
    this._flows.delete(flowId);
    this._flows.set(flowId, {
      state: 'terminal',
      result: ConnectorConnectPollResponseSchema.parse(structuredClone(result)),
      provider: binding.provider,
      executionConfigGeneration: binding.executionConfigGeneration,
    });
    return true;
  }

  /**
   * Forget terminal successes for a disconnected account so replay cannot
   * restore the account through an obsolete connect result.
   *
   * @param accountId - Stable DorkOS connection id being disconnected.
   */
  invalidateAccount(accountId: string): void {
    for (const [flowId, binding] of this._flows) {
      if (
        (binding.state === 'terminal' && binding.result.account?.id === accountId) ||
        (binding.state === 'active' && binding.reconnectConnectionId === accountId)
      ) {
        this._flows.delete(flowId);
      }
    }
  }

  /**
   * Cancel active reconnects through their exact original provider objects,
   * invalidate public replay for the stable connection, and revoke the provider
   * account through the current registry object as well.
   */
  async disconnectAccount(
    accountId: ConnectedAccountId,
    externalAccountRef: ConnectorExternalAccountRef,
    currentProvider?: ConnectorProvider
  ): Promise<void> {
    const providers = new Set<ConnectorProvider>();
    if (currentProvider) providers.add(currentProvider);
    for (const binding of this._flows.values()) {
      if (binding.state === 'active' && binding.reconnectConnectionId === accountId) {
        providers.add(binding.provider);
      }
    }
    this.invalidateAccount(accountId);
    await Promise.all([...providers].map((provider) => provider.disconnect(externalAccountRef)));
  }
}
