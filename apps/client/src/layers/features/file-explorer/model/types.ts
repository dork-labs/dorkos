import type { FileEntry } from '@dorkos/shared/types';

/**
 * File-explorer model types (spec right-panel-workbench, Chunk B).
 *
 * @module features/file-explorer/model/types
 */

/**
 * A single visible row in the flattened tree: the entry plus its render depth
 * and expand/loading flags. Produced by {@link flattenTree} from the lazy
 * per-directory children cache.
 */
export interface FlatRow {
  /** The file or directory this row renders. */
  entry: FileEntry;
  /** Nesting depth from the root (root children are depth 0). */
  depth: number;
  /** True when this directory is expanded (irrelevant for files). */
  expanded: boolean;
  /** True while this directory's children are being fetched. */
  loading: boolean;
}

/**
 * Per-directory query state the flattener and UI read: the directory's fetched
 * children plus its load/error status. Built by `useFileExplorer` from the
 * per-directory TanStack Query results, keyed by directory path (`''` = root).
 */
export interface DirState {
  /** The directory's immediate children (empty until the first fetch resolves). */
  entries: FileEntry[];
  /** True while this directory's first fetch is in flight. */
  loading: boolean;
  /** True when this directory's listing failed to load. */
  error: boolean;
}

/**
 * Persisted per-cwd file-explorer UI state (DOR-404, D1). One of these lives
 * under each cwd key in the `dorkos-file-explorer-state` localStorage blob;
 * `accessedAt` is the LRU recency stamp that bounds the map.
 */
export interface FileExplorerEntry {
  /** Expanded directories (cwd-relative path, `''`-root-relative → `true`). */
  expanded: Record<string, boolean>;
  /** The selected row's cwd-relative path, or `null` when nothing is selected. */
  selectedPath: string | null;
  /** Saved scroll offset (px) of the tree body. */
  scrollTop: number;
  /** Epoch ms of last access — the LRU recency stamp. */
  accessedAt: number;
}
