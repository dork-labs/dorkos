/**
 * Relay feature — the messaging half of the Connections page: the ways people
 * and platforms reach your agents, what has come through them, and the
 * agent-first flow for adding another.
 *
 * @module features/relay
 */
export { MessagingConnections } from './ui/MessagingConnections';
export { BindingBridgeSection } from './ui/BindingBridgeSection';
export type { BindingBridgeSectionProps } from './ui/BindingBridgeSection';
export { ActivityFeed } from './ui/ActivityFeed';
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
// Re-exported from entities/relay (canonical home for adapter-state data) so
// existing feature consumers keep a single ergonomic import alongside AdapterIcon.
export { ADAPTER_STATE_DOT_CLASS, ADAPTER_STATE_LABEL } from '@/layers/entities/relay';
export { DeadLetterSection } from './ui/DeadLetterSection';
export { ComposeMessageDialog } from './ui/ComposeMessageDialog';
export { AdapterEventLog } from './ui/AdapterEventLog';
export { RelativeTime } from './ui/RelativeTime';
