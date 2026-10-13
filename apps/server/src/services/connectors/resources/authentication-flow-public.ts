/**
 * The public shape of one durable owner authentication flow, read from its
 * stored row. Kept apart from `authentication-flow-service.ts` so the service
 * holds the flow's rules and this file holds only how a row is shown.
 *
 * @module services/connectors/resources/authentication-flow-public
 */
import type { connectorAuthenticationFlows } from '@dorkos/db';
import {
  ConnectorAuthenticationFlowStateSchema,
  type ConnectorAuthenticationFlowState,
} from '@dorkos/shared/connector-resource-schemas';

/**
 * The owner-facing state of one stored flow: what each state may say, and
 * nothing private (no provider flow id, no cleanup snapshot).
 *
 * @param row - The stored flow row.
 */
export function publicFlowState(
  row: typeof connectorAuthenticationFlows.$inferSelect
): ConnectorAuthenticationFlowState {
  const base = {
    flowId: row.id,
    providerInstanceId: row.providerInstanceId,
    toolkit: row.toolkit,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
  switch (row.state) {
    case 'starting':
      return ConnectorAuthenticationFlowStateSchema.parse({ ...base, state: row.state });
    case 'pending':
      return ConnectorAuthenticationFlowStateSchema.parse({
        ...base,
        state: row.state,
        ...(row.authorizeUrl ? { authorizeUrl: row.authorizeUrl } : {}),
      });
    case 'connected':
      return ConnectorAuthenticationFlowStateSchema.parse({
        ...base,
        state: row.state,
        connectionId: row.resultConnectionId,
        completedAt: row.completedAt,
      });
    case 'failed':
      return ConnectorAuthenticationFlowStateSchema.parse({
        ...base,
        state: row.state,
        reason: row.failureReason,
        ...(row.failureCode ? { failureCode: row.failureCode } : {}),
        completedAt: row.completedAt,
      });
    case 'start_unknown':
      return ConnectorAuthenticationFlowStateSchema.parse({
        ...base,
        state: row.state,
        reason: row.failureReason,
        completedAt: row.completedAt,
      });
    case 'expired':
      return ConnectorAuthenticationFlowStateSchema.parse({
        ...base,
        state: row.state,
        completedAt: row.completedAt,
      });
  }
}
