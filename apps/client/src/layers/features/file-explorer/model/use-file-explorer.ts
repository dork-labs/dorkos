import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import type { FileEntry, FileTreeResponse } from '@dorkos/shared/types';
import { useAppStore, useTheme, useTransport } from '@/layers/shared/model';
import { executeUiCommand, QUERY_TIMING, type DispatcherContext } from '@/layers/shared/lib';
import { flattenTree, ROOT_KEY, visibleExpandedDirs } from './tree';
import type { DirState, FlatRow } from './types';
import { useFileCrud, type FileCrudApi } from './use-file-crud';
import { useFileExplorerStore } from './file-explorer-store';

/**
 * Orchestration hook for the file explorer (DOR-404). Expansion, selection, and
 * scroll live in the feature store (persisted per cwd); directory *data* lives
 * in TanStack Query — one query per visible directory, keyed
 * `['file-explorer', 'tree', cwd, dirPath, showHidden]`. So the tree survives an
 * unmount (tab switch, reopen) from cache, a refresh refetches the whole
 * expanded subtree with one `invalidateQueries`, and CRUD is optimistic against
 * the query cache. Opening a file rides the shared `open_file` dispatcher seam,
 * the same seam the agent's `open_file` tool drives.
 *
 * @module features/file-explorer/model/use-file-explorer
 */

/** The full explorer API a `FileExplorer` component consumes. */
export interface FileExplorerApi extends FileCrudApi {
  /** Ordered visible rows (root children, recursing into expanded directories). */
  rows: FlatRow[];
  /** True while the root level's first fetch is in flight. */
  rootLoading: boolean;
  /** True when the root level's listing failed to load. */
  rootError: boolean;
  /** Visible expanded directories whose listing failed (for inline retry rows). */
  errorPaths: Set<string>;
  /** Expand or collapse a directory (its query mounts/unmounts declaratively). */
  toggleExpand: (entry: FileEntry) => void;
  /** Ensure a directory is expanded, e.g. before an inline create. */
  ensureExpanded: (path: string) => void;
  /** Open a file into the canvas via the shared `open_file` command. */
  openFile: (entry: FileEntry) => void;
  /** Refetch the whole expanded subtree (root + every expanded dir). */
  reload: () => void;
  /** Refetch a single directory level (retry after a failed listing). */
  retryDir: (path: string) => void;
}

/**
 * Drive the file explorer for a session working directory.
 *
 * @param cwd - Session working directory the tree is rooted at, or null when
 *   no directory is selected (the tree stays empty).
 */
