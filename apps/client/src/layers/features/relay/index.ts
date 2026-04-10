/**
 * Relay feature — inter-agent messaging UI with activity feed and endpoint management.
 *
 * @module features/relay
 */
export { RelayPanel } from './ui/RelayPanel';
export { RelayEmptyState } from './ui/RelayEmptyState';
export { ConnectionStatusBanner } from './ui/ConnectionStatusBanner';
export { AdapterCard } from './ui/adapter/AdapterCard';
export { AdapterCardHeader } from './ui/adapter/AdapterCardHeader';
export { AdapterCardBindings } from './ui/adapter/AdapterCardBindings';
export { AdapterCardError } from './ui/adapter/AdapterCardError';
export { AdapterBindingRow } from './ui/adapter/AdapterBindingRow';
export { CatalogCard } from './ui/CatalogCard';
export { MessageTrace } from './ui/MessageTrace';
export { ConfigFieldInput, ConfigFieldGroup } from './ui/ConfigFieldInput';
export { AdapterSetupWizard } from './ui/AdapterSetupWizard';
export { RelayHealthBar } from './ui/RelayHealthBar';
export { AdapterIcon } from './ui/adapter/AdapterIcon';
export { ADAPTER_STATE_DOT_CLASS, ADAPTER_STATE_LABEL } from './lib/adapter-state-colors';
export { DeadLetterSection } from './ui/DeadLetterSection';
export { ComposeMessageDialog } from './ui/ComposeMessageDialog';
export { AdapterEventLog } from './ui/AdapterEventLog';
export { ConnectionsTab } from './ui/ConnectionsTab';
export { RelativeTime } from './ui/RelativeTime';
