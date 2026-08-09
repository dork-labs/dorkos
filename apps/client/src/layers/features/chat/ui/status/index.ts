/**
 * Chat status display — the composer status line, the inference status strip, and
 * the strip's themes.
 *
 * @module features/chat/ui/status
 */
export { ChatStatusSection } from './ChatStatusSection';
export { ChatStatusStrip } from './ChatStatusStrip';
export { deriveStripState } from './strip-state';
export type { StripState } from './strip-state';
export { TerminalReasonChip } from './TerminalReasonChip';
export { TurnFailedNotice } from './TurnFailedNotice';
export { DEFAULT_THEME, type IndicatorTheme } from './inference-themes';
