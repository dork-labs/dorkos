/**
 * Shared lib — domain-agnostic utilities, Transport implementations, and helpers.
 *
 * @module shared/lib
 */
export { cn } from './utils';
export { getPlatform, setPlatformAdapter, isMac, type PlatformAdapter } from './platform';
export { fuzzyMatch } from './fuzzy-match';
export { HttpTransport } from './transport';
export { DirectTransport, type DirectTransportServices } from './direct-transport';
export { getToolLabel, getMcpServerBadge, parseMcpToolName } from './tool-labels';
export { ToolArgumentsDisplay } from './tool-arguments-formatter';
export {
  EMOJI_SET,
  fnv1aHash,
  hashToHslColor,
  hashToEmoji,
  generateCircleFavicon,
  generatePulseFrames,
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
export {
  fireConfetti,
  RADIAL_GLOW_STYLE,
  MINI_SPRING_CONFIG,
  SHIMMER_STYLE,
} from './celebrations/effects';
export {
  STORAGE_KEYS,
  FONT_SCALE_MAP,
  MAX_RECENT_CWDS,
  TIMING,
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
export { classifyContent, type ContentType } from './classify-content';
export { resolveAgentVisual } from './resolve-agent-visual';
export type { AgentVisual, AgentVisualSource } from './resolve-agent-visual';
export {
  executeUiCommand,
  type DispatcherContext,
  type DispatcherStore,
} from './ui-action-dispatcher';
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