export function useFileExplorer(cwd: string | null): FileExplorerApi {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { setTheme } = useTheme();

  const showHidden = useFileExplorerStore((s) => s.showHidden);
  const expanded = useFileExplorerStore((s) => s.expanded);
  const loadExplorerForCwd = useFileExplorerStore((s) => s.loadExplorerForCwd);
  const pruneMissing = useFileExplorerStore((s) => s.pruneMissing);

  // Hydrate persisted UI state (expansion, selection, scroll) whenever the
  // directory changes. Expanded dirs then mount their queries in the same
  // render — after a refresh this cascades fetches for exactly the dirs the
  // user had open (A3's prune keeps that bounded).
  useEffect(() => {
    loadExplorerForCwd(cwd);
  }, [cwd, loadExplorerForCwd]);

  // The directories to fetch: the root plus every *visible* expanded dir (one
  // whose full ancestor chain is expanded). Derived from expansion alone, not
  // per-row — virtualization must never affect what gets fetched.
  const dirPaths = useMemo(() => [ROOT_KEY, ...visibleExpandedDirs(expanded)], [expanded]);

  const results = useQueries({
    queries: cwd
      ? dirPaths.map((dirPath) => ({
          queryKey: ['file-explorer', 'tree', cwd, dirPath, showHidden] as const,
          queryFn: () =>
            transport.readFileTree(cwd, {
              path: dirPath === ROOT_KEY ? undefined : dirPath,
              showHidden,
            }),
          staleTime: QUERY_TIMING.FILE_TREE_STALE_TIME_MS,
          gcTime: QUERY_TIMING.FILE_TREE_GC_TIME_MS,
          // Hold the previous rows while a show-hidden toggle refetches, so the
          // tree never blanks to a root spinner (DOR-404 review nit 3). Toggling
          // show-hidden repartitions this dir's key, and `useQueries` spins up a
          // *fresh* observer for the new key — so `keepPreviousData` alone finds
          // no previous data. Instead read the sibling (opposite show-hidden)
          // listing straight from the cache as the placeholder. A first-ever
          // expand has neither key cached, so its loading skeleton still shows.
          placeholderData: (prev: FileTreeResponse | undefined) =>
            prev ??
            queryClient.getQueryData<FileTreeResponse>([
              'file-explorer',
              'tree',
              cwd,
              dirPath,
              !showHidden,
            ]),
        }))
      : [],
  });

  const dirData = useMemo(() => {
    const map: Record<string, DirState> = {};
    dirPaths.forEach((dirPath, i) => {
      const r = results[i];
      map[dirPath] = {
        entries: r?.data?.entries ?? [],
        loading: r?.isLoading ?? false,
        error: r?.isError ?? false,
      };
    });
    return map;
  }, [dirPaths, results]);

  // In-flight optimistic mutations, shared with `useFileCrud`. The prune effect
  // stands down while any op is running so a transient optimistic cache edit (a
  // removed/renamed row) is never read as the entry vanishing and pruned from the
  // store — a store prune a transport rollback could not undo (review nit 1).
  const inFlightMutations = useRef(0);

  // Prune persisted paths that a freshly-loaded listing shows are gone (A3).
  // Gate by the entries reference so a stable listing never re-triggers a store
  // write, and a redundant render never spams a no-op prune.
  const prunedRef = useRef<Record<string, FileEntry[]>>({});
  useEffect(() => {
    // Suspend pruning mid-mutation (nit 1). On settle the op invalidates, and the
    // refetch re-runs this effect against real (post-rollback or committed) data.
    if (inFlightMutations.current > 0) return;
    dirPaths.forEach((dirPath, i) => {
      const entries = results[i]?.data?.entries;
      if (!entries || results[i]?.isError) return;
      if (prunedRef.current[dirPath] === entries) return;
      prunedRef.current[dirPath] = entries;
      pruneMissing(
        dirPath,
        entries.map((e) => e.name)
      );
    });
  }, [dirPaths, results, pruneMissing]);

  const rows = useMemo(() => flattenTree(expanded, dirData), [expanded, dirData]);

  const rootLoading = Boolean(cwd) && Boolean(dirData[ROOT_KEY]?.loading);
  const rootError = Boolean(cwd) && Boolean(dirData[ROOT_KEY]?.error);
  const errorPaths = useMemo(() => {
    const set = new Set<string>();
    for (const dirPath of dirPaths) {
      if (dirPath !== ROOT_KEY && dirData[dirPath]?.error) set.add(dirPath);
    }
    return set;
  }, [dirPaths, dirData]);

  const toggleExpand = useCallback((entry: FileEntry): void => {
    if (entry.type !== 'dir') return;
    // Read live store state so the toggle never closes over a stale snapshot.
    const store = useFileExplorerStore.getState();
    store.setDirExpanded(entry.path, !store.expanded[entry.path]);
  }, []);

  const ensureExpanded = useCallback((path: string): void => {
    if (path === ROOT_KEY) return;
    const store = useFileExplorerStore.getState();
    if (!store.expanded[path]) store.setDirExpanded(path, true);
  }, []);

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

  // Refresh (D4): invalidate the whole cwd tree prefix — root and every
  // expanded dir refetch, not just the root.
  const reload = useCallback((): void => {
    if (!cwd) return;
    void queryClient.invalidateQueries({ queryKey: ['file-explorer', 'tree', cwd] });
  }, [queryClient, cwd]);

  const retryDir = useCallback(
    (path: string): void => {
      if (!cwd) return;
      void queryClient.invalidateQueries({
        queryKey: ['file-explorer', 'tree', cwd, path, showHidden],
        exact: true,
      });
    },
    [queryClient, cwd, showHidden]
  );

  const crud = useFileCrud({
    cwd: cwd ?? '',
    showHidden,
    queryClient,
    inFlightRef: inFlightMutations,
  });

  return {
    rows,
    rootLoading,
    rootError,
    errorPaths,
    toggleExpand,
    ensureExpanded,
    openFile,
    reload,
    retryDir,
    ...crud,
  };
}
