import { create } from 'zustand';
import { baseName, parentOf } from './tree-reducer';
import {
  emptyExplorerEntry,
  readExplorerEntry,
  readShowHidden,
  writeExplorerEntry,
  writeShowHidden,
} from './file-explorer-persistence';

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
   * Whether dotfiles and gitignored entries are shown. Persisted globally
   * (DOR-404 D5) under `dorkos-file-explorer-show-hidden` so the preference
   * survives a page refresh, not just a tab switch. The header's toggle and the
   * tree's query keys read this single source of truth.
   */
  showHidden: boolean;
  setShowHidden: (value: boolean) => void;
  /** Commands published by the mounted tree, or `null` when none is mounted. */
  commands: FileExplorerCommands | null;
  setCommands: (commands: FileExplorerCommands | null) => void;

  /** The cwd whose entry is live in the store, or `null` when none is loaded. */
  scopeKey: string | null;
  /** Expanded directories (cwd-relative path → `true`) for the active cwd. */
  expanded: Record<string, boolean>;
  /** The selected row's cwd-relative path, or `null` when nothing is selected. */
  selectedPath: string | null;
  /** Persisted scroll offset (px) of the tree body for the active cwd. */
  scrollTop: number;

  /**
   * Hydrate the store from a cwd's persisted entry (or defaults for an unknown
   * cwd), stamping it most-recently-used. Called whenever the explorer's cwd
   * changes; mirrors `loadCanvasForSession`.
   */
  loadExplorerForCwd: (cwd: string | null) => void;
  /** Expand or collapse a directory, writing through to localStorage. */
  setDirExpanded: (path: string, isExpanded: boolean) => void;
  /** Set (or clear) the selected row, writing through to localStorage. */
  setSelectedPath: (path: string | null) => void;
  /**
   * Set the saved scroll offset, writing through to localStorage. The only
   * high-frequency writer — callers must debounce; the store stays dumb.
   */
  setScrollTop: (scrollTop: number) => void;
  /**
   * Drop persisted `expanded`/`selectedPath` entries that point at children of
   * `parentPath` (or their descendants) which a freshly-loaded listing shows no
   * longer exist (DOR-404 A3). A no-op when nothing is stale.
   */
  pruneMissing: (parentPath: string, existingChildNames: string[]) => void;
  /**
   * Rewrite `expanded`/`selectedPath` paths under `fromPath` to `toPath` after a
   * rename or move, so an open/selected subtree follows the entry to its new
   * location. A no-op when nothing references `fromPath`.
   */
  remapExpandedPaths: (fromPath: string, toPath: string) => void;
  /**
   * Drop `expanded`/`selectedPath` paths at or under `path` after a delete, so
   * stale state never outlives the removed entry. A no-op when nothing matches.
   */
  dropExpandedPaths: (path: string) => void;
}

/** State fields projected into a persisted per-cwd entry. */
type PersistableState = Pick<
  FileExplorerStore,
  'scopeKey' | 'expanded' | 'selectedPath' | 'scrollTop'
>;

/**
 * Feature-owned store for the Files panel (DOR-404). Beyond the cross-subtree
 * command bridge and the show-hidden toggle, it holds the per-cwd navigation
 * state — expanded directories, the selected row, and the scroll offset — and
 * write-through-persists it to localStorage so the tree behaves like a place:
 * returning to it (tab switch, reopen, refresh) restores exactly where you
 * were. Directory *data* lives in TanStack Query, not here (ADR — see
 * `use-file-explorer.ts`).
 *
 * @module features/file-explorer/model/file-explorer-store
 */
