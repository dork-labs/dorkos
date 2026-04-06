/**
 * Shared model — global hooks, Zustand stores, and Transport context.
 *
 * @module shared/model
 */
export { TransportProvider, useTransport } from './TransportContext';
export { useAppStore, type ContextFile, type RecentCwd } from './app-store';
export type { AgentDialogTab, SettingsTab } from './app-store/app-store-panels';
export { useDialogTabState } from './use-dialog-tab-state';
export { useTheme, type Theme } from './use-theme';
export { useIsMobile } from './use-is-mobile';
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
export { useAgentCreationStore } from './agent-creation-store';
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
  type SidebarTabContribution,
  type DashboardSectionContribution,
  type HeaderActionContribution,
  type CommandPaletteContribution,
  type DialogContribution,
  type SettingsTabContribution,
  type SessionCanvasContribution,
} from './extension-registry';
