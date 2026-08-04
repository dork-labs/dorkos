/**
 * Settings feature — user preferences dialog (theme, font, notifications).
 *
 * @module features/settings
 */
export { SettingsDialog } from './ui/SettingsDialog';
// The Preferences tab on its own. Its "Replay setup" control has to close the
// dialog it sits in, and only `DialogHost` (widgets) decides that a dialog is
// open — so the test that proves it lives up there and needs this export.
export { PreferencesTab } from './ui/tabs/PreferencesTab';
export { TunnelDialog } from './ui/TunnelDialog';
export { ServerRestartOverlay } from './ui/ServerRestartOverlay';

// The Runtimes tab, in the pieces the dev playground renders. Every one of them
// is props-only or owns its own read, which is what the redesign bought: the
// card stack can be shown in states a running server would have to be coaxed
// into (spec `runtimes-settings-redesign`, design decision 7).
export { RuntimeCardView } from './ui/runtimes/RuntimeCardView';
export type { RuntimeCardViewProps } from './ui/runtimes/RuntimeCardView';
export { buildRuntimeCardSummary } from './ui/runtimes/RuntimeCardSummary';
export { GlobalTrustRow } from './ui/runtimes/GlobalTrustRow';
export type { GlobalTrustRowRuntime } from './ui/runtimes/GlobalTrustRow';
export { TrustRow } from './ui/runtimes/rows/TrustRow';
export { ClaudeAccountsSection } from './ui/runtimes/sections/ClaudeAccountsSection';
export { PowerSourceSectionView } from './ui/runtimes/sections/PowerSourceSection';
export { ExecutionExceptionsStrip } from './ui/runtimes/ExecutionExceptionsStrip';
