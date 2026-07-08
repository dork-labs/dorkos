/**
 * File-explorer feature — the Files right-panel tab (spec right-panel-workbench,
 * Chunk B). A lazy, worktree-aware tree of the session working directory with
 * full CRUD (create / rename / delete / drag-to-move), optimistic UI with
 * rollback, and keyboard navigation. Clicking a file opens it in the canvas via
 * the shared `open_file` command seam (`executeUiCommand`), the same seam the
 * agent's `open_file` tool drives.
 *
 * The right-panel contribution lazy-loads this module, so it lands in its own
 * async chunk.
 *
 * @module features/file-explorer
 */
export { FileExplorer } from './ui/FileExplorer';
