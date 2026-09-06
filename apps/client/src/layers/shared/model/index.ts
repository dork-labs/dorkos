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
export { useIsBelowDesktop } from './media/use-is-below-desktop';
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
export { useLongPress } from './interaction/use-long-press';
export type { LongPressState } from './interaction/use-long-press';
export {
  useFeatureEnabled,
  useFeatureEnabledState,
  type FeatureEnabledState,
} from './server-config/use-feature-enabled';
export { useClaudeAccounts } from './server-config/use-claude-accounts';
// The one `/config` query key, here rather than in `entities/config` because
// `shared/` reads config too and may not import an entity. `entities/config`
// re-exports it, so nothing above changes its import.
export { configKeys, CONFIG_STALE_TIME_MS } from './server-config/query-keys';
export { useNow } from './use-now';
// "Has the read answered?" — `isLoading` corrected for the persisted cache. Read
// its doc before reaching for `isLoading` on any surface that renders an
// empty state.
export { usePendingRead } from './query/use-pending-read';
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
export {
  useBrowserNotificationPermission,
  refreshNotificationPermissionForTests,
  type BrowserNotificationPermission,
  type BrowserNotificationPermissionState,
} from './use-notification-permission';
export { useFilterState, type UseFilterStateReturn } from './use-filter-state';
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
  takeProfileOpener,
  clearProfileOpener,
  type DialogDeepLink,
  type ProfileDeepLink,
} from './use-dialog-deep-link';
export { useDeepLinkScroll } from './use-deep-link-scroll';
export {
  useScrollOverflow,
  type ScrollOverflow,
  type ScrollAxis,
} from './scroll/use-scroll-overflow';
export { revealInScroller } from './scroll/reveal-in-scroller';
export { useSafeSearch, useSafeNavigate, useSafePathname, EMBED_PATHNAME } from './use-safe-router';
export {
  useInPlaceNavigate,
  type InPlaceNavigate,
  type InPlaceNavigateOptions,
  type InPlaceSearchUpdater,
  type InPlaceNavigationState,
  type InPlaceBaseDestination,
} from './use-in-place-navigate';

export { useMenuCloseFocusGuard } from './interaction/use-menu-close-focus-guard';
export type { MenuCloseFocusGuard } from './interaction/use-menu-close-focus-guard';
export { useInlineEditorSettle } from './interaction/use-inline-editor-settle';
export type { InlineEditorSettle } from './interaction/use-inline-editor-settle';
export { useDragVsTapGuard } from './interaction/use-drag-vs-tap-guard';
export type {
  DragVsTapGuard,
  DragVsTapPoint,
  DragVsTapClick,
} from './interaction/use-drag-vs-tap-guard';
export {
  useRovingFocus,
  SIDEBAR_ACTIONS_ATTRIBUTE,
  SIDEBAR_DRAGGING_ATTRIBUTE,
  SIDEBAR_GLYPH_ACTION_ATTRIBUTE,
  SIDEBAR_ROW_ATTRIBUTE,
  SIDEBAR_SECTION_ACTION_ATTRIBUTE,
  SIDEBAR_SECTION_TOGGLE_ATTRIBUTE,
  SIDEBAR_TRAILING_ACTION_ATTRIBUTE,
} from './interaction/use-roving-focus';
export type { SidebarDragActivatorProps } from './interaction/use-roving-focus';
export { useRovingGrid } from './interaction/use-roving-grid';
