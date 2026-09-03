/**
 * Command palette — global Cmd+K agent switching and feature access.
 *
 * Fuse.js fuzzy search, one blended ranking across types, scope chips, and
 * match highlighting via HighlightedText. It keeps no memory of its own: what
 * this person uses lives in `entities/interactions`, which the sidebar reads
 * too.
 *
 * @module features/command-palette
 */

// --- UI components ---
export { CommandPaletteDialog } from './ui/CommandPaletteDialog';
export { AgentCommandItem } from './ui/AgentCommandItem';
export { AgentPreviewPanel } from './ui/AgentPreviewPanel';
export { AgentSubMenu } from './ui/AgentSubMenu';
export { HighlightedText } from './ui/HighlightedText';
// The second search surface (spec `message-search` §8). ⌘K finds things by what
// they are CALLED; this finds them by what was SAID in them, and the app shell
// mounts both.
export { MessageSearchDialog } from './ui/MessageSearchDialog';
export { PaletteCommandCenter } from './ui/PaletteCommandCenter';
export { PaletteFooter } from './ui/PaletteFooter';
export { PalettePrefixLegend } from './ui/PalettePrefixLegend';
// The scope chip and the heading a scoped list carries, for the Dev
// Playground's scoped showcase — the same "render the shipped component"
// rule the ranked-results showcase follows.
export { PaletteScopeChip } from './ui/PaletteScopeChip';
export { scopeHeading, type PaletteScope } from './model/palette-scope';
export { RoomCommandItem } from './ui/RoomCommandItem';
export { SessionCommandItem } from './ui/SessionCommandItem';

// --- Model hooks ---
export { useGlobalPalette } from './model/use-global-palette';
// ⌘⇧F. Exported for the shortcut registry's own gate
// (`__tests__/shortcuts-registered.test.tsx`), which mounts every window-level
// chord's owner and fires the real keystroke at it.
export { useMessageSearchShortcut } from './model/use-message-search-shortcut';
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
// The rows that exist only while remote access is in a state where they would
// do something — derived per render rather than registered at startup.
export {
  remoteAccessPaletteItems,
  useRemoteAccessPaletteItems,
  REMOTE_ACCESS_PALETTE_ACTIONS,
} from './model/palette-remote-access';

/** @internal Exported for testing only. */
export { usePreviewData } from './model/use-preview-data';
