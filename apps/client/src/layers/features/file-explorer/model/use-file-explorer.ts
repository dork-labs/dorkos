import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { FileEntry } from '@dorkos/shared/types';
import { useAppStore, useTheme, useTransport } from '@/layers/shared/model';
import { executeUiCommand, type DispatcherContext } from '@/layers/shared/lib';
import { flattenTree, initialTreeState, ROOT_KEY, treeReducer } from './tree-reducer';
import type { FlatRow } from './types';
import { useFileCrud, type FileCrudApi } from './use-file-crud';
import { useFileExplorerStore } from './file-explorer-store';

/**
 * Orchestration hook for the file explorer (spec right-panel-workbench, Chunk
 * B): owns the lazy tree state, loads the cwd root, expands directories on
 * demand, opens files into the canvas via the shared `open_file` dispatcher
 * seam, and composes the optimistic-CRUD surface. Reads live state through a ref
 * so async callbacks never close over stale reducer state.
 *
 * @module features/file-explorer/model/use-file-explorer
 */

/** The full explorer API a `FileExplorer` component consumes. */
export interface FileExplorerApi extends FileCrudApi {
  /** Ordered visible rows (root children, recursing into expanded directories). */
  rows: FlatRow[];
  /** True while the root level's first fetch is in flight. */
  rootLoading: boolean;
  /** Expand or collapse a directory (fetching its children lazily on expand). */
  toggleExpand: (entry: FileEntry) => void;
  /** Ensure a directory is expanded (and its children loaded), e.g. before an inline create. */
  ensureExpanded: (path: string) => void;
  /** Open a file into the canvas via the shared `open_file` command. */
  openFile: (entry: FileEntry) => void;
  /** Refetch the root level (e.g. after an external change). */
  reload: () => void;
}

/**
 * Drive the file explorer for a session working directory.
 *
 * @param cwd - Session working directory the tree is rooted at, or null when
 *   no directory is selected (the tree stays empty).
 */
export function useFileExplorer(cwd: string | null): FileExplorerApi {
  const transport = useTransport();
  const { setTheme } = useTheme();
  const [state, dispatch] = useReducer(treeReducer, undefined, initialTreeState);
  // Shared with the header-mounted toolbar so its toggle and this loader agree.
  const showHidden = useFileExplorerStore((s) => s.showHidden);

  // Live mirror of reducer state for async callbacks (expand/CRUD) that must
  // read the latest children without re-subscribing. Synced after commit; the
  // callbacks that read it only run from later user events, never mid-render.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const loadDir = useCallback(
    async (path: string): Promise<void> => {
      if (!cwd) return;
      dispatch({ kind: 'setLoading', path, loading: true });
      try {
        const { entries } = await transport.readFileTree(cwd, {
          path: path === ROOT_KEY ? undefined : path,
          showHidden,
        });
        dispatch({ kind: 'setChildren', path, entries });
      } catch {
        dispatch({ kind: 'setLoading', path, loading: false });
      }
    },
    [transport, cwd, showHidden]
  );

  // (Re)load the root whenever the directory or the hidden-file toggle changes.
  useEffect(() => {
    dispatch({ kind: 'reset' });
    if (cwd) void loadDir(ROOT_KEY);
  }, [cwd, loadDir]);

  // The root is "loading" until its first fetch resolves — derived from the
  // reducer so no setState fires from the load effect.
  const rootLoading = Boolean(state.loading[ROOT_KEY]) || !state.loaded[ROOT_KEY];

  const toggleExpand = useCallback(
    (entry: FileEntry): void => {
      if (entry.type !== 'dir') return;
      const current = stateRef.current;
      if (current.expanded[entry.path]) {
        dispatch({ kind: 'collapse', path: entry.path });
        return;
      }
      dispatch({ kind: 'expand', path: entry.path });
      if (!current.loaded[entry.path]) void loadDir(entry.path);
    },
    [loadDir]
  );

  const ensureExpanded = useCallback(
    (path: string): void => {
      if (path === ROOT_KEY) return;
      const current = stateRef.current;
      if (current.expanded[path]) return;
      dispatch({ kind: 'expand', path });
      if (!current.loaded[path]) void loadDir(path);
    },
    [loadDir]
  );

  const openFile = useCallback(
    (entry: FileEntry): void => {
      if (entry.type !== 'file') return;
      // Same seam the agent's `open_file` tool drives: resolve the viewer via
      // the shared registry and open/activate a canvas document. `sourcePath` is
      // already relative to cwd (the file-service contract). `supportsTerminal`
      // keeps the shared dispatch contract uniform (only `open_file` fires here).
      const ctx: DispatcherContext = {
        store: useAppStore.getState(),
        setTheme,
        supportsTerminal: transport.supportsTerminal,
      };
      // Origin 'user': the person clicked the file in the tree — an explicit
      // pick, so the canvas tab switch persists the per-agent preference (DOR-227).
      executeUiCommand(ctx, { action: 'open_file', sourcePath: entry.path }, 'user');
    },
    [setTheme, transport]
  );

  const getChildren = useCallback(
    (path: string): FileEntry[] => stateRef.current.childrenByPath[path] ?? [],
    []
  );
  const isLoaded = useCallback(
    (path: string): boolean => Boolean(stateRef.current.loaded[path]),
    []
  );

  const crud = useFileCrud({
    cwd: cwd ?? '',
    dispatch,
    getChildren,
    isLoaded,
    reloadDir: loadDir,
  });

  const reload = useCallback(() => void loadDir(ROOT_KEY), [loadDir]);

  const rows = useMemo(() => flattenTree(state), [state]);

  return {
    rows,
    rootLoading,
    toggleExpand,
    ensureExpanded,
    openFile,
    reload,
    ...crud,
  };
}
