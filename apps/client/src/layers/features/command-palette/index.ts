/**
 * Command palette — global Cmd+K agent switching and feature access.
 *
 * Enhanced with Fuse.js fuzzy search, Slack bucket frecency,
 * and match highlighting via HighlightedText.
 *
 * @module features/command-palette
 */
export { CommandPaletteDialog } from './ui/CommandPaletteDialog';
export { useGlobalPalette } from './model/use-global-palette';
export { useAgentFrecency } from './model/use-agent-frecency';
export { usePaletteSearch } from './model/use-palette-search';
export type { SearchableItem, SearchResult } from './model/use-palette-search';
