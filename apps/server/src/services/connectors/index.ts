/**
 * Connector gateway service barrel — the server-side surface of the
 * `ConnectorProvider` seam (connector-gateway spec). Re-exports the registry,
 * the provider bootstrapper (lifecycle + live reload),
 * the agent-facing discovery domain, brokered execution, routing, custody
 * disclosures, canonical session overrides, and the shipped provider backends.
 *
 * Exposed as the `@dorkos/server/services/connectors` subpath so the eval
 * harness (`@dorkos/evals`) can express the W4 connector evals against the real
 * routing, registry, and broker code with fakes, without reaching into internal
 * source paths.
 *
 * @module services/connectors
 */
export {
  ConnectorRegistry,
  type ConnectorRegistryOpts,
  type ConnectorWarning,
  type AggregatedAccounts,
  type AggregatedToolkits,
  type ConnectedAccountBinding,
} from './registry.js';
export {
  ConnectorProviderBootstrapper,
  TEST_CONNECTOR_PROVIDER_TYPE,
  TEST_CONNECTOR_CREDENTIAL_NAME,
  TEST_CONNECTOR_API_KEY_REF,
  type ConnectorProviderBootstrapperOpts,
} from './bootstrap.js';
export { connectorDomain, type ConnectorCapabilityDeps } from './connector-capabilities.js';
export {
  connectorExecutionDomain,
  type ConnectorExecutionCapabilityDeps,
} from './execution/execution-capabilities.js';
export {
  ConnectorExecutionAuthorizationService,
  type AuthorizedConnectorExecution,
  type ConnectorAgentOwnershipPort,
  type PrepareConnectorExecutionInput,
} from './execution/authorization-service.js';
export {
  ConnectorExecutionBroker,
  type ConnectorBrokerExecutionInput,
  type ConnectorExecutionPrincipalRevalidationPort,
} from './execution/execution-broker.js';
export {
  ManagedConnectorExecutionContextStore,
  type ManagedConnectorExecutionContext,
  type ManagedConnectorExecutionContextBindingPort,
} from './execution/managed-execution-context.js';
export {
  ManagedUsageMirrorError,
  ManagedUsageMirrorService,
  type ManagedReceiptRecoveryCloudPort,
  type ManagedUsageMirrorServiceOptions,
} from './execution/managed-usage-mirror-service.js';
export {
  ConnectorOperatorQueryService,
  ConnectorOperatorQueryError,
  type ConnectorOperatorQueryServiceOptions,
} from './resources/operator-query-service.js';
export {
  ConnectorUsageEvidenceError,
  ConnectorUsageStore,
  type ConnectorUsageIntentInput,
  type ConnectorUsageOutcome,
  type ConnectorUsageTerminalInput,
} from './execution/usage-store.js';
export {
  ConnectorAccessQueryError,
  ConnectorAccessQueryService,
  type ConnectorOperatorUsageQuery,
  type ConnectorUsageQuery,
} from './execution/access-query-service.js';
export { ConnectorProgramPrincipalService } from './principal/program-principal-service.js';
export {
  recommendConnector,
  type RecommendConnectorResult,
  type RecommendConnectorDeps,
  type RelayAdapterCatalog,
} from './routing.js';
export {
  custodyDisclosure,
  disclosureForAccount,
  MANAGED_CUSTODY_CANONICAL_SENTENCE,
  type CustodyDisclosureContext,
  type DisclosableAccount,
} from './custody-disclosure.js';
export {
  SessionConnectorAttachmentStore,
  type SessionConnectorOverride,
  type SessionConnectorOverrideState,
} from './attachment-store.js';
export {
  registerConnectorAgentCleanup,
  type ConnectorAgentCleanupDeps,
} from './agent-access-cleanup.js';
export type { ConnectorAuthorityCleanupPort } from './authority-cleanup-port.js';
export {
  CONNECTOR_RUNTIME_CAPABILITY_IDS,
  CONNECTOR_RUNTIME_EXECUTION_CAPABILITY_IDS,
  isConnectorRuntimeCapabilityId,
  type ConnectorRuntimeCapabilityId,
  type ConnectorRuntimeExecutionCapabilityId,
} from './runtime-capability-scope.js';
export type {
  ConnectorRuntime,
  ConnectorRuntimeBindingBootPort,
  ConnectorRuntimePrincipalPort,
  ConnectorTurnRefusalReason,
  OpenConnectorTurnInput,
  OpenConnectorTurnResult,
  ResolveConnectorTurnInput,
  ResolveConnectorTurnResult,
  RevokeConnectorTurnReason,
} from './runtime-principal-port.js';
export {
  ComposioConnectorProvider,
  maybeCreateComposioProvider,
  toExternalAccountRef,
  toComposioAccountId,
  COMPOSIO_PROVIDER_TYPE,
  COMPOSIO_CREDENTIAL_NAME,
  COMPOSIO_API_KEY_REF,
  DEFAULT_COMPOSIO_USER_ID,
  type ComposioConnectorProviderOpts,
  type MaybeCreateComposioProviderDeps,
} from './providers/composio.js';
export {
  ComposioApiError,
  type ComposioHttpClient,
  type ComposioToolkitInfo,
  type ComposioConnectionRequest,
  type ComposioConnectionState,
  type ComposioConnectedAccount,
  type ComposioAccountStatus,
} from './providers/composio-client.js';
export {
  RawMcpConnectorProvider,
  type RawMcpConnectorProviderOpts,
  type RawMcpServerDescriptor,
  type RemoteMcpConnection,
} from './providers/raw-mcp.js';
export {
  NangoConnectorProvider,
  NangoEncryptionKeyError,
  maybeCreateNangoProvider,
  assertNangoEncryptionKey,
  toExternalAccountRef as toNangoExternalAccountRef,
  toNangoConnectionId,
  NANGO_PROVIDER_TYPE,
  NANGO_CREDENTIAL_NAME,
  NANGO_SECRET_KEY_REF,
  type NangoConnectorProviderOpts,
  type MaybeCreateNangoProviderDeps,
} from './providers/nango.js';
export {
  NangoApiError,
  FetchNangoHttpClient,
  type NangoHttpClient,
  type NangoIntegration,
  type NangoConnectionRequest,
  type NangoConnectionState,
  type NangoConnection,
  type NangoConnectionStatus,
  type FetchNangoHttpClientOpts,
} from './providers/nango-client.js';
// The credential port the managed provider funnels its vendor key through — the
// dependency surface of `maybeCreateComposioProvider`, re-exported so the W4
// Gmail eval can assert the refined eval-13 oracle (only the vendor API-key ref
// is resolved, never a per-account token ref).
export type { CredentialProvider, CredentialResolution } from '../core/credential-provider.js';

export {
  isServerPrincipal,
  type ConnectorOwnerAuthority,
  type ServerPrincipalClaims,
  type ServerPrincipalProof,
} from './principal/server-principal.js';
