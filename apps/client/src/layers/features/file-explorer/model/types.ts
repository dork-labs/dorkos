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
 * Lazy tree state. Directory children are keyed by their path relative to the
 * session cwd; the root uses the empty-string key `''`. `expanded`, `loaded`,
 * and `loading` are keyed the same way so a directory's row and its children
 * cache stay addressable by one path.
 */
export interface TreeState {
  /** Directory path (relative to cwd, `''` = root) → its immediate children. */
  childrenByPath: Record<string, FileEntry[]>;
  /** Directory path → whether its children have been fetched at least once. */
  loaded: Record<string, boolean>;
  /** Directory path → whether a children fetch is in flight. */
  loading: Record<string, boolean>;
  /** Directory path → whether it is currently expanded. */
  expanded: Record<string, boolean>;
}
