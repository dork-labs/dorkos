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
  TEAM_VIEWS,
  DEFAULT_TEAM_VIEW,
  LEGACY_TABLE_VIEW,
  normalizeTeamView,
  type TeamViewMode,
} from './team-view';
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
export { isDynamicImportError } from './dynamic-import-error';
export {
  claudeAccountName,
  claudeAccountOptions,
  isAbsoluteAccountPath,
  type ClaudeAccountRef,
} from './claude-accounts';
export { isBypassPermissionMode, permissionModeLabel } from './permission-mode';
// The permission-mode derivation rules live in `@dorkos/shared` so the server's
// tests can run every runtime's declared modes through the real functions (see
// that module's header). Re-exported here so client code has one import path.
export {
  stopExpectation,
  isDivergent,
  warnTier,
  isBypassSemantics,
  isAutonomyStop,
  needsConsentRitual,
  isWorkingMode,
  resolveTrustStops,
  findWorkingMode,
  type TrustStop,
  type TrustWarnTier,
} from '@dorkos/shared/permission-semantics';
export { isSessionRequestReady } from './session-request-scope';
export { rankMatch, type MatchTier, type RankMatchResult } from './rank-match';
export { buildClientReport } from './build-issue-report';
export { HttpTransport, streamManager, RoomStreamHttpError, isFatalStreamError } from './transport';
export {
  UPLOAD_STALL_TIMEOUT_MS,
  UPLOAD_STALLED_MESSAGE,
  UPLOAD_CANCELED_MESSAGE,
  UPLOAD_UNREADABLE_MESSAGE,
} from './transport';
export { DirectTransport, type DirectTransportServices } from './direct-transport';
export { reportClientError, installClientErrorHandlers } from './client-error-reporter';
export { getBreadcrumbs, installBreadcrumbHandlers } from './breadcrumbs';
export {
  stashPendingFeedback,
  takePendingFeedback,
  type PendingFeedback,
} from './pending-feedback';
// `formatActivityLabel` is deliberately NOT re-exported here. It is one rung of
// the honesty ladder, and every surface reaches it through `activityVerb` below
// so that one turn cannot be described two ways (BC-37). Withdrawing it from
// the barrel is what makes that a structural fact rather than a convention: the
// only importable path to it is a relative one inside `shared/lib`.
export { getToolLabel, getMcpServerBadge, parseMcpToolName } from './tool-labels';
export { ToolArgumentsDisplay } from './tool-arguments-formatter';
export {
  EMOJI_SET,
  COLOR_PRESETS,
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
export { readableForeground } from './readable-foreground';
export { truncateMiddle } from './truncate-middle';
export { queryClient, createQueryClientConfig, isStreamOwnedQuery } from './query-client';
export { classifyContent, type ContentType } from './classify-content';
export { resolveAgentVisual } from './resolve-agent-visual';
export type { AgentVisual, AgentVisualSource } from './resolve-agent-visual';
export type { IdentityOrigin } from './identity-origin';
export { resolveIdentityFace } from './identity-face';
export type {
  IdentityFace,
  IdentityFaceInput,
  IdentityFaceOverride,
  IdentityRecord,
} from './identity-face';
export { useCopyFeedback } from './use-copy-feedback';
export {
  executeUiCommand,
  revealCanvas,
  type DispatcherContext,
  type DispatcherStore,
  type UiCommandOrigin,
} from './ui-action-dispatcher';
export { registerExtensionRemount, requestExtensionRemount } from './extension-remount';
export {
  composerFileReference,
  registerComposerInsert,
  requestComposerInsert,
} from './composer-insert';
export { FILE_PATH_DRAG_TYPE, hasFilePathDrag, readFilePathDrag } from './file-drag';
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
export { buildTimelineRows, unreadPlacement, GROUP_GAP_MS } from './group-timeline';
export type {
  TimelineItem,
  TimelineRow,
  DayDividerRow,
  UnreadDividerRow,
  PositionedItem,
  UnreadPlacement,
} from './group-timeline';
export { describeAgentExecution, effortLabel, knownModelsFrom } from './execution-config';
export type {
  AgentExecutionReport,
  DescribeAgentExecutionInput,
  ExecutionBreakage,
  ExecutionBreakageKind,
  ExecutionDeviation,
} from './execution-config';

export { activityVerb, WAITING_ON_YOU_VERB } from './activity-verb';

export { isWelcomeBackMoment } from './welcome-back-glow';
export type { WelcomeBackMomentInput } from './welcome-back-glow';
export { setAskDorkBotOrigin, takeAskDorkBotOrigin } from './ask-dorkbot-origin';
export { isNewer } from './version-compare';
