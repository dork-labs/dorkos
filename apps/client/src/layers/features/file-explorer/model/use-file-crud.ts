import { useCallback, useState, type Dispatch } from 'react';
import type { FileEntry } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { toastCrudError, getErrorCode } from '../lib/crud-errors';
import { baseName, joinPath, parentOf, type TreeAction } from './tree-reducer';

/**
 * Optimistic file-service mutations for the explorer (spec
 * right-panel-workbench, Chunk B). Every op patches the in-memory tree first,
 * calls the Chunk-A transport method, and rolls the patch back on a thrown
 * coded error (surfaced as a toast keyed by `err.code`). Deleting a non-empty
 * directory is a two-step confirm: the first non-recursive delete throws
 * `DIR_NOT_EMPTY`, which parks the entry in `pendingRecursiveDelete` for the
 * caller to confirm before the recursive retry.
 *
 * @module features/file-explorer/model/use-file-crud
 */

/** Dependencies the CRUD ops share with the tree-state owner. */
export interface FileCrudDeps {
  /** Session working directory every path resolves within. */
  cwd: string;
  /** Tree-reducer dispatch, for optimistic patches and rollbacks. */
  dispatch: Dispatch<TreeAction>;
  /** Read a directory's current children (from the live state ref). */
  getChildren: (path: string) => FileEntry[];
  /** Whether a directory's children have been fetched. */
  isLoaded: (path: string) => boolean;
  /** Refetch one directory level to reconcile after a successful write. */
  reloadDir: (path: string) => Promise<void>;
}

/** The CRUD surface the explorer UI drives. */
export interface FileCrudApi {
  createEntry: (parent: string, name: string, type: 'file' | 'dir') => Promise<boolean>;
  renameEntry: (entry: FileEntry, newName: string) => Promise<boolean>;
  removeEntry: (entry: FileEntry) => Promise<void>;
  moveEntry: (fromPath: string, toDir: string) => Promise<void>;
  /** A non-empty directory awaiting recursive-delete confirmation, or null. */
  pendingRecursiveDelete: FileEntry | null;
  confirmRecursiveDelete: () => Promise<void>;
  cancelRecursiveDelete: () => void;
}

/** Build an optimistic placeholder entry for a not-yet-persisted create/move. */
function draftEntry(path: string, name: string, type: 'file' | 'dir'): FileEntry {
  return { name, path, type, size: 0, mtime: Date.now(), isSymlink: false };
}

