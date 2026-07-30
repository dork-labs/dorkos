/**
 * Shared lib — domain-agnostic utilities, Transport implementations, and helpers.
 *
 * @module shared/lib
 */
export { cn } from './utils';
export { resolveApiBaseUrl } from './api-base-url';
export {
  getAuthRequired,
  setAuthRequired,
  subscribeAuthRequired,
  getOwnerSetupRequest,
  requestOwnerSetup,
  clearOwnerSetupRequest,
  subscribeOwnerSetupRequest,
  type OwnerSetupRequest,
} from './auth-signal';
export {
  getPlatform,
  setPlatformAdapter,
  isMac,
  isDesktopDarwin,
  isDesktopShell,
  localDeviceNoun,
  type PlatformAdapter,
} from './platform';
export {
  APP_ROUTE_PATHS,
  classifyLink,
  openLink,
  openExternalLink,
  registerLinkNavigator,
  registerTabOpener,
  supportsNewTab,
  supportsSeparateWindow,
  type BlockedLink,
  type BlockedLinkReason,
  type ClassifiedLink,
  type ExternalLink,
  type InternalLink,
  type LinkNavigation,
  type LinkNavigator,
  type LinkTarget,
  type OpenLinkOptions,
  type TabOpener,
} from './link-navigation';
export { initialOf } from './initial-of';
export {
  claudeAccountName,
  claudeAccountOptions,
  isAbsoluteAccountPath,
  type ClaudeAccountRef,
} from './claude-accounts';
export { isBypassPermissionMode, permissionModeLabel } from './permission-mode';
export { isSessionRequestReady } from './session-request-scope';
export { rankMatch, type MatchTier, type RankMatchResult } from './rank-match';
export { buildClientReport } from './build-issue-report';
export { HttpTransport, streamManager } from './transport';
export { DirectTransport, type DirectTransportServices } from './direct-transport';
export { reportClientError, installClientErrorHandlers } from './client-error-reporter';
export { getToolLabel, getMcpServerBadge, parseMcpToolName } from './tool-labels';
export { ToolArgumentsDisplay } from './tool-arguments-formatter';
export {
  EMOJI_SET,
  fnv1aHash,
  hashToHslColor,
  hashToEmoji,
  generateCircleFavicon,
  generateTasksFrames,
  setFavicon,
} from './favicon-utils';
export { playNotificationSound } from './notification-sound';
export { playSliderTick, playCelebration } from './sound';
export {
  groupSessionsByTime,
  shortenHomePath,
  formatRelativeTime,
  type TimeGroup,
  type GroupedSessions,
} from './session-utils';
export {
  type FontFamilyKey,
  type FontConfig,
  DEFAULT_FONT,
  getFontConfig,
  isValidFontKey,
  FONT_CONFIGS,
} from './font-config';
export { loadGoogleFont, removeGoogleFont, applyFontCSS, removeFontCSS } from './font-loader';
export {
  CelebrationEngine,
  type CelebrationLevel,
  type CelebrationEvent,
  type CelebrationEngineConfig,
} from './celebrations/celebration-engine';
export { RADIAL_GLOW_STYLE, MINI_SPRING_CONFIG, SHIMMER_STYLE } from './celebrations/effects';
export {
  fireCelebration,
  rectToCelebrationOrigin,
  DEFAULT_CELEBRATION_ORIGIN,
  type CelebrationOrigin,
} from './celebrations/celebration-effects';
export {
  STORAGE_KEYS,
  FONT_SCALE_MAP,
  MAX_RECENT_CWDS,
  MAX_CANVAS_SESSIONS,
  MAX_CANVAS_DOCUMENTS,
  MAX_RIGHT_PANEL_LAYOUTS,
  TIMING,
  LONG_PRESS_DRIFT_PX,
  QUERY_TIMING,
  CELEBRATIONS,
  TIME_UNITS,
  SSE_RESILIENCE,
} from './constants';
export type { FileEntry } from './file-types';
export { createChannel, type Channel } from './broadcast-channel';
export {
  SHORTCUTS,
  SHORTCUT_GROUP_LABELS,
  SHORTCUT_GROUP_ORDER,
  formatShortcutKey,
  getShortcutsGrouped,
  type ShortcutDef,
  type ShortcutGroup,
} from './shortcuts';
export {
  DEFAULT_TEXT_EFFECT,
  resolveStreamdownAnimation,
  useTextEffectConfig,
} from './text-effects';
export type { TextEffectMode, TextEffectConfig } from './text-effects';
export { useAppForm, withForm, formOptions, useFieldContext, useFormContext } from './form';
export { formatDuration } from './format-duration';
export { humanizePackageName, packageDisplayLabel, isSingleEmoji } from './humanize-name';
export { truncateMiddle } from './truncate-middle';
export { queryClient, createQueryClientConfig } from './query-client';
export { classifyContent, type ContentType } from './classify-content';
export { resolveAgentVisual } from './resolve-agent-visual';
export type { AgentVisual, AgentVisualSource } from './resolve-agent-visual';
export { useCopyFeedback } from './use-copy-feedback';
export {
  executeUiCommand,
  type DispatcherContext,
  type DispatcherStore,
  type UiCommandOrigin,
} from './ui-action-dispatcher';
export { registerExtensionRemount, requestExtensionRemount } from './extension-remount';
export {
  buildUiStateSnapshot,
  prepareUiStateForSend,
  clearUiStateSendCache,
  type UiStateSource,
  type PreparedUiState,
} from './ui-state-snapshot';
export {
  textFilter,
  enumFilter,
  dateRangeFilter,
  booleanFilter,
  numericRangeFilter,
  createFilterSchema,
  createSortOptions,
  applySortAndFilter,
  isEnumFilter,
  type FilterDefinition,
  type EnumFilterDefinition,
  type FilterSchema,
  type FilterValues,
} from './filter-engine';
export { getAgentDisplayName, slugifyAgentName } from '@dorkos/shared/validation';
export { buildTimelineRows, GROUP_GAP_MS } from './group-timeline';
export type { TimelineItem, TimelineRow, DayDividerRow, UnreadDividerRow } from './group-timeline';
