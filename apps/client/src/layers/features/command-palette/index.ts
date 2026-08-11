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
export { PaletteCommandCenter } from './ui/PaletteCommandCenter';
export { PaletteFooter } from './ui/PaletteFooter';
export { PalettePrefixLegend } from './ui/PalettePrefixLegend';
export { RoomCommandItem } from './ui/RoomCommandItem';
export { SessionCommandItem } from './ui/SessionCommandItem';

// --- Model hooks ---
export { useGlobalPalette } from './model/use-global-palette';
export { useAgentFrecency, calcFrecencyScore } from './model/use-agent-frecency';
export type { FrecencyRecord } from './model/use-agent-frecency';
export { usePaletteItems } from './model/use-palette-items';
export type {
  PaletteItems,
  FeatureItem,
  QuickActionItem,
  CommandItemData,
} from './model/use-palette-items';
// The three row models `PaletteItems` is made of (§15). Types only: the
// builders behind them are the slice's own business, and nothing outside it has
// any reason to assemble a palette row.
export type { PaletteSessionItem } from './model/palette-sessions';
export type { PaletteRecentEntry } from './model/palette-recent';
export type { PaletteContinueRow } from './model/use-palette-command-center';
export { usePaletteRooms } from './model/use-palette-rooms';
export type { PaletteRooms } from './model/use-palette-rooms';
export {
  compareRoomsForPalette,
  sortRoomsForPalette,
  paletteRoomKeywords,
} from './model/palette-rooms';
export { usePaletteSearch, parsePrefix } from './model/use-palette-search';
export type { SearchableItem, SearchResult } from './model/use-palette-search';
// The blended ranking (design-decisions §15) and the row it draws. Exported for
// ONE caller: the Dev Playground's ranked-results showcase, which runs the real
// scorer over a mock corpus rather than hand-drawing a list that looks like one.
// A showcase that fakes the order is how a heading can go stale for a month —
// this way the playground is wrong only when the product is.
export { rankCandidates, selectBestMatch, groupRankedRows } from './model/palette-ranking';
export type { RankCandidate, RankedRow } from './model/palette-ranking';
export { PaletteResultRow } from './ui/PaletteResultRow';
export { RESULT_GROUP_LABEL, BEST_MATCH_HEADING } from './ui/palette-constants';
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
