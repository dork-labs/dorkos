import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useAppStore, useTheme, useTransport } from '@/layers/shared/model';
import { executeUiCommand, type DispatcherContext } from '@/layers/shared/lib';
import { pinnedFirst, withoutHidden } from '../lib/listing-shape';
import { flattenTree, ROOT_KEY, visibleExpandedDirs } from './tree';
import type { DirState, FlatRow } from './types';
import {
  explorerDirQueryKey,
  explorerDirQueryOptions,
  type ExplorerEntry,
  type FileExplorerSource,
} from './source';
import { useFileCrud, type FileCrudApi } from './use-file-crud';
import { useFileActions, type FileActionsApi } from './use-file-actions';
import { useFileExplorerStore } from './file-explorer-store';

/**
 * Orchestration hook for the file explorer (DOR-404, extended to sources by
 * DOR-1595). Expansion, selection, and scroll live in the feature store
 * (persisted per source); directory *data* lives in TanStack Query — one query
 * per visible directory, keyed by {@link explorerDirQueryKey}. So the tree
 * survives an unmount (tab switch, reopen) from cache, a refresh refetches the
 * whole expanded subtree with one `invalidateQueries`, and CRUD is optimistic
 * against the query cache. Opening a file rides the shared `open_file`
 * dispatcher seam, the same seam the agent's `open_file` tool drives.
 *
 * **What it browses is a {@link FileExplorerSource}, not a directory.** A
 * session's working directory is one source and a room's own files are another;
 * the tree, the keyboard, the persistence and the rows are the same either way.
 * A session source's `scopeKey` is its cwd verbatim, so every key here is
 * exactly the key it was before sources existed.
 *
 * **One explorer is mounted at a time**, which is what lets the feature store
 * hold the active source's expansion as plain fields rather than a map. The
 * right panel shows one tab, and the Files tab and the Room tab are two of
 * them; a second mount would load its own scope over the first's. The dev
 * playground honours this by showing one source at a time.
 *
 * @module features/file-explorer/model/use-file-explorer
 */

/**
 * The stand-in for "nothing to browse", so the CRUD hook below is called
 * unconditionally like every other hook.
 *
 * Not writable and holding no directory, which is exactly what it is: with no
 * source the pane renders its "pick a working directory" state and no mutation
 * can be reached from it.
 */
const EMPTY_SOURCE: FileExplorerSource = {
  scopeKey: '',
  cwd: null,
  writable: false,
  provenance: false,
  filtersHidden: true,
  preview: 'canvas',
  editable: false,
  list: () => Promise.resolve({ entries: [] }),
};

/** The full explorer API a `FileExplorer` component consumes. */
export interface FileExplorerApi extends FileCrudApi, FileActionsApi {
  /** Ordered visible rows (root children, recursing into expanded directories). */
  rows: FlatRow[];
  /** True while the root level's first fetch is in flight. */
  rootLoading: boolean;
  /** True when the root level's listing failed to load. */
  rootError: boolean;
  /** Visible expanded directories whose listing failed (for inline retry rows). */
  errorPaths: Set<string>;
  /** Expand or collapse a directory (its query mounts/unmounts declaratively). */
  toggleExpand: (entry: ExplorerEntry) => void;
  /** Ensure a directory is expanded, e.g. before an inline create. */
  ensureExpanded: (path: string) => void;
  /**
   * Open a file. For a canvas-preview source that means the shared `open_file`
   * command; for an in-pane source the pane shows it itself, so this is a no-op
   * and the component reads the selection instead.
   */
  openFile: (entry: ExplorerEntry) => void;
  /** Refetch the whole expanded subtree (root + every expanded dir). */
  reload: () => void;
  /** Refetch a single directory level (retry after a failed listing). */
  retryDir: (path: string) => void;
}

/**
 * Drive the file explorer over one source.
 *
 * @param source - Where the entries come from, or null when there is nothing to
 *   browse (no working directory selected; the tree stays empty).
 */
