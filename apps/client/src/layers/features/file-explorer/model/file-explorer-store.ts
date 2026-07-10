import { create } from 'zustand';

/**
 * Imperative toolbar commands published by the mounted file tree.
 *
 * The Files toolbar (New File / New Folder / Refresh) renders in the
 * container-owned panel header — a separate React subtree from the tree it
 * drives. Rather than prop-drill across that boundary, the mounted
 * {@link FileExplorer} publishes stable handlers here and the toolbar invokes
 * them; `null` while no tree is mounted.
 */
export interface FileExplorerCommands {
  /** Begin an inline "new file" create at the tree root. */
  newFile: () => void;
  /** Begin an inline "new folder" create at the tree root. */
  newFolder: () => void;
  /** Refetch the tree's root level. */
  refresh: () => void;
}

interface FileExplorerStore {
  /**
   * Whether dotfiles and gitignored entries are shown. Shared state so the
   * header's toggle and the tree's loader read a single source of truth.
   * Deliberately module-scoped: the preference persists across sessions and
   * workspaces for the app's lifetime — a view preference, not session state.
   */
  showHidden: boolean;
  setShowHidden: (value: boolean) => void;
  /** Commands published by the mounted tree, or `null` when none is mounted. */
  commands: FileExplorerCommands | null;
  setCommands: (commands: FileExplorerCommands | null) => void;
}

/**
 * Cross-subtree state for the Files panel: the show-hidden toggle and the
 * toolbar command bridge that lets the header-mounted toolbar drive the
 * separately-mounted file tree.
 *
 * @module features/file-explorer/model/file-explorer-store
 */
export const useFileExplorerStore = create<FileExplorerStore>((set) => ({
  showHidden: false,
  setShowHidden: (showHidden) => set({ showHidden }),
  commands: null,
  setCommands: (commands) => set({ commands }),
}));
