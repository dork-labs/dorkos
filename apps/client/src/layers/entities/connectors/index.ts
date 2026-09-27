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
export { useConnectorProviders, useConnectorAppConnections } from './model/use-connector-providers';
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
  useEveryAgentConnectorGrants,
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
  useSessionConnectorAgentRequests,
  useConnectorAgentRequest,
  useConnectorAgentRequestAuthentication,
  useResolveConnectorAgentRequest,
  useStartConnectorAgentRequestAuthentication,
  useResolveConnectorManagementReview,
  usePreviewConnectorReconciliation,
  useApplyConnectorReconciliation,
  useStopSharingWithEveryAgent,
  useConnectorReviewAuthentication,
} from './model/use-connector-management';
export { useConnectorAgentRequestsSync } from './model/use-connector-agent-requests-sync';

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
  ConnectorEveryAgentAccess,
  ConnectorEveryAgentGrant,
  ConnectorEveryAgentGrants,
  ConnectorSessionConnections,
  ConnectorSessionEffectiveAccess,
} from '@dorkos/shared/connector-resource-schemas';

export { accessLevelWords, serviceName } from './lib/access-copy';
export { AgentConnectionAccessList, SessionConnectionAccessList } from './ui/ConnectionAccessLists';
export { EveryAgentAccessNotice } from './ui/EveryAgentAccessNotice';
export type { EveryAgentAccessNoticeProps } from './ui/EveryAgentAccessNotice';

// --- What removing a way to reach apps would stop (shared by every confirm) ---
export { appCount, dorkosAccountApps, splitByImpact, toImpactApp } from './lib/connection-impact';
export type { ImpactApp } from './lib/connection-impact';
export { ConnectionImpactList } from './ui/ConnectionImpactList';
