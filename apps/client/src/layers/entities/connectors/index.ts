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

// --- The connect flow state machine ---
export { useConnectFlow } from './model/use-connect-flow';
export type { ConnectFlow, ConnectFlowState, ConnectFlowStep } from './model/use-connect-flow';

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
} from '@dorkos/shared/connector-provider';
