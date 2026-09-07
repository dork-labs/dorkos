/**
 * TanStack Query key factory for connector entity queries.
 *
 * @module entities/connectors/api
 */

export const connectorKeys = {
  all: ['connectors'] as const,

  providers: () => [...connectorKeys.all, 'providers'] as const,
  authenticationFlow: (flowId: string) =>
    [...connectorKeys.connections(), 'authentication-flow', flowId] as const,

  catalog: (query: string) => [...connectorKeys.all, 'catalog', { query }] as const,

  connections: () => [...connectorKeys.all, 'connections'] as const,
  connection: (connectionId: string) =>
    [...connectorKeys.connections(), 'detail', connectionId] as const,
  disconnectImpact: (connectionId: string) =>
    [...connectorKeys.connection(connectionId), 'disconnect-impact'] as const,
  usage: (connectionId: string) => [...connectorKeys.connection(connectionId), 'usage'] as const,
  agentConnections: (agentId: string) =>
    [...connectorKeys.connections(), 'agent', agentId] as const,
  sessionConnections: (sessionId: string) =>
    [...connectorKeys.connections(), 'session', sessionId] as const,

  reviews: () => [...connectorKeys.all, 'reviews'] as const,
  reviewList: (state?: 'pending' | 'resolved') =>
    [...connectorKeys.reviews(), 'list', state ?? 'all'] as const,
  review: (reviewRequestId: string) =>
    [...connectorKeys.reviews(), 'detail', reviewRequestId] as const,
};
