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
export { PalettePrefixLegend } from './ui/PalettePrefixLegend';
export { RoomCommandItem } from './ui/RoomCommandItem';

// --- Model hooks ---
export { useGlobalPalette } from './model/use-global-palette';
export { useAgentFrecency, calcFrecencyScore } from './model/use-agent-frecency';
export type { FrecencyRecord } from './model/use-agent-frecency';
export { usePaletteItems } from './model/use-palette-items';
export type {
  PaletteItems,
  SuggestionItem,
  FeatureItem,
  QuickActionItem,
  CommandItemData,
} from './model/use-palette-items';
export { usePaletteRooms } from './model/use-palette-rooms';
export type { PaletteRooms } from './model/use-palette-rooms';
export {
  compareRoomsForPalette,
  sortRoomsForPalette,
  paletteRoomKeywords,
} from './model/palette-rooms';
export { usePaletteSearch, parsePrefix } from './model/use-palette-search';
export type { SearchableItem, SearchResult } from './model/use-palette-search';
export { usePaletteActions } from './model/use-palette-actions';
// The writer half of the extension-contributed action dispatch. `main.tsx`
// hands these to the extension API; the reader (`runPaletteCommandHandler`)
// stays inside the slice, where `usePaletteActions` is the only caller.
export {
  registerPaletteCommandHandler,
  unregisterPaletteCommandHandler,
} from './model/palette-command-handlers';

// --- Contribution data ---
export {
  PALETTE_FEATURES,
  PALETTE_QUICK_ACTIONS,
  PALETTE_DEV_ACTIONS,
} from './model/palette-contributions';

/** @internal Exported for testing only. */
export { usePreviewData } from './model/use-preview-data';
