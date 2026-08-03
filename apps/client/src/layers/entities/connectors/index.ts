/**
 * Connectors entity — domain hooks for connector provider setup, the connect
 * flow (disclosure-before-URL), connected accounts, and session attach/detach
 * (connector-completion spec §Detailed Design 5). All server I/O rides the
 * Transport's connector methods; custody disclosure copy is always the
 * server's, never composed here.
 *
 * @module entities/connectors
 */

// --- Query key factory ---
export { connectorKeys } from './api/query-keys';

// --- Query hooks ---
export { useConnectorProviders } from './model/use-connector-providers';
export { useConnectorToolkits } from './model/use-connector-toolkits';
export { useConnectorAccounts } from './model/use-connector-accounts';
export { useConnectorRecommendation } from './model/use-connector-recommendation';
export { useSessionConnectors } from './model/use-session-connectors';
export { useAgentConnectors } from './model/use-agent-connectors';

// --- The connect flow state machine ---
export { useConnectFlow } from './model/use-connect-flow';
export type { ConnectFlow, ConnectFlowState, ConnectFlowStep } from './model/use-connect-flow';
// The app-wide flow store itself: surfaces normally consume `useConnectFlow`;
// the store is exported for coordination reads (e.g. asserting a closed
// dialog left a waiting flow alive) and test resets.
export { useConnectFlowStore } from './model/connect-flow-store';

// --- Mutation hooks ---
export {
  useSaveConnectorCredential,
  useDeleteConnectorCredential,
} from './model/use-connector-credential';
export type { SaveConnectorCredentialArgs } from './model/use-connector-credential';
export { useDisconnectConnectorAccount } from './model/use-connector-accounts';
export {
  useAttachSessionConnector,
  useDetachSessionConnector,
} from './model/use-session-connectors';
export { useAttachAgentConnector, useDetachAgentConnector } from './model/use-agent-connectors';

// --- Shared DTO types, re-exported for feature layers ---
export type {
  ConnectorProviderStatus,
  ConnectorToolkit,
  ConnectorToolkitsResponse,
  ConnectorRecommendation,
  ConnectorRecommendationsResponse,
  ConnectorAccountsResponse,
  ConnectorWarning,
  PublicConnectedAccount,
  SessionConnectorStatus,
  SessionConnectorAccountStatus,
  SessionConnectorAttachResult,
  SessionConnectorWarning,
  AgentConnectorAttachment,
  AgentConnectorAttachResult,
} from '@dorkos/shared/connector-provider';
