/**
 * Connector Transport methods factory (HTTP adapter) — provider setup,
 * stable connections, reviewed access, exact execution, usage, and canonical
 * agent and session projections.
 *
 * Everything here is reference-shaped: vendor secrets travel once (into
 * `putConnectorCredential`) and never come back; account rows carry the
 * server-composed custody sentence so no client surface composes disclosure
 * copy of its own.
 *
 * @module shared/lib/transport/connector-methods
 */
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import type {
  ConnectionId,
  ConnectorAccessibleConnectionsResponse,
  ConnectorAccessibleOperationsResponse,
  ConnectorExecutionResponse,
  ConnectorManagementReviewCreateRequest,
  ConnectorManagementReviewDecision,
  ConnectorManagementReviewDecisionResult,
  ConnectorManagementReviewItem,
  ConnectorProgramExecutionRequest,
  ConnectorReconciliationApplyRequest,
  ConnectorReconciliationApplyResponse,
  ConnectorReconciliationPreview,
  ConnectorReconciliationPreviewRequest,
  ConnectorUsagePage,
} from '@dorkos/shared/connector-schemas';
import { fetchJSON, buildQueryString } from './http-client';
import type {
  ConnectorAgentConnections,
  ConnectorAuthenticationFlowCreateRequest,
  ConnectorAuthenticationFlowState,
  ConnectorCatalogResourcePage,
  ConnectorConnectionDetail,
  ConnectorConnectionListResource,
  ConnectorConnectionPatch,
  ConnectorDisconnectImpact,
  ConnectorLifecycleResult,
  ConnectorReconnectRequest,
  ConnectorSessionConnections,
} from '@dorkos/shared/connector-resource-schemas';

