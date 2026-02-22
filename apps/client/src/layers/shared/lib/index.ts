/**
 * Shared lib — domain-agnostic utilities, Transport implementations, and helpers.
 *
 * @module shared/lib
 */
export { cn } from './utils';
export { getPlatform, setPlatformAdapter, type PlatformAdapter } from './platform';
export { fuzzyMatch } from './fuzzy-match';
export { HttpTransport } from './http-transport';
export { DirectTransport, type DirectTransportServices } from './direct-transport';
export { getToolLabel } from './tool-labels';
export { ToolArgumentsDisplay } from './tool-arguments-formatter';
export {
  fnv1aHash,
  hashToHslColor,
  hashToEmoji,
  generateCircleFavicon,
  generateDimmedFavicon,
  generatePulseFrames,
  setFavicon,
  updateTabBadge,
} from './favicon-utils';
export { playNotificationSound } from './notification-sound';
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
} from './constants';
