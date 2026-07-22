/**
 * Connector gateway service barrel — the server-side surface of the
 * `ConnectorProvider` seam (connector-gateway spec). Re-exports the registry,
 * the routing surface, the custody-disclosure copy, the per-session tool
 * exposure binder, and the shipped provider backends.
 *
 * Exposed as the `@dorkos/server/services/connectors` subpath so the eval
 * harness (`@dorkos/evals`) can express the W4 connector evals against the real
 * routing/registry/exposure code with fakes, without reaching into internal
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
  SessionConnectorService,
  type SessionConnectorServiceOpts,
  type SessionConnectorStatus,
  type SessionConnectorAccountStatus,
  type SessionConnectorWarning,
  type SessionMcpServers,
  type AttachResult,
} from './session-exposure.js';
export {
  ComposioConnectorProvider,
  maybeCreateComposioProvider,
  toConnectedAccountId,
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
  type ComposioMcpSession,
  type ComposioAccountStatus,
} from './providers/composio-client.js';
export {
  RawMcpConnectorProvider,
  type RawMcpConnectorProviderOpts,
  type RawMcpServerDescriptor,
  type RemoteMcpConnection,
} from './providers/raw-mcp.js';
// The credential port the managed provider funnels its vendor key through — the
// dependency surface of `maybeCreateComposioProvider`, re-exported so the W4
// Gmail eval can assert the refined eval-13 oracle (only the vendor API-key ref
// is resolved, never a per-account token ref).
export type { CredentialProvider, CredentialResolution } from '../core/credential-provider.js';
