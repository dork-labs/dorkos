/**
 * The shared connect-flow → provider binding map (connector-completion
 * spec §Detailed Design 2/3).
 *
 * A `flowId` is provider-scoped but the poll surfaces are not, so whichever
 * surface started a flow must record which backend minted it for the poll to
 * route `pollConnect` back correctly. Both surfaces that can start or poll a
 * flow — the REST router (`routes/connectors.ts`) and the agent-facing
 * capabilities (`connector-capabilities.ts`) — share ONE instance of this map,
 * so a flow started in chat can be polled over REST and vice versa. Never
 * instantiate one per surface; that splits the state this module exists to keep
 * whole.
 *
 * Active bindings retain the exact provider instance and private provider flow
 * reference. Terminal results retain only the public response for idempotent
 * replay. A bounded LRU removes abandoned and older completed flows.
 *
 * In-memory and process-scoped by design: a connect flow does not
 * survive a server restart (the user simply re-initiates), the same liveness
 * the loopback-PKCE flow already assumes (gateway spec §Non-Goals).
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

  /** Construct a bounded binding cache with an optional deterministic ID factory. */
  constructor(createId: () => string = ulid, maxEntries = DEFAULT_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('Connector flow binding capacity must be a positive integer.');
    }
    this._createId = createId;
    this._maxEntries = maxEntries;
  }

  /**
   * Bind a provider flow to a new DorkOS flow id and its exact provider instance.
   *
   * @param providerFlowId - The private flow id from `startConnect`.
   * @param provider - The exact configured backend instance that minted it.
   * @param reconnectConnectionId - Unambiguous disconnected connection this flow may restore.
   */
  record(
    providerFlowId: string,
    provider: ConnectorProvider,
    reconnectConnectionId?: ConnectedAccountId
  ): string {
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
    return this._flows.get(flowId) === binding;
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
