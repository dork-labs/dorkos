/**
 * Connectors entity — domain hooks for connector provider setup, the connect
 * flow (disclosure-before-URL), connected accounts, owner management reviews,
 * and exact agent-access reconciliation. All server I/O rides the Transport's
 * connector methods; custody disclosure copy is always the server's, never
 * composed here.
 *
 * @module entities/connectors
 */

// --- Query key factory ---
export { connectorKeys } from './api/query-keys';

// --- Query hooks ---
export { useConnectorProviders } from './model/use-connector-providers';
export {
  useConfigureConnectionEventSource,
  useConnectionEventDefinitions,
  useConnectionEventSource,
  useConnectionEventSubscriptions,
  useCreateConnectionEventSubscription,
  useDeleteConnectionEventSubscription,
} from './model/use-connector-events';
export {
  useConnectorCatalog,
  useConnectorConnections,
  useConnectorConnection,
  useConnectorDisconnectImpact,
  useAgentConnectorConnections,
  useSessionConnectorConnections,
  useConnectorUsage,
  useStartConnectorAuthentication,
  useConnectorAuthentication,
  useRenameConnectorConnection,
  useReconnectConnectorConnection,
  usePauseConnectorConnection,
  useResumeConnectorConnection,
  useDisconnectConnectorConnection,
  useRemoveConnectorConnection,
} from './model/use-connector-resources';

// --- Mutation hooks ---
export {
  useSaveConnectorCredential,
  useDeleteConnectorCredential,
} from './model/use-connector-credential';
export type { SaveConnectorCredentialArgs } from './model/use-connector-credential';
export {
  useConnectorManagementReviews,
  useConnectorManagementReview,
  useConnectorAgentRequests,
  useConnectorAgentRequest,
  useConnectorAgentRequestAuthentication,
  useResolveConnectorAgentRequest,
  useStartConnectorAgentRequestAuthentication,
  useResolveConnectorManagementReview,
  usePreviewConnectorReconciliation,
  useApplyConnectorReconciliation,
  useConnectorReviewAuthentication,
} from './model/use-connector-management';

// --- Shared DTO types, re-exported for feature layers ---
export type {
  ConnectorProviderStatus,
  ConnectorToolkit,
  ConnectorRecommendation,
} from '@dorkos/shared/connector-provider';
export type {
  ConnectorManagementReviewItem,
  ConnectorAgentRequestItem,
  ConnectorManagementReviewContext,
  ConnectorReconciliationPreview,
  ConnectorReconciliationCandidate,
  ConnectorReconciliationGrantSelection,
} from '@dorkos/shared/connector-schemas';
export type {
  ConnectorAgentConnection,
  ConnectorAgentConnections,
  ConnectorAuthenticationFlowState,
  ConnectorCatalogIntent,
  ConnectorCatalogProviderRoute,
  ConnectorCatalogService,
  ConnectorConnectionDetail,
  ConnectorConnectionSummary,
  ConnectorDisconnectImpact,
  ConnectorSessionConnections,
  ConnectorSessionEffectiveAccess,
} from '@dorkos/shared/connector-resource-schemas';

export { AgentConnectionAccessList, SessionConnectionAccessList } from './ui/ConnectionAccessLists';
export { EmbeddedConnectionsNotice } from './ui/EmbeddedConnectionsNotice';
