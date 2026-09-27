/**
 * Relay feature — the chat app parts of the Connections page: who answers a
 * chat app and what happened on it lately, the agent-first flow for setting
 * one up, and the message history Settings › Connections keeps.
 *
 * @module features/relay
 */
export { ChatAppAnswerers } from './ui/ChatAppAnswerers';
export { ChatAppRecent } from './ui/ChatAppRecent';
export { BindingBridgeSection } from './ui/BindingBridgeSection';
export type { BindingBridgeSectionProps } from './ui/BindingBridgeSection';
export { ActivityFeed } from './ui/ActivityFeed';
export { ConnectionStatusBanner } from './ui/ConnectionStatusBanner';
export type { ConnectionStatusBannerProps } from './ui/ConnectionStatusBanner';
export { AdapterBindingRow } from './ui/adapter/AdapterBindingRow';
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
