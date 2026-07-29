/**
 * Connections feature — the working parts of the /connections surface
 * (provider setup, service-first grid, connect flow, accounts list) plus the
 * session view's quiet Connectors group (connector-completion spec §Detailed
 * Design 5).
 *
 * @module features/connections
 */
export { ProviderSetup } from './ui/ProviderSetup';
export { ProviderSetupCard } from './ui/ProviderSetupCard';
export { ServiceGrid, ServiceTile } from './ui/ServiceGrid';
export { ConnectDialog } from './ui/ConnectDialog';
export { AccountsList, AccountRow } from './ui/AccountsList';
export { SessionConnectorsGroup } from './ui/SessionConnectorsGroup';
