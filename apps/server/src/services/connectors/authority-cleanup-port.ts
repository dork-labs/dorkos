/** Synchronous cleanup port for connector approvals and broker authority state. */
import type { ConnectionId } from '@dorkos/shared/connector-schemas';

/** Exact cleanup operations called from canonical agent-removal paths. */
export interface ConnectorAuthorityCleanupPort {
  /** Expire every connector authority record owned by one removed agent. */
  revokeAgent(input: { readonly agentId: string; readonly reason: 'agent_removed' }): void;
  /** Expire exact pending authority while preserving whole-turn runtime bearers. */
  revokeAgentConnection(input: {
    readonly agentId: string;
    readonly connectionId: ConnectionId;
    readonly reason: 'agent_connection_removed';
  }): void;
  /** Expire pending authority for one disconnected connection across every agent. */
  revokeConnection(input: {
    readonly connectionId: ConnectionId;
    readonly reason: 'connection_removed';
  }): void;
}
