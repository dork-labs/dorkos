import type { FileEntry } from '@dorkos/shared/types';
import type { DirState, FlatRow } from './types';

/**
 * Pure tree derivations and path helpers for the file explorer. Side-effect
 * free and framework-free so the flatten, enumeration, and path logic stays
 * unit-testable without React. Directory *data* lives in TanStack Query and
 * expansion in the feature store; these functions only shape them into rows.
 *
 * @module features/file-explorer/model/tree
 */

/** The empty-string key under which the cwd root's children are stored. */
export const ROOT_KEY = '';

/** Directory portion of a cwd-relative POSIX path (`src/a.ts` → `src`, `a.ts` → `''`). */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? ROOT_KEY : path.slice(0, slash);
}

/** Base name of a cwd-relative POSIX path (`src/a.ts` → `a.ts`). */
export function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Join a parent directory key and a child name into a cwd-relative path. */
export function joinPath(parent: string, name: string): string {
  return parent === ROOT_KEY ? name : `${parent}/${name}`;
}

/**
 * Ancestor directory paths of a cwd-relative path, nearest-root first, excluding
 * the path itself and the root (`src/a/b.ts` → `['src', 'src/a']`).
 */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/');
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join('/'));
  }
  return ancestors;
}

/**
 * The expanded directories that are actually *visible*: every path flagged
 * expanded whose full ancestor chain is also expanded. This matches exactly
 * what {@link flattenTree} recurses into, so directory queries mount only for
 * dirs the user can see — collapsing an ancestor hides (and stops fetching) its
 * whole subtree, and re-expanding it restores the nested expansion as it was.
 */
export function visibleExpandedDirs(expanded: Record<string, boolean>): string[] {
  return Object.keys(expanded).filter(
    (p) => expanded[p] && ancestorDirs(p).every((a) => expanded[a])
  );
}

/**
 * Stable ordering: directories before files, then case-insensitive name. The
 * server already returns this order; re-applied here so optimistic inserts land
 * in the right place.
 */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/**
 * Flatten the lazy tree into the ordered list of visible rows: the root's
 * children first, recursing into each expanded directory. A directory whose
 * children have not been fetched (or that is collapsed) contributes only its own
 * row; an expanded directory whose fetch is in flight carries `loading: true`
 * (its own spinner row), sourced from query state.
 *
 * Pure over `(expanded, dirData)`. `showHidden` is not a parameter: it is baked
 * into each directory's query key, so `dirData` already reflects it.
 *
 * @param expanded - Directory path → whether it is expanded.
 * @param dirData - Directory path → its fetched children and load status.
 */
export function flattenTree(
  expanded: Record<string, boolean>,
  dirData: Record<string, DirState | undefined>
): FlatRow[] {
  const rows: FlatRow[] = [];
  // Guard against a pathological children map (e.g. a symlink cycle that names a
  // descendant with an ancestor's path) recursing without bound.
  const seen = new Set<string>();
  const walk = (parent: string, depth: number): void => {
    if (seen.has(parent)) return;
    seen.add(parent);
    for (const entry of dirData[parent]?.entries ?? []) {
      const isExpanded = entry.type === 'dir' && Boolean(expanded[entry.path]);
      const child = dirData[entry.path];
      rows.push({
        entry,
        depth,
        expanded: isExpanded,
        loading: isExpanded && Boolean(child?.loading),
      });
      if (isExpanded) walk(entry.path, depth + 1);
    }
  };
  walk(ROOT_KEY, 0);
  return rows;
}