/** Create the connector methods bound to a base URL. */
export function createConnectorMethods(baseUrl: string) {
  return {
    getConnectorProviders(): Promise<ConnectorProviderStatus[]> {
      return fetchJSON<{ providers: ConnectorProviderStatus[] }>(
        baseUrl,
        '/connectors/providers'
      ).then((r) => r.providers);
    },

    putConnectorCredential(provider: string, secret: string): Promise<ConnectorProviderStatus> {
      return fetchJSON<ConnectorProviderStatus>(
        baseUrl,
        `/connectors/providers/${encodeURIComponent(provider)}/credential`,
        { method: 'PUT', body: JSON.stringify({ secret }) }
      );
    },

    deleteConnectorCredential(provider: string): Promise<ConnectorProviderStatus> {
      return fetchJSON<ConnectorProviderStatus>(
        baseUrl,
        `/connectors/providers/${encodeURIComponent(provider)}/credential`,
        { method: 'DELETE' }
      );
    },

    getConnectorCatalog(
      input: { query?: string; cursor?: string; limit?: number } = {}
    ): Promise<ConnectorCatalogResourcePage> {
      const qs = buildQueryString({ q: input.query, cursor: input.cursor, limit: input.limit });
      return fetchJSON<ConnectorCatalogResourcePage>(baseUrl, `/connectors/catalog${qs}`);
    },

    getConnectorConnections(): Promise<ConnectorConnectionListResource> {
      return fetchJSON<ConnectorConnectionListResource>(baseUrl, '/connectors/connections');
    },

    getConnectorConnection(connectionId: string): Promise<ConnectorConnectionDetail> {
      return fetchJSON<ConnectorConnectionDetail>(
        baseUrl,
        `/connectors/connections/${encodeURIComponent(connectionId)}`
      );
    },

    startConnectorAuthentication(
      input: ConnectorAuthenticationFlowCreateRequest
    ): Promise<ConnectorAuthenticationFlowState> {
      return fetchJSON<ConnectorAuthenticationFlowState>(baseUrl, '/connectors/connections', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    pollConnectorAuthentication(flowId: string): Promise<ConnectorAuthenticationFlowState> {
      return fetchJSON<ConnectorAuthenticationFlowState>(
        baseUrl,
        `/connectors/authentication-flows/${encodeURIComponent(flowId)}`
      );
    },

    renameConnectorConnection(
      connectionId: string,
      input: ConnectorConnectionPatch
    ): Promise<ConnectorLifecycleResult> {
      return fetchJSON<ConnectorLifecycleResult>(
        baseUrl,
        `/connectors/connections/${encodeURIComponent(connectionId)}`,
        { method: 'PATCH', body: JSON.stringify(input) }
      );
    },

    reconnectConnectorConnection(
      connectionId: string,
      input: ConnectorReconnectRequest
    ): Promise<ConnectorAuthenticationFlowState> {
      return fetchJSON<ConnectorAuthenticationFlowState>(
        baseUrl,
        `/connectors/connections/${encodeURIComponent(connectionId)}/reconnect`,
        { method: 'POST', body: JSON.stringify(input) }
      );
    },

    pauseConnectorConnection(connectionId: string): Promise<ConnectorLifecycleResult> {
      return fetchJSON<ConnectorLifecycleResult>(
        baseUrl,
        `/connectors/connections/${encodeURIComponent(connectionId)}/pause`,
        { method: 'POST', body: '{}' }
      );
    },

    resumeConnectorConnection(connectionId: string): Promise<ConnectorLifecycleResult> {
      return fetchJSON<ConnectorLifecycleResult>(
        baseUrl,
        `/connectors/connections/${encodeURIComponent(connectionId)}/resume`,
        { method: 'POST', body: '{}' }
      );
    },

    getConnectorDisconnectImpact(connectionId: string): Promise<ConnectorDisconnectImpact> {
      return fetchJSON<ConnectorDisconnectImpact>(
        baseUrl,
        `/connectors/connections/${encodeURIComponent(connectionId)}/disconnect-impact`
      );
    },

    disconnectConnectorConnection(connectionId: string): Promise<ConnectorLifecycleResult> {
      return fetchJSON<ConnectorLifecycleResult>(
        baseUrl,
        `/connectors/connections/${encodeURIComponent(connectionId)}`,
        { method: 'DELETE' }
      );
    },

    getAgentConnectorConnections(agentId: string): Promise<ConnectorAgentConnections> {
      return fetchJSON<ConnectorAgentConnections>(
        baseUrl,
        `/connectors/agents/${encodeURIComponent(agentId)}/connections`
      );
    },

    getSessionConnectorConnections(sessionId: string): Promise<ConnectorSessionConnections> {
      return fetchJSON<ConnectorSessionConnections>(
        baseUrl,
        `/connectors/sessions/${encodeURIComponent(sessionId)}/connections`
      );
    },

    getAccessibleConnectorConnections(
      agentId: string
    ): Promise<ConnectorAccessibleConnectionsResponse> {
      return fetchJSON<ConnectorAccessibleConnectionsResponse>(
        baseUrl,
        `/connectors/accessible?agentId=${encodeURIComponent(agentId)}`
      );
    },

    getAccessibleConnectorOperations(
      agentId: string,
      connectionId: ConnectionId
    ): Promise<ConnectorAccessibleOperationsResponse> {
      const qs = buildQueryString({ agentId });
      return fetchJSON<ConnectorAccessibleOperationsResponse>(
        baseUrl,
        `/connectors/accessible/${encodeURIComponent(connectionId)}/operations${qs}`
      );
    },

    executeConnector(input: ConnectorProgramExecutionRequest): Promise<ConnectorExecutionResponse> {
      return fetchJSON<ConnectorExecutionResponse>(baseUrl, '/connectors/executions', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    getAgentConnectorUsage(input: {
      agentId: string;
      cursor?: string;
      limit?: number;
    }): Promise<ConnectorUsagePage> {
      const qs = buildQueryString(input);
      return fetchJSON<ConnectorUsagePage>(baseUrl, `/connectors/usage/agent${qs}`);
    },

    getOperatorConnectorUsage(input: {
      connectionId?: ConnectionId;
      cursor?: string;
      limit?: number;
    }): Promise<ConnectorUsagePage> {
      const qs = buildQueryString(input);
      return fetchJSON<ConnectorUsagePage>(baseUrl, `/connectors/usage/operator${qs}`);
    },

    previewConnectorReconciliation(
      input: ConnectorReconciliationPreviewRequest
    ): Promise<ConnectorReconciliationPreview> {
      return fetchJSON<ConnectorReconciliationPreview>(
        baseUrl,
        '/connectors/reconciliation/previews',
        { method: 'POST', body: JSON.stringify(input) }
      );
    },

    applyConnectorReconciliation(
      input: ConnectorReconciliationApplyRequest
    ): Promise<ConnectorReconciliationApplyResponse> {
      return fetchJSON<ConnectorReconciliationApplyResponse>(
        baseUrl,
        '/connectors/reconciliation/apply',
        { method: 'POST', body: JSON.stringify(input) }
      );
    },

    createConnectorManagementReview(
      input: ConnectorManagementReviewCreateRequest
    ): Promise<ConnectorManagementReviewItem> {
      return fetchJSON<ConnectorManagementReviewItem>(baseUrl, '/connectors/reviews', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    getConnectorManagementReviews(
      state?: 'pending' | 'resolved'
    ): Promise<ConnectorManagementReviewItem[]> {
      const qs = buildQueryString({ state });
      return fetchJSON<{ reviews: ConnectorManagementReviewItem[] }>(
        baseUrl,
        `/connectors/reviews${qs}`
      ).then((response) => response.reviews);
    },

    getConnectorManagementReview(reviewRequestId: string): Promise<ConnectorManagementReviewItem> {
      return fetchJSON<ConnectorManagementReviewItem>(
        baseUrl,
        `/connectors/reviews/${encodeURIComponent(reviewRequestId)}`
      );
    },

    resolveConnectorManagementReview(
      reviewRequestId: string,
      input: ConnectorManagementReviewDecision
    ): Promise<ConnectorManagementReviewDecisionResult> {
      return fetchJSON<ConnectorManagementReviewDecisionResult>(
        baseUrl,
        `/connectors/reviews/${encodeURIComponent(reviewRequestId)}/decision`,
        { method: 'POST', body: JSON.stringify(input) }
      );
    },
  };
}
