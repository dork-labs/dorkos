/**
 * Connector Transport methods factory (HTTP adapter) — provider setup,
 * connected accounts, reviewed access, exact execution, usage, and read-only
 * session status. The retained attach/detach methods call retired compatibility
 * routes that direct operators to the Connections access editor.
 *
 * Everything here is reference-shaped: vendor secrets travel once (into
 * `putConnectorCredential`) and never come back; account rows carry the
 * server-composed custody sentence so no client surface composes disclosure
 * copy of its own.
 *
 * @module shared/lib/transport/connector-methods
 */
import type {
  ConnectorAccountsResponse,
  ConnectorConnectPollResponse,
  ConnectorConnectStartResponse,
  ConnectorProviderStatus,
  ConnectorRecommendationsResponse,
  ConnectorToolkitsResponse,
  SessionConnectorAttachResult,
  SessionConnectorStatus,
  AgentConnectorAttachment,
  AgentConnectorAttachResult,
  AgentConnectorListResponse,
} from '@dorkos/shared/connector-provider';
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
import { fetchJSON, fetchNoContent, buildQueryString } from './http-client';

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

    getConnectorToolkits(): Promise<ConnectorToolkitsResponse> {
      return fetchJSON<ConnectorToolkitsResponse>(baseUrl, '/connectors/toolkits');
    },

    getConnectorRecommendation(service: string): Promise<ConnectorRecommendationsResponse> {
      const qs = buildQueryString({ service });
      return fetchJSON<ConnectorRecommendationsResponse>(baseUrl, `/connectors/recommend${qs}`);
    },

    startConnectorFlow(
      provider: string,
      request: { toolkit: string; label?: string }
    ): Promise<ConnectorConnectStartResponse> {
      return fetchJSON<ConnectorConnectStartResponse>(
        baseUrl,
        `/connectors/${encodeURIComponent(provider)}/connect`,
        { method: 'POST', body: JSON.stringify(request) }
      );
    },

    pollConnectorFlow(flowId: string): Promise<ConnectorConnectPollResponse> {
      return fetchJSON<ConnectorConnectPollResponse>(
        baseUrl,
        `/connectors/flows/${encodeURIComponent(flowId)}`
      );
    },

    getConnectorAccounts(toolkit?: string): Promise<ConnectorAccountsResponse> {
      const qs = buildQueryString({ toolkit });
      return fetchJSON<ConnectorAccountsResponse>(baseUrl, `/connectors/accounts${qs}`);
    },

    disconnectConnectorAccount(accountId: string): Promise<void> {
      return fetchNoContent(baseUrl, `/connectors/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
      });
    },

    getSessionConnectors(sessionId: string): Promise<SessionConnectorStatus> {
      return fetchJSON<SessionConnectorStatus>(
        baseUrl,
        `/sessions/${encodeURIComponent(sessionId)}/connectors`
      );
    },

    attachSessionConnector(
      sessionId: string,
      accountId: string
    ): Promise<SessionConnectorAttachResult> {
      return fetchJSON<SessionConnectorAttachResult>(
        baseUrl,
        `/sessions/${encodeURIComponent(sessionId)}/connectors/${encodeURIComponent(accountId)}`,
        { method: 'POST' }
      );
    },

    detachSessionConnector(sessionId: string, accountId: string): Promise<void> {
      return fetchNoContent(
        baseUrl,
        `/sessions/${encodeURIComponent(sessionId)}/connectors/${encodeURIComponent(accountId)}`,
        { method: 'DELETE' }
      );
    },

    // --- Agent-level attachment (connection-scoping spec §Part 1) ---

    getAgentConnectors(agentId: string): Promise<AgentConnectorAttachment[]> {
      return fetchJSON<AgentConnectorListResponse>(
        baseUrl,
        `/agents/${encodeURIComponent(agentId)}/connectors`
      ).then((r) => r.accounts);
    },

    attachAgentConnector(agentId: string, accountId: string): Promise<AgentConnectorAttachResult> {
      return fetchJSON<AgentConnectorAttachResult>(
        baseUrl,
        `/agents/${encodeURIComponent(agentId)}/connectors/${encodeURIComponent(accountId)}`,
        { method: 'POST' }
      );
    },

    detachAgentConnector(agentId: string, accountId: string): Promise<void> {
      return fetchNoContent(
        baseUrl,
        `/agents/${encodeURIComponent(agentId)}/connectors/${encodeURIComponent(accountId)}`,
        { method: 'DELETE' }
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
