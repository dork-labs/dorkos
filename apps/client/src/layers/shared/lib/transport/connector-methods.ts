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
import {
  CONNECTOR_AUTH_SETUP_HEADER,
  CONNECTOR_AUTH_SETUP_VERSION,
  type ConnectorProviderStatus,
} from '@dorkos/shared/connector-provider';
import type {
  ConnectorAgentRequestAuthenticationInput,
  ConnectorAgentRequestDecisionInput,
} from '@dorkos/shared/connector-agent-request-schemas';
import type {
  ConfigureConnectionEventSource,
  ConnectionEventDefinitionPage,
  ConnectionEventSourceStatus,
  ConnectionEventSubscription,
  ConnectionEventSubscriptionPage,
  CreateConnectionEventSubscription,
} from '@dorkos/shared/connector-event-schemas';
import type {
  ConnectionId,
  ConnectorAccessibleConnectionsResponse,
  ConnectorAccessibleOperationsResponse,
  ConnectorAgentRequestItem,
  ConnectorExecutionResponse,
  ConnectorManagementReviewCreateRequest,
  ConnectorManagementReviewDecision,
  ConnectorManagementReviewDecisionResult,
  ConnectorManagementReviewItem,
  ConnectorProgramExecutionRequest,
  ConnectorReconciliationApplyRequest,
  ConnectorReconciliationApplyResponse,
  ConnectorEveryAgentRevokeResponse,
  ConnectorReconciliationPreview,
  ConnectorReconciliationPreviewRequest,
  ConnectorUsagePage,
} from '@dorkos/shared/connector-schemas';
import type { CancelHeldActionResponse } from '@dorkos/shared/connector-hold-schemas';
import type {
  ConnectorAccessChange,
  ConnectorAccessChangeUndo,
} from '@dorkos/shared/connector-exclusion-schemas';
import { LIST_PAGE_LIMIT, readAllPages } from '../read-all-pages';
import { createTransportApiClient } from './api-client';
import { fetchAllPages, fetchJSON, fetchNoContent } from './http-client';
import type {
  ConnectorAgentConnections,
  ConnectorAgentConnectionsPage,
  ConnectorEveryAgentGrants,
  ConnectorEveryAgentGrantsPage,
  ConnectorManagementReviewPage,
  ConnectorAuthenticationFlowCreateRequest,
  ConnectorAuthenticationFlowState,
  ConnectorCatalogResourcePage,
  ConnectorConnectionDetail,
  ConnectorConnectionListResource,
  ConnectorConnectionPatch,
  ConnectorAppActions,
  ConnectorDisconnectImpact,
  ConnectorLifecycleResult,
  ConnectorProvidersResource,
  ConnectorReconnectRequest,
  ConnectorSessionAccessUpdate,
  ConnectorSessionConnections,
  ConnectorSessionConnectionsPage,
} from '@dorkos/shared/connector-resource-schemas';

/** Browser budget above the local 60s start cap so the server owns the outcome. */
const CONNECTOR_AUTHENTICATION_START_TIMEOUT_MS = 75_000;

/** Name order, then id: how the app shows a list of accounts. */
function byLabel(left: { label: string; connectionId: string }, right: typeof left): number {
  return (
    left.label.localeCompare(right.label) || left.connectionId.localeCompare(right.connectionId)
  );
}

/** Oldest asked first, then by id: the order an agent's requests wait in. */
function oldestFirst(left: ConnectorAgentRequestItem, right: ConnectorAgentRequestItem): number {
  return (
    left.createdAt.localeCompare(right.createdAt) || left.requestId.localeCompare(right.requestId)
  );
}

