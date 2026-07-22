/**
 * Shared model — global hooks, Zustand stores, and Transport context.
 *
 * @module shared/model
 */
export { TransportProvider, useTransport } from './TransportContext';
export { useAppStore, type ContextFile, type RecentCwd } from './app-store';
export type { SettingsTab } from './app-store/app-store-panels';
export type { CanvasDocument, BrowserHistoryState } from './app-store/app-store-canvas';
export type { PipContent } from './app-store/app-store-pip';
export { useDialogTabState } from './use-dialog-tab-state';
export { useTheme, type Theme } from './use-theme';
export { useReportIssue } from './report-issue/use-report-issue';
export { useIsMobile } from './use-is-mobile';
export { useVisualViewportBottomInset } from './viewport/use-visual-viewport-inset';
export { useFavicon } from './use-favicon';
export { useDocumentTitle } from './use-document-title';
export { useElapsedTime } from './use-elapsed-time';
export {
  useIdleDetector,
  type IdleDetectorOptions,
  type IdleDetectorState,
} from './use-idle-detector';
export { useInteractiveShortcuts } from './use-interactive-shortcuts';
export { useLongPress } from './use-long-press';
export { useFeatureEnabled } from './use-feature-enabled';
export { useNow } from './use-now';
export {
  useAgentCreationStore,
  type CreationMode,
  type CreationOrigin,
  type CreationSeed,
  type CreationSeedTemplate,
  type CreationOpenOptions,
} from './agent-creation-store';
export { useImportProjectsStore } from './import-projects-store';
export {
  useAgentBirthStore,
  useAgentBirthRecord,
  type AgentBirthRecord,
} from './agent-birth/agent-birth-store';
export { useTabVisibility } from './use-tab-visibility';
export {
  useSSEConnection,
  type UseSSEConnectionOptions,
  type UseSSEConnectionReturn,
} from './use-sse-connection';
export { useFilterState, type UseFilterStateReturn } from './use-filter-state';
export { useDebouncedInput } from './use-debounced-input';
export {
  EventStreamProvider,
  useEventStream,
  useEventSubscription,
  type EventHandler,
  type SubscribeFn,
  type KnownEvent,
  type EventStreamContextValue,
} from './event-stream-context';
export {
  useExtensionRegistry,
  useSlotContributions,
  createInitialSlots,
  SLOT_IDS,
  type SlotId,
  type SlotContributionMap,
  type BaseContribution,
  type SidebarFooterContribution,
  type SidebarBodyContribution,
  type DashboardSectionContribution,
  type CommandPaletteContribution,
  type DialogContribution,
  type SettingsTabContribution,
  type RightPanelContribution,
} from './extension-registry';
export { dialogSearchSchema, mergeDialogSearch, type DialogSearch } from './dialog-search-schema';
export {
  useSettingsDeepLink,
  useTasksDeepLink,
  useRelayDeepLink,
  type DialogDeepLink,
} from './use-dialog-deep-link';
export { useDeepLinkScroll } from './use-deep-link-scroll';
export { useSafeSearch, useSafePathname, EMBED_PATHNAME } from './use-safe-router';
