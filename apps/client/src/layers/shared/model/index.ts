/**
 * Shared model — global hooks, Zustand stores, and Transport context.
 *
 * @module shared/model
 */
export { TransportProvider, useTransport } from './TransportContext';
export { useAppStore, type ContextFile, type RecentCwd } from './app-store';
export { useAppTabsStore, useAppTabs, type AppTab } from './app-tabs/app-tabs-store';
export type { SettingsTab } from './app-store/app-store-panels';
export type { CanvasDocument, BrowserHistoryState } from './app-store/app-store-canvas';
export type { PipContent } from './app-store/app-store-pip';
export { useDialogTabState } from './use-dialog-tab-state';
export {
  useTheme,
  useResolvedTheme,
  useThemeStore,
  type Theme,
  type ResolvedTheme,
} from './use-theme';
export { useReportIssue } from './report-issue/use-report-issue';
export { useIsMobile } from './media/use-is-mobile';
export { useIsTouchOnly } from './media/use-is-touch-only';
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
export type { LongPressState } from './use-long-press';
export { useFeatureEnabled } from './server-config/use-feature-enabled';
export { useClaudeAccounts } from './server-config/use-claude-accounts';
export { useNow } from './use-now';
// The WAI-ARIA feed pattern. `Feed` (in `shared/ui`) and `feedArticleProps`
// are what a surface uses; `useFeedKeyboardNav` and `FEED_ARTICLE_ATTR` are the
// parts a surface only needs if it builds its own container, which nothing does
// yet — so knip flags them, and they stay: the room timeline and the thread
// panel both reach for `Feed` itself, and a hook a later surface has to go
// fishing for is a hook that surface reimplements.
export { useFeedKeyboardNav, FEED_ARTICLE_ATTR } from './feed/use-feed-keyboard-nav';
export type {
  FeedKeyboardNav,
  FeedKeyboardNavOptions,
  FeedBeyondRenderedHandler,
} from './feed/use-feed-keyboard-nav';
export { feedArticleProps } from './feed/feed-articles';
export type { FeedPosition, FeedArticleProps } from './feed/feed-articles';
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
  useFeedbackDialogStore,
  type FeedbackPrefill,
} from './feedback-dialog/feedback-dialog-store';
export {
  useAgentBirthStore,
  useAgentBirthRecord,
  type AgentBirthRecord,
} from './agent-birth/agent-birth-store';
export type {
  ChatMessage,
  ChatStatus,
  MessageGrouping,
  GroupPosition,
  MessageAuthor,
} from './chat-message-types';
export { useTabVisibility } from './use-tab-visibility';
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
  isExtensionContributionId,
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
  type SuggestionChipContribution,
} from './extension-registry';
export { dialogSearchSchema, mergeDialogSearch, type DialogSearch } from './dialog-search-schema';
export {
  useSettingsDeepLink,
  useTasksDeepLink,
  useProfileDeepLink,
  useOpenConnections,
  clearedDialogSearch,
  isDualSignalDialog,
  type DialogDeepLink,
  type ProfileDeepLink,
} from './use-dialog-deep-link';
export { useDeepLinkScroll } from './use-deep-link-scroll';
export { useSafeSearch, useSafeNavigate, useSafePathname, EMBED_PATHNAME } from './use-safe-router';
export {
  useInPlaceNavigate,
  type InPlaceNavigate,
  type InPlaceNavigateOptions,
  type InPlaceSearchUpdater,
  type InPlaceNavigationState,
  type InPlaceBaseDestination,
} from './use-in-place-navigate';

export { useMenuCloseFocusGuard } from './use-menu-close-focus-guard';
export type { MenuCloseFocusGuard } from './use-menu-close-focus-guard';
export {
  useRovingFocus,
  SIDEBAR_ROW_ATTRIBUTE,
  SIDEBAR_SECTION_TOGGLE_ATTRIBUTE,
} from './use-roving-focus';
export type { RovingFocusProps } from './use-roving-focus';
