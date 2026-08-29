/**
 * File-explorer feature — one pane over anything that has files in it.
 *
 * Over a session's working directory it is the Files right-panel tab (spec
 * right-panel-workbench, Chunk B): a lazy, worktree-aware tree with full CRUD
 * (create / rename / delete / drag-to-move), optimistic UI with rollback, and
 * keyboard navigation. Clicking a file opens it in the canvas via the shared
 * `open_file` command seam (`executeUiCommand`), the same seam the agent's
 * `open_file` tool drives.
 *
 * Over a room's own files (spec `project-rooms` §3.9) the same tree is
 * read-only, shows who last touched each entry, and previews a file in place —
 * because what it lists is the commit `main` points at rather than a directory
 * on disk. What differs between the two is a {@link FileExplorerSource}, and
 * nothing else.
 *
 * **It stays a feature rather than moving down to `entities`.** It is not a
 * business entity — it is a stateful pane with a store, a keyboard model, a
 * clipboard and mutations. Sibling features may compose its UI, which is how
 * the room panel mounts {@link RoomFilesSection}; and staying here is what lets
 * its model reach `entities/room` for the stream that tells it to look again,
 * an import an entity would not be allowed to make.
 *
 * The right-panel contribution lazy-loads this module, so it lands in its own
 * async chunk.
 *
 * @module features/file-explorer
 */
export { FileExplorer } from './ui/FileExplorer';
export type { FileExplorerProps } from './ui/FileExplorer';
export { FileExplorerActions } from './ui/FileExplorerActions';
export { HiddenEntriesToggle } from './ui/HiddenEntriesToggle';
// `PendingWorkBadge`, `RoomMainWarning` and their models are deliberately NOT
// here. Nothing outside this slice mounts either — `RoomFilesSection` composes
// both from sibling paths, which are internal imports and need no barrel — and
// a barrel export with no consumer is a public surface nobody asked for and
// nothing keeps honest. The save-refusal copy and the conflict parser are the
// same: they exist for `room-files-source`, one directory away.
export { RoomFilesSection } from './ui/RoomFilesSection';
export type { RoomFilesSectionProps } from './ui/RoomFilesSection';
export { FilePreviewDialog } from './ui/FilePreviewDialog';
export type { FilePreviewDialogProps } from './ui/FilePreviewDialog';
export { createSessionCwdSource } from './model/session-cwd-source';
export type { SessionCwdSourceDeps } from './model/session-cwd-source';
export { createRoomFilesSource } from './model/room-files-source';
export { ROOM_FILES_REFRESH_INTERVAL_MS } from './model/room-entry-watch';
export type { RoomFilesSourceDeps } from './model/room-files-source';
export { explorerDirQueryKey, explorerDirQueryOptions } from './model/source';
export type {
  ExplorerCommit,
  ExplorerEntry,
  ExplorerFile,
  ExplorerFileBody,
  ExplorerListing,
  ExplorerSaveInput,
  ExplorerSaveOutcome,
  FileExplorerSource,
} from './model/source';
export {
  HIDDEN_ENTRY_NAMES,
  PINNED_ENTRY_NAMES,
  isHiddenEntryName,
  isPinnedEntryName,
  pinnedFirst,
  withoutHidden,
} from './lib/listing-shape';
export { NO_PROVENANCE, provenanceLine } from './lib/provenance';
export type { ProvenanceLine } from './lib/provenance';