export const useFileExplorerStore = create<FileExplorerStore>((set) => {
  /** Write the active cwd's live navigation state through to localStorage. */
  const persist = (state: PersistableState): void => {
    if (state.scopeKey === null) return;
    writeExplorerEntry(state.scopeKey, {
      expanded: state.expanded,
      selectedPath: state.selectedPath,
      scrollTop: state.scrollTop,
      accessedAt: Date.now(),
    });
  };

  return {
    showHidden: readShowHidden(),
    setShowHidden: (value) => {
      writeShowHidden(value);
      set({ showHidden: value });
    },
    commands: null,
    setCommands: (commands) => set({ commands }),

    scopeKey: null,
    expanded: {},
    selectedPath: null,
    scrollTop: 0,

    loadExplorerForCwd: (cwd) => {
      if (cwd === null) {
        set({ scopeKey: null, expanded: {}, selectedPath: null, scrollTop: 0 });
        return;
      }
      const entry = readExplorerEntry(cwd) ?? emptyExplorerEntry();
      const next = {
        scopeKey: cwd,
        expanded: entry.expanded,
        selectedPath: entry.selectedPath,
        scrollTop: entry.scrollTop,
      };
      set(next);
      // Stamp accessedAt: loading a cwd makes it most-recently-used for LRU.
      persist(next);
    },

    setDirExpanded: (path, isExpanded) =>
      set((s) => {
        const expanded = { ...s.expanded, [path]: isExpanded };
        persist({ ...s, expanded });
        return { expanded };
      }),

    setSelectedPath: (path) =>
      set((s) => {
        persist({ ...s, selectedPath: path });
        return { selectedPath: path };
      }),

    setScrollTop: (scrollTop) =>
      set((s) => {
        persist({ ...s, scrollTop });
        return { scrollTop };
      }),

    pruneMissing: (parentPath, existingChildNames) =>
      set((s) => {
        const existing = new Set(existingChildNames);
        // Direct children of parentPath the listing no longer contains.
        const staleRoots = Object.keys(s.expanded).filter(
          (p) => parentOf(p) === parentPath && !existing.has(baseName(p))
        );
        const isDead = (p: string): boolean =>
          staleRoots.some((root) => p === root || p.startsWith(`${root}/`));

        let changed = false;
        const expanded: Record<string, boolean> = {};
        for (const [p, v] of Object.entries(s.expanded)) {
          if (isDead(p)) changed = true;
          else expanded[p] = v;
        }

        // A selected path can be a direct stale child even when never expanded.
        const selectedStaleDirect =
          s.selectedPath !== null &&
          parentOf(s.selectedPath) === parentPath &&
          !existing.has(baseName(s.selectedPath));
        const selectedDead =
          s.selectedPath !== null && (selectedStaleDirect || isDead(s.selectedPath));

        if (!changed && !selectedDead) return s;
        const selectedPath = selectedDead ? null : s.selectedPath;
        persist({ ...s, expanded, selectedPath });
        return { expanded, selectedPath };
      }),

    remapExpandedPaths: (fromPath, toPath) =>
      set((s) => {
        const rewrite = (p: string): string | null => {
          if (p === fromPath) return toPath;
          if (p.startsWith(`${fromPath}/`)) return `${toPath}${p.slice(fromPath.length)}`;
          return null;
        };
        let changed = false;
        const expanded: Record<string, boolean> = {};
        for (const [p, v] of Object.entries(s.expanded)) {
          const moved = rewrite(p);
          if (moved !== null) {
            changed = true;
            expanded[moved] = v;
          } else {
            expanded[p] = v;
          }
        }
        const selectedMoved = s.selectedPath !== null ? rewrite(s.selectedPath) : null;
        if (!changed && selectedMoved === null) return s;
        const selectedPath = selectedMoved ?? s.selectedPath;
        persist({ ...s, expanded, selectedPath });
        return { expanded, selectedPath };
      }),

    dropExpandedPaths: (path) =>
      set((s) => {
        const isDead = (p: string): boolean => p === path || p.startsWith(`${path}/`);
        let changed = false;
        const expanded: Record<string, boolean> = {};
        for (const [p, v] of Object.entries(s.expanded)) {
          if (isDead(p)) changed = true;
          else expanded[p] = v;
        }
        const selectedDead = s.selectedPath !== null && isDead(s.selectedPath);
        if (!changed && !selectedDead) return s;
        const selectedPath = selectedDead ? null : s.selectedPath;
        persist({ ...s, expanded, selectedPath });
        return { expanded, selectedPath };
      }),
  };
});