/** Optimistic file-service mutations bound to a tree-state owner. */
export function useFileCrud(deps: FileCrudDeps): FileCrudApi {
  const transport = useTransport();
  const { cwd, dispatch, getChildren, isLoaded, reloadDir } = deps;
  const [pendingRecursiveDelete, setPendingRecursiveDelete] = useState<FileEntry | null>(null);

  const createEntry = useCallback(
    async (parent: string, name: string, type: 'file' | 'dir'): Promise<boolean> => {
      const path = joinPath(parent, name);
      // Only add optimistically when the name is genuinely new; if it already
      // exists locally the create will conflict, and rolling back a removal
      // would wrongly delete the pre-existing entry (they share this path).
      const isNew = !getChildren(parent).some((e) => e.path === path);
      if (isNew) dispatch({ kind: 'addEntry', parent, entry: draftEntry(path, name, type) });
      try {
        await transport.createEntry(cwd, path, type);
        await reloadDir(parent);
        return true;
      } catch (err) {
        if (isNew) dispatch({ kind: 'removeEntry', parent, path });
        toastCrudError(err, `Couldn't create ${type === 'dir' ? 'folder' : 'file'}`);
        return false;
      }
    },
    [transport, cwd, dispatch, getChildren, reloadDir]
  );

  const renameEntry = useCallback(
    async (entry: FileEntry, newName: string): Promise<boolean> => {
      if (newName === entry.name || newName.length === 0) return true;
      const parent = parentOf(entry.path);
      const newPath = joinPath(parent, newName);
      // Only mutate optimistically when the target name is free. If a sibling
      // already occupies `newPath`, the rename will conflict — and an optimistic
      // replace + rollback (both keyed on the shared path) would corrupt that
      // pre-existing sibling. Let the transport reject and just toast.
      const collides = getChildren(parent).some((e) => e.path === newPath);
      const renamed: FileEntry = { ...entry, name: newName, path: newPath };
      if (!collides)
        dispatch({ kind: 'replaceEntry', parent, fromPath: entry.path, entry: renamed });
      try {
        await transport.renameEntry(cwd, entry.path, newPath);
        return true;
      } catch (err) {
        if (!collides) dispatch({ kind: 'replaceEntry', parent, fromPath: newPath, entry });
        toastCrudError(err, "Couldn't rename");
        return false;
      }
    },
    [transport, cwd, dispatch, getChildren]
  );

  const deleteRecursive = useCallback(
    async (entry: FileEntry): Promise<void> => {
      const parent = parentOf(entry.path);
      dispatch({ kind: 'removeEntry', parent, path: entry.path });
      try {
        await transport.deleteEntry(cwd, entry.path, { recursive: true });
      } catch (err) {
        dispatch({ kind: 'addEntry', parent, entry });
        toastCrudError(err, "Couldn't delete");
      }
    },
    [transport, cwd, dispatch]
  );

  const removeEntry = useCallback(
    async (entry: FileEntry): Promise<void> => {
      const parent = parentOf(entry.path);
      if (entry.type === 'file') {
        dispatch({ kind: 'removeEntry', parent, path: entry.path });
        try {
          await transport.deleteEntry(cwd, entry.path);
        } catch (err) {
          dispatch({ kind: 'addEntry', parent, entry });
          toastCrudError(err, "Couldn't delete");
        }
        return;
      }
      // Directory: try the safe non-recursive delete; a non-empty directory
      // throws DIR_NOT_EMPTY, which we surface as a confirm before wiping it.
      try {
        await transport.deleteEntry(cwd, entry.path);
        dispatch({ kind: 'removeEntry', parent, path: entry.path });
      } catch (err) {
        if (getErrorCode(err) === 'DIR_NOT_EMPTY') {
          setPendingRecursiveDelete(entry);
          return;
        }
        toastCrudError(err, "Couldn't delete");
      }
    },
    [transport, cwd, dispatch]
  );

  const confirmRecursiveDelete = useCallback(async (): Promise<void> => {
    const entry = pendingRecursiveDelete;
    setPendingRecursiveDelete(null);
    if (entry) await deleteRecursive(entry);
  }, [pendingRecursiveDelete, deleteRecursive]);

  const cancelRecursiveDelete = useCallback(() => setPendingRecursiveDelete(null), []);

  const moveEntry = useCallback(
    async (fromPath: string, toDir: string): Promise<void> => {
      const fromParent = parentOf(fromPath);
      const name = baseName(fromPath);
      const newPath = joinPath(toDir, name);
      // No-ops and self-nesting: dropping onto the current parent, onto itself,
      // or into its own subtree.
      if (toDir === fromParent || newPath === fromPath) return;
      if (toDir === fromPath || toDir.startsWith(`${fromPath}/`)) return;
      const entry = getChildren(fromParent).find((e) => e.path === fromPath);
      if (!entry) return;

      // Add to the destination optimistically only when the name is free there.
      // A collision would make the move conflict, and an optimistic add + rollback
      // removal (both keyed on the shared path) would destroy the destination's
      // pre-existing sibling. When it collides we still remove from the source
      // optimistically; on failure it snaps back.
      const destShown = isLoaded(toDir);
      const destCollides = destShown && getChildren(toDir).some((e) => e.path === newPath);
      const moved: FileEntry = { ...entry, name, path: newPath };
      dispatch({ kind: 'removeEntry', parent: fromParent, path: fromPath });
      if (destShown && !destCollides) dispatch({ kind: 'addEntry', parent: toDir, entry: moved });
      try {
        await transport.renameEntry(cwd, fromPath, newPath);
        if (destShown) await reloadDir(toDir);
      } catch (err) {
        dispatch({ kind: 'addEntry', parent: fromParent, entry });
        if (destShown && !destCollides) {
          dispatch({ kind: 'removeEntry', parent: toDir, path: newPath });
        }
        toastCrudError(err, "Couldn't move");
      }
    },
    [transport, cwd, dispatch, getChildren, isLoaded, reloadDir]
  );

  return {
    createEntry,
    renameEntry,
    removeEntry,
    moveEntry,
    pendingRecursiveDelete,
    confirmRecursiveDelete,
    cancelRecursiveDelete,
  };
}
