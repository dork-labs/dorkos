/**
 * Connector Transport methods factory (HTTP adapter) — provider setup, the
 * connect flow, connected accounts, and session attach/detach (connector-
 * completion spec §Detailed Design 5). Talks to the Express
 * `/api/connectors/*` and `/api/sessions/:id/connectors` routes.
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
  };
}
