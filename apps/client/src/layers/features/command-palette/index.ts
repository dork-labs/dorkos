/**
 * Command palette — global Cmd+K agent switching and feature access.
 *
 * Enhanced with Fuse.js fuzzy search, Slack bucket frecency,
 * and match highlighting via HighlightedText.
 *
 * @module features/command-palette
 */

// --- UI components ---
export { CommandPaletteDialog } from './ui/CommandPaletteDialog';
export { AgentCommandItem } from './ui/AgentCommandItem';
export { AgentPreviewPanel } from './ui/AgentPreviewPanel';
export { AgentSubMenu } from './ui/AgentSubMenu';
export { HighlightedText } from './ui/HighlightedText';
export { PaletteFooter } from './ui/PaletteFooter';

// --- Model hooks ---
export { useGlobalPalette } from './model/use-global-palette';
export { useAgentFrecency, calcFrecencyScore } from './model/use-agent-frecency';
export type { FrecencyRecord } from './model/use-agent-frecency';
export { usePaletteItems } from './model/use-palette-items';
export type { PaletteItems, SuggestionItem } from './model/use-palette-items';
export { usePaletteSearch, parsePrefix } from './model/use-palette-search';
export type { SearchableItem, SearchResult } from './model/use-palette-search';
export { usePaletteActions } from './model/use-palette-actions';

/** @internal Exported for testing only. */
export { usePreviewData } from './model/use-preview-data';