export function useFileExplorer(source: FileExplorerSource | null): FileExplorerApi {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { setTheme } = useTheme();

  const showHidden = useFileExplorerStore((s) => s.showHidden);
  const expanded = useFileExplorerStore((s) => s.expanded);
  const loadExplorerForCwd = useFileExplorerStore((s) => s.loadExplorerForCwd);
  const pruneMissing = useFileExplorerStore((s) => s.pruneMissing);

  const scopeKey = source?.scopeKey ?? null;
  const cwd = source?.cwd ?? null;

  // Hydrate persisted UI state (expansion, selection, scroll) whenever the
  // source changes. Expanded dirs then mount their queries in the same
  // render — after a refresh this cascades fetches for exactly the dirs the
  // user had open (A3's prune keeps that bounded).
  useEffect(() => {
    loadExplorerForCwd(scopeKey);
  }, [scopeKey, loadExplorerForCwd]);

  // The directories to fetch: the root plus every *visible* expanded dir (one
  // whose full ancestor chain is expanded). Derived from expansion alone, not
  // per-row — virtualization must never affect what gets fetched.
  const dirPaths = useMemo(() => [ROOT_KEY, ...visibleExpandedDirs(expanded)], [expanded]);

  const results = useQueries({
    queries: source
      ? dirPaths.map((dirPath) => explorerDirQueryOptions(source, dirPath, showHidden, queryClient))
      : [],
  });

  const filtersHidden = source?.filtersHidden ?? true;
  const dirData = useMemo(() => {
    const map: Record<string, DirState> = {};
    dirPaths.forEach((dirPath, i) => {
      const r = results[i];
      let entries: ExplorerEntry[] = r?.data?.entries ?? [];
      // A source that serves its tree as committed hands over the plumbing with
      // everything else, so the pane drops it here. A source that filters
      // server-side is left alone: it knows things a client cannot, like what
      // `git check-ignore` says, and filtering its answer again could only ever
      // remove more than the person asked to hide.
      if (!showHidden && !filtersHidden) entries = withoutHidden(entries);
      // Only at the root: a pin means "read this first about this place", and
      // a place has one root. A README three directories down is just a file.
      if (dirPath === ROOT_KEY) entries = pinnedFirst(entries);
      map[dirPath] = {
        entries,
        loading: r?.isLoading ?? false,
        error: r?.isError ?? false,
      };
    });
    return map;
  }, [dirPaths, results, showHidden, filtersHidden]);

  // In-flight optimistic mutations, shared with `useFileCrud`. The prune effect
  // stands down while any op is running so a transient optimistic cache edit (a
  // removed/renamed row) is never read as the entry vanishing and pruned from the
  // store — a store prune a transport rollback could not undo (review nit 1).
  const inFlightMutations = useRef(0);

  // Prune persisted paths that a freshly-loaded listing shows are gone (A3).
  // Gate by the entries reference so a stable listing never re-triggers a store
  // write, and a redundant render never spams a no-op prune.
  const prunedRef = useRef<Record<string, ExplorerEntry[]>>({});
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

  const rootLoading = Boolean(source) && Boolean(dirData[ROOT_KEY]?.loading);
  const rootError = Boolean(source) && Boolean(dirData[ROOT_KEY]?.error);
  const errorPaths = useMemo(() => {
    const set = new Set<string>();
    for (const dirPath of dirPaths) {
      if (dirPath !== ROOT_KEY && dirData[dirPath]?.error) set.add(dirPath);
    }
    return set;
  }, [dirPaths, dirData]);

  const toggleExpand = useCallback((entry: ExplorerEntry): void => {
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

  const canvasPreview = source?.preview === 'canvas';
  const openFile = useCallback(
    (entry: ExplorerEntry): void => {
      if (entry.type !== 'file') return;
      // A source that previews in the pane has nowhere to push a document: the
      // canvas opens a file beside a conversation, against that session's
      // working directory, and a room's files have neither. The pane renders
      // the selection itself instead.
      if (!canvasPreview) return;
      // Same seam the agent's `open_file` tool drives: resolve the viewer via
      // the shared registry and open/activate a canvas document. `sourcePath` is
      // already relative to cwd (the file-service contract). `supportsTerminal`
      // keeps the shared dispatch contract uniform (only `open_file` fires here).
      const ctx: DispatcherContext = {
        getStore: useAppStore.getState,
        setTheme,
        supportsTerminal: transport.supportsTerminal,
      };
      // Origin 'user': the person clicked the file in the tree — an explicit
      // pick, so the canvas tab switch persists the per-agent preference (DOR-227).
      executeUiCommand(ctx, { action: 'open_file', sourcePath: entry.path }, 'user');
    },
    [canvasPreview, setTheme, transport]
  );

  // Refresh (D4): invalidate the whole scope's tree prefix — root and every
  // expanded dir refetch, not just the root.
  const reload = useCallback((): void => {
    if (scopeKey === null) return;
    void queryClient.invalidateQueries({ queryKey: ['file-explorer', 'tree', scopeKey] });
  }, [queryClient, scopeKey]);

  const retryDir = useCallback(
    (path: string): void => {
      if (source === null) return;
      void queryClient.invalidateQueries({
        queryKey: explorerDirQueryKey(source, path, showHidden),
        exact: true,
      });
    },
    [queryClient, source, showHidden]
  );

  // A source that knows when its files may have changed says so; the pane turns
  // that into the same refresh the toolbar button does. `reload` is stable per
  // scope, so this subscribes once per source rather than once per render.
  useEffect(() => {
    if (!source?.events) return;
    return source.events(reload);
  }, [source, reload]);

  const crud = useFileCrud({
    // A null source has nothing to write to, and every op below is unreachable
    // without one — the pane renders its "pick a directory" state instead.
    source: source ?? EMPTY_SOURCE,
    showHidden,
    queryClient,
    inFlightRef: inFlightMutations,
  });

  const actions = useFileActions(cwd);

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
    ...actions,
  };
}
