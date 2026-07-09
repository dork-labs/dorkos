import type { FileEntry } from '@dorkos/shared/types';
import type { FlatRow, TreeState } from './types';

/**
 * Pure tree-state reducer and derivations for the file explorer (spec
 * right-panel-workbench, Chunk B). Kept side-effect-free and exported so the
 * lazy-expand, optimistic-CRUD, and flatten logic is unit-testable without
 * React.
 *
 * @module features/file-explorer/model/tree-reducer
 */

/** The empty-string key under which the cwd root's children are stored. */
export const ROOT_KEY = '';

/** Initial (empty) tree state. */
export function initialTreeState(): TreeState {
  return { childrenByPath: {}, loaded: {}, loading: {}, expanded: {} };
}

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
 * Tree mutations. Each is immutable so React sees a new state reference. The
 * optimistic-CRUD actions (`addEntry`, `removeEntry`, `replaceEntry`) have exact
 * inverses, which the orchestration hook dispatches to roll back a failed write.
 */
export type TreeAction =
  | { kind: 'setChildren'; path: string; entries: FileEntry[] }
  | { kind: 'setLoading'; path: string; loading: boolean }
  | { kind: 'expand'; path: string }
  | { kind: 'collapse'; path: string }
  | { kind: 'addEntry'; parent: string; entry: FileEntry }
  | { kind: 'removeEntry'; parent: string; path: string }
  | { kind: 'replaceEntry'; parent: string; fromPath: string; entry: FileEntry }
  | { kind: 'reset' };

/** Pure reducer over {@link TreeState}. */
export function treeReducer(state: TreeState, action: TreeAction): TreeState {
  switch (action.kind) {
    case 'setChildren':
      return {
        ...state,
        childrenByPath: { ...state.childrenByPath, [action.path]: sortEntries(action.entries) },
        loaded: { ...state.loaded, [action.path]: true },
        loading: { ...state.loading, [action.path]: false },
      };
    case 'setLoading':
      return { ...state, loading: { ...state.loading, [action.path]: action.loading } };
    case 'expand':
      return { ...state, expanded: { ...state.expanded, [action.path]: true } };
    case 'collapse':
      return { ...state, expanded: { ...state.expanded, [action.path]: false } };
    case 'addEntry': {
      const current = state.childrenByPath[action.parent] ?? [];
      return {
        ...state,
        childrenByPath: {
          ...state.childrenByPath,
          [action.parent]: sortEntries([...current, action.entry]),
        },
      };
    }
    case 'removeEntry': {
      const current = state.childrenByPath[action.parent] ?? [];
      return {
        ...state,
        childrenByPath: {
          ...state.childrenByPath,
          [action.parent]: current.filter((e) => e.path !== action.path),
        },
      };
    }
    case 'replaceEntry': {
      const current = state.childrenByPath[action.parent] ?? [];
      return {
        ...state,
        childrenByPath: {
          ...state.childrenByPath,
          [action.parent]: sortEntries(
            current.map((e) => (e.path === action.fromPath ? action.entry : e))
          ),
        },
      };
    }
    case 'reset':
      return initialTreeState();
  }
}

/**
 * Flatten the lazy tree into the ordered list of visible rows: the root's
 * children first, recursing into each expanded directory. Directories whose
 * children have not been fetched contribute only their own row.
 */
export function flattenTree(state: TreeState): FlatRow[] {
  const rows: FlatRow[] = [];
  // Guard against a pathological children map (e.g. a symlink cycle that names a
  // descendant with an ancestor's path) recursing without bound.
  const seen = new Set<string>();
  const walk = (parent: string, depth: number): void => {
    if (seen.has(parent)) return;
    seen.add(parent);
    for (const entry of state.childrenByPath[parent] ?? []) {
      const expanded = entry.type === 'dir' && Boolean(state.expanded[entry.path]);
      rows.push({ entry, depth, expanded, loading: Boolean(state.loading[entry.path]) });
      if (expanded) walk(entry.path, depth + 1);
    }
  };
  walk(ROOT_KEY, 0);
  return rows;
}
