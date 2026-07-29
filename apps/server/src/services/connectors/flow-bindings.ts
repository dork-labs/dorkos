/**
 * The shared in-flight connect-flow → provider binding map (connector-completion
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
 * In-memory and process-scoped by design: an in-flight OAuth flow does not
 * survive a server restart (the user simply re-initiates), the same liveness
 * the loopback-PKCE flow already assumes (gateway spec §Non-Goals).
 *
 * @module services/connectors/flow-bindings
 */

/** Process-scoped map of in-flight connect flow ids to their owning provider type. */
export class ConnectorFlowBindings {
  private readonly _flows = new Map<string, string>();

  /**
   * Bind a freshly started flow to the provider type that minted it.
   *
   * @param flowId - The opaque flow id from `startConnect`.
   * @param providerType - The backend type that minted it, e.g. `'composio'`.
   */
  record(flowId: string, providerType: string): void {
    this._flows.set(flowId, providerType);
  }

  /**
   * Resolve a flow id to its owning provider type, or `undefined` for a flow
   * this process never started (or one already resolved).
   *
   * @param flowId - The opaque flow id to route.
   */
  providerFor(flowId: string): string | undefined {
    return this._flows.get(flowId);
  }

  /**
   * Drop a flow's binding once it reaches a terminal state (`connected` /
   * `failed`), so the map cannot grow unbounded across many connect attempts.
   * Idempotent.
   *
   * @param flowId - The opaque flow id to release.
   */
  release(flowId: string): void {
    this._flows.delete(flowId);
  }
}