/** Create the connector methods bound to a base URL. */
export function createConnectorMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  const authApi = createTransportApiClient(baseUrl, CONNECTOR_AUTHENTICATION_START_TIMEOUT_MS);
  // One page of a paged list: its own fields first, then the cursor and the page size.
  const listQuery = (query: Record<string, string | undefined>, cursor?: string) => ({
    ...query,
    cursor,
    limit: LIST_PAGE_LIMIT,
  });
  return {
    async getConnectorProviders(): Promise<ConnectorProvidersResource> {
      return (await api.call('connectors.getProviders', {})) as ConnectorProvidersResource;
    },

    async putConnectorCredential(
      provider: string,
      secret: string
    ): Promise<ConnectorProviderStatus> {
      return (await api.call('connectors.updateProvidersCredential', {
        path: { provider },
        body: { secret },
      })) as ConnectorProviderStatus;
    },

    async deleteConnectorCredential(provider: string): Promise<ConnectorProviderStatus> {
      return (await api.call('connectors.deleteProvidersCredential', {
        path: { provider },
      })) as ConnectorProviderStatus;
    },

    async getConnectorCatalog(
      input: { query?: string; cursor?: string; limit?: number } = {}
    ): Promise<ConnectorCatalogResourcePage> {
      return (await api.call('connectors.listCatalog', {
        query: { q: input.query, cursor: input.cursor, limit: input.limit },
        headers: { [CONNECTOR_AUTH_SETUP_HEADER]: CONNECTOR_AUTH_SETUP_VERSION },
      })) as ConnectorCatalogResourcePage;
    },

    // The lists below come in pages, newest first; these read them whole, in name order.
    async getConnectorConnections(): Promise<Pick<ConnectorConnectionListResource, 'connections'>> {
      const { rows } = await readAllPages(
        async (cursor) =>
          (await api.call('connectors.listConnections', {
            query: listQuery({}, cursor),
          })) as ConnectorConnectionListResource,
        (list) => list.connections,
        '/connectors/connections'
      );
      return { connections: rows.sort(byLabel) };
    },

    async getConnectorConnection(connectionId: string): Promise<ConnectorConnectionDetail> {
      return (await api.call('connectors.getConnections', {
        path: { connectionId },
      })) as ConnectorConnectionDetail;
    },

    async listConnectionEventDefinitions(
      connectionId: string,
      cursor?: string
    ): Promise<ConnectionEventDefinitionPage> {
      return (await api.call('connectors.listConnectionsEventsDefinitions', {
        path: { connectionId },
        query: { cursor },
      })) as ConnectionEventDefinitionPage;
    },

    async listConnectionEventSubscriptions(
      connectionId: string,
      cursor?: string
    ): Promise<ConnectionEventSubscriptionPage> {
      return (await api.call('connectors.listConnectionsEventsSubscriptions', {
        path: { connectionId },
        query: { cursor },
      })) as ConnectionEventSubscriptionPage;
    },

    async createConnectionEventSubscription(
      connectionId: string,
      input: CreateConnectionEventSubscription
    ): Promise<ConnectionEventSubscription> {
      return (await api.call('connectors.createConnectionsEventsSubscriptions', {
        path: { connectionId },
        body: input,
      })) as ConnectionEventSubscription;
    },

    async deleteConnectionEventSubscription(
      connectionId: string,
      subscriptionId: string
    ): Promise<void> {
      await api.call('connectors.deleteConnectionsEventsSubscriptions', {
        path: { connectionId, subscriptionId },
      });
    },

    async getConnectionEventSource(connectionId: string): Promise<ConnectionEventSourceStatus> {
      return (await api.call('connectors.getConnectionsEventsSource', {
        path: { connectionId },
      })) as ConnectionEventSourceStatus;
    },

    async configureConnectionEventSource(
      connectionId: string,
      input: ConfigureConnectionEventSource
    ): Promise<ConnectionEventSourceStatus> {
      return (await api.call('connectors.updateConnectionsEventsSource', {
        path: { connectionId },
        body: input,
      })) as ConnectionEventSourceStatus;
    },

    async startConnectorAuthentication(
      input: ConnectorAuthenticationFlowCreateRequest
    ): Promise<ConnectorAuthenticationFlowState> {
      return (await authApi.call('connectors.createConnections', {
        body: input,
      })) as ConnectorAuthenticationFlowState;
    },

    async pollConnectorAuthentication(flowId: string): Promise<ConnectorAuthenticationFlowState> {
      return (await api.call('connectors.get_sign_in', {
        path: { flowId },
      })) as ConnectorAuthenticationFlowState;
    },

    async renameConnectorConnection(
      connectionId: string,
      input: ConnectorConnectionPatch
    ): Promise<ConnectorLifecycleResult> {
      return (await api.call('connectors.rename_connection', {
        path: { connectionId },
        body: input,
      })) as ConnectorLifecycleResult;
    },

    async reconnectConnectorConnection(
      connectionId: string,
      input: ConnectorReconnectRequest
    ): Promise<ConnectorAuthenticationFlowState> {
      return (await authApi.call('connectors.createConnectionsReconnect', {
        path: { connectionId },
        body: input,
      })) as ConnectorAuthenticationFlowState;
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

    async getConnectorDisconnectImpact(connectionId: string): Promise<ConnectorDisconnectImpact> {
      return (await api.call('connectors.disconnect_impact', {
        path: { connectionId },
      })) as ConnectorDisconnectImpact;
    },

    async getConnectorAppActions(
      toolkit: string,
      providerInstanceId: string
    ): Promise<ConnectorAppActions> {
      return (await api.call('connectors.getAppsActions', {
        path: { toolkit },
        query: { providerInstanceId },
      })) as ConnectorAppActions;
    },

    async disconnectConnectorConnection(connectionId: string): Promise<ConnectorLifecycleResult> {
      return (await api.call('connectors.deleteConnections', {
        path: { connectionId },
      })) as ConnectorLifecycleResult;
    },

    removeConnectorConnection(connectionId: string): Promise<void> {
      return fetchNoContent(
        baseUrl,
        `/connectors/connections/${encodeURIComponent(connectionId)}/remove`,
        { method: 'POST', body: '{}' }
      );
    },

    async getAgentConnectorConnections(agentId: string): Promise<ConnectorAgentConnections> {
      const { first, rows } = await readAllPages(
        async (cursor) =>
          (await api.call('connectors.list_agent_connections', {
            path: { agentId },
            query: listQuery({}, cursor),
          })) as ConnectorAgentConnectionsPage,
        (list) => list.connections,
        `/connectors/agents/${encodeURIComponent(agentId)}/connections`
      );
      return { agentId: first.agentId, connections: rows.sort(byLabel) };
    },

    async getEveryAgentConnectorGrants(): Promise<ConnectorEveryAgentGrants> {
      const { rows } = await readAllPages(
        async (cursor) =>
          (await api.call('connectors.list_every_agent_grants', {
            query: listQuery({}, cursor),
          })) as ConnectorEveryAgentGrantsPage,
        (list) => list.connections,
        '/connectors/every-agent-grants'
      );
      return { connections: rows.sort(byLabel) };
    },

    async getSessionConnectorConnections(sessionId: string): Promise<ConnectorSessionConnections> {
      const { first, rows } = await readAllPages(
        async (cursor) =>
          (await api.call('connectors.list_session_connections', {
            path: { sessionId },
            query: listQuery({}, cursor),
          })) as ConnectorSessionConnectionsPage,
        (list) => list.connections,
        `/connectors/sessions/${encodeURIComponent(sessionId)}/connections`
      );
      const { nextCursor: _last, ...chat } = first;
      return { ...chat, connections: rows.sort(byLabel) };
    },

    async setSessionConnectorAccess(
      sessionId: string,
      connectionId: string,
      update: ConnectorSessionAccessUpdate
    ): Promise<ConnectorSessionConnections> {
      return (await api.call('connectors.updateSessionsConnections', {
        path: { sessionId, connectionId },
        body: update,
      })) as ConnectorSessionConnections;
    },

    async getAccessibleConnectorConnections(
      agentId: string
    ): Promise<ConnectorAccessibleConnectionsResponse> {
      return (await api.call('connectors.getAccessible', {
        query: { agentId },
      })) as ConnectorAccessibleConnectionsResponse;
    },

    async getAccessibleConnectorOperations(
      agentId: string,
      connectionId: ConnectionId
    ): Promise<ConnectorAccessibleOperationsResponse> {
      return (await api.call('connectors.getAccessibleOperations', {
        path: { connectionId },
        query: { agentId },
      })) as ConnectorAccessibleOperationsResponse;
    },

    async executeConnector(
      input: ConnectorProgramExecutionRequest
    ): Promise<ConnectorExecutionResponse> {
      return (await api.call('connectors.createExecutions', {
        body: input,
      })) as ConnectorExecutionResponse;
    },

    async getAgentConnectorUsage(input: {
      agentId: string;
      cursor?: string;
      limit?: number;
    }): Promise<ConnectorUsagePage> {
      return (await api.call('connectors.listUsageAgent', { query: input })) as ConnectorUsagePage;
    },

    async getOperatorConnectorUsage(input: {
      connectionId?: ConnectionId;
      cursor?: string;
      limit?: number;
    }): Promise<ConnectorUsagePage> {
      return (await api.call('connectors.list_usage', { query: input })) as ConnectorUsagePage;
    },

    async previewConnectorReconciliation(
      input: ConnectorReconciliationPreviewRequest
    ): Promise<ConnectorReconciliationPreview> {
      return (await api.call('connectors.createReconciliationPreviews', {
        body: input,
      })) as ConnectorReconciliationPreview;
    },

    async applyConnectorReconciliation(
      input: ConnectorReconciliationApplyRequest
    ): Promise<ConnectorReconciliationApplyResponse> {
      return (await api.call('connectors.applyReconciliation', {
        body: input,
      })) as ConnectorReconciliationApplyResponse;
    },

    async stopSharingConnectorWithEveryAgent(
      connectionId: string
    ): Promise<ConnectorEveryAgentRevokeResponse> {
      return (await api.call('connectors.stop_every_agent_share', {
        path: { connectionId },
      })) as ConnectorEveryAgentRevokeResponse;
    },

    async createConnectorManagementReview(
      input: ConnectorManagementReviewCreateRequest
    ): Promise<ConnectorManagementReviewItem> {
      return (await api.call('connectors.createReviews', {
        body: input,
      })) as ConnectorManagementReviewItem;
    },

    async getConnectorManagementReviews(
      state?: 'pending' | 'resolved'
    ): Promise<ConnectorManagementReviewItem[]> {
      const { rows } = await readAllPages(
        async (cursor) =>
          (await api.call('connectors.list_reviews', {
            query: listQuery({ state }, cursor),
          })) as ConnectorManagementReviewPage,
        (list) => list.reviews,
        '/connectors/reviews'
      );
      return rows;
    },

    async getConnectorManagementReview(
      reviewRequestId: string
    ): Promise<ConnectorManagementReviewItem> {
      return (await api.call('connectors.get_review', {
        path: { reviewRequestId },
      })) as ConnectorManagementReviewItem;
    },

    async resolveConnectorManagementReview(
      reviewRequestId: string,
      input: ConnectorManagementReviewDecision
    ): Promise<ConnectorManagementReviewDecisionResult> {
      return (await api.call('connectors.createReviewsDecision', {
        path: { reviewRequestId },
        body: input,
      })) as ConnectorManagementReviewDecisionResult;
    },

    getConnectorAgentRequests(
      state?: 'pending' | 'resolved',
      sessionId?: string
    ): Promise<ConnectorAgentRequestItem[]> {
      type Page = { requests: ConnectorAgentRequestItem[]; nextCursor: string | null };
      return fetchAllPages(
        baseUrl,
        '/connectors/agent-requests',
        { state, sessionId },
        (page: Page) => page.requests
        // Oldest first, as the cards have always queued: the one asked longest ago leads.
      ).then(({ rows }) => rows.sort(oldestFirst));
    },

    getConnectorAgentRequest(requestId: string): Promise<ConnectorAgentRequestItem> {
      return fetchJSON<ConnectorAgentRequestItem>(
        baseUrl,
        `/connectors/agent-requests/${encodeURIComponent(requestId)}`
      );
    },

    async resolveConnectorAgentRequest(
      requestId: string,
      input: ConnectorAgentRequestDecisionInput
    ): Promise<ConnectorAgentRequestItem> {
      return (await api.call('connectors.answer_agent_request', {
        path: { requestId },
        body: input,
      })) as ConnectorAgentRequestItem;
    },

    async startConnectorAgentRequestAuthentication(
      requestId: string,
      input: ConnectorAgentRequestAuthenticationInput
    ): Promise<ConnectorAuthenticationFlowState> {
      return (await authApi.call('connectors.start_agent_request_sign_in', {
        path: { requestId },
        body: input,
      })) as ConnectorAuthenticationFlowState;
    },

    async pollConnectorAgentRequestAuthentication(
      requestId: string,
      flowId: string
    ): Promise<ConnectorAuthenticationFlowState> {
      return (await api.call('connectors.get_agent_request_sign_in', {
        path: { requestId, flowId },
      })) as ConnectorAuthenticationFlowState;
    },

    cancelHeldConnectorAction(holdId: string): Promise<CancelHeldActionResponse> {
      return fetchJSON<CancelHeldActionResponse>(
        baseUrl,
        `/connectors/holds/${encodeURIComponent(holdId)}/cancel`,
        { method: 'POST', body: '{}' }
      );
    },

    async getAccessChange(changeId: string): Promise<ConnectorAccessChange> {
      return (await api.call('connectors.getAccessChanges', {
        path: { changeId },
      })) as ConnectorAccessChange;
    },

    undoAccessChange(changeId: string): Promise<ConnectorAccessChangeUndo> {
      return fetchJSON<ConnectorAccessChangeUndo>(
        baseUrl,
        `/connectors/access-changes/${encodeURIComponent(changeId)}/undo`,
        { method: 'POST', body: '{}' }
      );
    },
  };
}
