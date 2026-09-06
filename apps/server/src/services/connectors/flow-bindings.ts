/**
 * The shared connect-flow → provider binding map (connector-completion
 * spec §Detailed Design 2/3).
 *
 * A provider's `flowId` is local to that provider but the poll surfaces are
 * shared, so this store gives each start a globally opaque DorkOS id and keeps
 * the provider-local id with the exact backend that minted it. Both surfaces
 * that can start or poll a flow — the REST router (`routes/connectors.ts`) and the agent-facing
 * capabilities (`connector-capabilities.ts`) — share ONE instance of this map,
 * so a flow started in chat can be polled over REST and vice versa. Never
 * instantiate one per surface; that splits the state this module exists to keep
 * whole.
 *
 * Bindings retain the exact provider instance because a credential/config reload
 * may replace the registry entry for a provider type while an older flow is
 * still pending. Terminal results remain available so the public poll surfaces
 * preserve the provider port's idempotence without retaining that instance. The map is a
 * bounded LRU: recent active/replayed flows stay routable, while abandoned or
 * old terminal flows eventually leave memory. A provider poll already on the
 * wire is pinned until it settles because some providers create their account
 * before returning. Evicting that binding would hide a real connected account
 * from the caller.
 *
 * In-memory and process-scoped by design: a connect flow does not
 * survive a server restart (the user simply re-initiates), the same liveness
 * the loopback-PKCE flow already assumes (gateway spec §Non-Goals).
 *
 * @module services/connectors/flow-bindings
 */
import { randomUUID } from 'node:crypto';
import {
  ConnectPollSchema,
  type ConnectedAccountId,
  type ConnectorProvider,
  type ConnectPoll,
} from '@dorkos/shared/connector-provider';

/** Default number of recent connect-flow bindings retained for polling and replay. */
const DEFAULT_MAX_ENTRIES = 100;

/** Public-safe copy when every bounded slot is doing work that cannot be cancelled safely. */
const FLOW_CAPACITY_ERROR =
  'Too many connection checks are already in progress. Wait for one to finish and try again.';

/** Construction options for {@link ConnectorFlowBindings}. */
export interface ConnectorFlowBindingsOptions {
  /** Maximum recent bindings retained. Defaults to 100. */
  maxEntries?: number;
}

/** One live provider binding or its cached, secret-free terminal result. */
interface FlowBinding {
  provider?: ConnectorProvider;
  providerFlowId?: string;
  terminal?: ConnectPoll;
  inFlight?: Promise<ConnectPoll | undefined>;
}

/** Process-scoped bounded map of public flow ids to exact provider-local flows. */
export class ConnectorFlowBindings {
  private readonly _flows = new Map<string, FlowBinding>();
  private readonly _maxEntries: number;

  /**
   * Create a bounded process-local binding store.
   *
   * @param options - Optional retention limit; see {@link ConnectorFlowBindingsOptions}.
   */
  constructor(options: ConnectorFlowBindingsOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('Connector flow binding maxEntries must be a positive integer.');
    }
    this._maxEntries = maxEntries;
  }

  /**
   * Bind a freshly started provider-local flow to the exact provider instance
   * that minted it and return a globally opaque public flow id. The provider's
   * own id never crosses the DorkOS boundary, so two providers may safely mint
   * the same local value.
   *
   * When capacity is reached, the least recently used idle binding is evicted.
   * If every retained binding is being polled, the new flow cannot be recorded
   * safely and this method throws a public-safe capacity error.
   *
   * @param providerFlowId - The provider-local flow id from `startConnect`.
   * @param provider - The backend instance that minted the flow.
   * @returns A process-unique opaque flow id for REST and capability callers.
   */
  record(providerFlowId: string, provider: ConnectorProvider): string {
    while (this._flows.size >= this._maxEntries) {
      const idle = [...this._flows].find(([, binding]) => !binding.inFlight);
      if (!idle) throw new Error(FLOW_CAPACITY_ERROR);
      this._flows.delete(idle[0]);
    }
    let publicFlowId: string;
    do {
      publicFlowId = `connector-flow-${randomUUID()}`;
    } while (this._flows.has(publicFlowId));
    this._flows.set(publicFlowId, { provider, providerFlowId });
    return publicFlowId;
  }

  /**
   * Poll a flow through the exact provider instance that started it. Terminal
   * results are cached for repeat callers and the provider reference is then
   * released, so a completed flow does not retain a credential-bearing client.
   * Returns `undefined` only for an unknown or capacity-evicted flow.
   *
   * @param flowId - The public DorkOS flow id to route.
   */
  async poll(flowId: string): Promise<ConnectPoll | undefined> {
    const binding = this._flows.get(flowId);
    if (!binding) return undefined;
    this._flows.delete(flowId);
    this._flows.set(flowId, binding);

    if (binding.terminal) return binding.terminal;
    if (binding.inFlight) return binding.inFlight;
    const provider = binding.provider;
    const providerFlowId = binding.providerFlowId;
    if (!provider || !providerFlowId) return undefined;

    const verification = (async (): Promise<ConnectPoll | undefined> => {
      const result = ConnectPollSchema.parse(await provider.pollConnect(providerFlowId));

      // Account invalidation may have removed this exact binding while the
      // provider call was pending. The late completion must not become routable
      // or reinsert itself into the bounded store.
      if (this._flows.get(flowId) !== binding) return undefined;

      if (result.status === 'connected' || result.status === 'failed') {
        binding.terminal = result;
        binding.provider = undefined;
        binding.providerFlowId = undefined;
      }
      return result;
    })();
    binding.inFlight = verification;
    try {
      return await verification;
    } finally {
      if (binding.inFlight === verification) binding.inFlight = undefined;
    }
  }

  /**
   * Invalidate terminal successes for a disconnected account. Without this,
   * replaying an old successful flow could recreate the account routing row
   * after revocation. Pending and failed flows do not claim an account and are
   * unaffected.
   *
   * @param accountId - The disconnected account whose successful flows must expire.
   */
  invalidateAccount(accountId: ConnectedAccountId): void {
    for (const [flowId, binding] of this._flows) {
      if (binding.terminal?.account?.id === accountId) {
        this._flows.delete(flowId);
      }
    }
  }

  /**
   * Disconnect an account through the current provider and every exact older
   * instance that still owns an active flow of the same provider type. This
   * lets an idempotent delete cancel a reconnect before it has recreated its
   * routing row.
   *
   * @param accountId - The account being disconnected.
   * @param providerType - Provider namespace that owns the account id.
   * @param currentProvider - Current registry instance, when one is registered.
   */
  async disconnectAccount(
    accountId: ConnectedAccountId,
    providerType: string,
    currentProvider?: ConnectorProvider
  ): Promise<void> {
    const providers = new Set<ConnectorProvider>();
    if (currentProvider) providers.add(currentProvider);
    for (const binding of this._flows.values()) {
      if (binding.provider?.type === providerType) providers.add(binding.provider);
    }
    await Promise.all([...providers].map((provider) => provider.disconnect(accountId)));
    this.invalidateAccount(accountId);
  }
}
