import { useCallback, useMemo, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import type { QueryClient } from '@tanstack/react-query';
import type { ExplorerEntry, ExplorerListing } from './source';
import { useTransport } from '@/layers/shared/model';
import { toastCrudError, getErrorCode, COPY_INTO_SELF_MESSAGE } from '../lib/crud-errors';
import { freeCopyName } from '../lib/copy-name';
import type { EntryRef } from './types';
import { baseName, isAtOrUnder, joinPath, parentOf, ROOT_KEY, sortEntries } from './tree';
import { useFileExplorerStore } from './file-explorer-store';

/**
 * Optimistic file-service mutations for the explorer (DOR-404). Every op patches
 * the TanStack Query cache for the affected parent directory first (snapshotting
 * for rollback), calls the transport, restores the snapshot on a thrown coded
 * error (surfaced as a toast keyed by `err.code`), and invalidates the touched
 * dir keys on settle to reconcile with the server. Rename/move/delete also fix
 * up the persisted `expanded`/`selectedPath` in the store so an open or selected
 * subtree follows (or clears with) the entry. Deleting a non-empty directory is
 * a two-step confirm: the first non-recursive delete throws `DIR_NOT_EMPTY`,
 * which parks the entry in `pendingRecursiveDelete` for the caller to confirm.
 *
 * @module features/file-explorer/model/use-file-crud
 */

/** Dependencies the CRUD ops need to reach the query cache. */
export interface FileCrudDeps {
  /** Session working directory every path resolves within. */
  cwd: string;
  /** Whether hidden entries are shown — part of each directory's query key. */
  showHidden: boolean;
  /** The active query client, for optimistic cache reads/writes and invalidation. */
  queryClient: QueryClient;
  /**
   * Shared in-flight-mutation counter the explorer's prune effect reads to
   * suspend pruning while any optimistic op is mid-flight. Raised for the
   * duration of every mutation so a transient optimistic cache edit (a removed or
   * renamed row) is never misread as the entry vanishing and pruned from the
   * store — a store prune a transport rollback could not undo (DOR-404 review
   * nit 1).
   */
  inFlightRef: RefObject<number>;
}

/** The CRUD surface the explorer UI drives. */
export interface FileCrudApi {
  createEntry: (parent: string, name: string, type: 'file' | 'dir') => Promise<boolean>;
  renameEntry: (entry: ExplorerEntry, newName: string) => Promise<boolean>;
  removeEntry: (entry: ExplorerEntry) => Promise<void>;
  moveEntry: (fromPath: string, toDir: string) => Promise<void>;
  /**
   * Copy an entry into a directory, naming it so it never lands on something
   * that is already there. Pass the entry's own parent to duplicate in place.
   *
   * Takes an {@link EntryRef} rather than a path because the source is often
   * long gone from the screen by the time this runs — the clipboard outlives
   * the row that filled it.
   */
  copyEntry: (from: EntryRef, toDir: string) => Promise<void>;
  /** A non-empty directory awaiting recursive-delete confirmation, or null. */
  pendingRecursiveDelete: ExplorerEntry | null;
  confirmRecursiveDelete: () => Promise<void>;
  cancelRecursiveDelete: () => void;
}

/** Build an optimistic placeholder entry for a not-yet-persisted create/move. */
function draftEntry(path: string, name: string, type: 'file' | 'dir'): ExplorerEntry {
  return { name, path, type, size: 0, mtime: Date.now(), isSymlink: false };
}

/** Optimistic file-service mutations bound to the explorer's query cache. */
export function useFileCrud(deps: FileCrudDeps): FileCrudApi {
  const transport = useTransport();
  const { cwd, showHidden, queryClient, inFlightRef } = deps;
  const [pendingRecursiveDelete, setPendingRecursiveDelete] = useState<ExplorerEntry | null>(null);

  // Raise the in-flight guard for the whole duration of an optimistic op. While
  // it is raised the explorer's prune effect stands down, so the op's transient
  // cache edit can't be read as a real deletion and prune the store; on settle
  // the op invalidates, the refetch re-runs the prune against real data (nit 1).
  const guard = useCallback(
    async <T>(op: () => Promise<T>): Promise<T> => {
      inFlightRef.current += 1;
      try {
        return await op();
      } finally {
        inFlightRef.current -= 1;
      }
    },
    [inFlightRef]
  );

  // A stable helper bundle over the per-directory query cache. `treeKey` matches
  // the keys `useFileExplorer` mounts, so writes here land in the same cache the
  // tree renders from.
  const cache = useMemo(() => {
    const treeKey = (path: string) => ['file-explorer', 'tree', cwd, path, showHidden] as const;
    return {
      /** A directory's current cached children (empty when not cached). */
      getChildren: (path: string): ExplorerEntry[] =>
        queryClient.getQueryData<ExplorerListing>(treeKey(path))?.entries ?? [],
      /** Whether a directory's listing has been fetched into the cache. */
      isLoaded: (path: string): boolean => queryClient.getQueryData(treeKey(path)) !== undefined,
      /**
       * Every name a directory holds, hidden entries included — what a copy has
       * to steer around.
       *
       * Read straight from the transport rather than through the cache, on
       * purpose. The tree's own listing is filtered by the show-hidden toggle,
       * and a name you cannot see is still a name you cannot use: computing a
       * copy's name from the filtered listing lands `.env` on top of an
       * existing `.env` and the server answers 409. Reading it fresh also means
       * the answer is never a stale cache entry, which for "is this name free?"
       * is the only useful kind.
       */
      takenNames: async (path: string): Promise<string[]> => {
        const listing = await transport.readFileTree(cwd, {
          path: path === ROOT_KEY ? undefined : path,
          showHidden: true,
        });
        return listing.entries.map((e) => e.name);
      },
      /** Snapshot a directory's cached response for rollback. */
      snapshot: (path: string): ExplorerListing | undefined =>
        queryClient.getQueryData<ExplorerListing>(treeKey(path)),
      /** Rewrite a directory's cached children (re-sorted). */
      setChildren: (path: string, next: (entries: ExplorerEntry[]) => ExplorerEntry[]): void => {
        queryClient.setQueryData<ExplorerListing>(treeKey(path), (prev) => ({
          entries: sortEntries(next(prev?.entries ?? [])),
        }));
      },
      /** Restore a snapshotted directory response (rollback). */
      restore: (path: string, data: ExplorerListing | undefined): void => {
        queryClient.setQueryData(treeKey(path), data);
      },
      /** Invalidate one directory level so it refetches from the server. */
      invalidate: (path: string): void => {
        void queryClient.invalidateQueries({ queryKey: treeKey(path), exact: true });
      },
    };
  }, [queryClient, transport, cwd, showHidden]);

  const createEntry = useCallback(
    (parent: string, name: string, type: 'file' | 'dir'): Promise<boolean> =>
      guard(async () => {
        const path = joinPath(parent, name);
        // Only add optimistically when the name is genuinely new; if it already
        // exists locally the create will conflict, and rolling back a removal
        // would wrongly delete the pre-existing entry (they share this path).
        const isNew = !cache.getChildren(parent).some((e) => e.path === path);
        const prev = cache.snapshot(parent);
        if (isNew) cache.setChildren(parent, (es) => [...es, draftEntry(path, name, type)]);
        try {
          await transport.createEntry(cwd, path, type);
          return true;
        } catch (err) {
          if (isNew) cache.restore(parent, prev);
          toastCrudError(err, `Couldn't create ${type === 'dir' ? 'folder' : 'file'}`);
          return false;
        } finally {
          cache.invalidate(parent);
        }
      }),
    [transport, cwd, cache, guard]
  );

  const renameEntry = useCallback(
    (entry: ExplorerEntry, newName: string): Promise<boolean> =>
      guard(async () => {
        if (newName === entry.name || newName.length === 0) return true;
        const parent = parentOf(entry.path);
        const newPath = joinPath(parent, newName);
        // Only mutate optimistically when the target name is free. If a sibling
        // already occupies `newPath`, the rename will conflict — and an optimistic
        // replace + rollback (both keyed on the shared path) would corrupt that
        // pre-existing sibling. Let the transport reject and just toast.
        const collides = cache.getChildren(parent).some((e) => e.path === newPath);
        const prev = cache.snapshot(parent);
        const renamed: ExplorerEntry = { ...entry, name: newName, path: newPath };
        if (!collides)
          cache.setChildren(parent, (es) => es.map((e) => (e.path === entry.path ? renamed : e)));
        try {
          await transport.renameEntry(cwd, entry.path, newPath);
          // Keep persisted expansion/selection pointing at the moved subtree.
          useFileExplorerStore.getState().remapExpandedPaths(entry.path, newPath);
          return true;
        } catch (err) {
          if (!collides) cache.restore(parent, prev);
          toastCrudError(err, "Couldn't rename");
          return false;
        } finally {
          cache.invalidate(parent);
        }
      }),
    [transport, cwd, cache, guard]
  );

  const deleteRecursive = useCallback(
    (entry: ExplorerEntry): Promise<void> =>
      guard(async () => {
        const parent = parentOf(entry.path);
        const prev = cache.snapshot(parent);
        cache.setChildren(parent, (es) => es.filter((e) => e.path !== entry.path));
        try {
          await transport.deleteEntry(cwd, entry.path, { recursive: true });
          useFileExplorerStore.getState().dropExpandedPaths(entry.path);
        } catch (err) {
          cache.restore(parent, prev);
          toastCrudError(err, "Couldn't delete");
        } finally {
          cache.invalidate(parent);
        }
      }),
    [transport, cwd, cache, guard]
  );

  const removeEntry = useCallback(
    (entry: ExplorerEntry): Promise<void> =>
      guard(async () => {
        const parent = parentOf(entry.path);
        if (entry.type === 'file') {
          const prev = cache.snapshot(parent);
          cache.setChildren(parent, (es) => es.filter((e) => e.path !== entry.path));
          try {
            await transport.deleteEntry(cwd, entry.path);
            useFileExplorerStore.getState().dropExpandedPaths(entry.path);
          } catch (err) {
            cache.restore(parent, prev);
            toastCrudError(err, "Couldn't delete");
          } finally {
            cache.invalidate(parent);
          }
          return;
        }
        // Directory: try the safe non-recursive delete; a non-empty directory
        // throws DIR_NOT_EMPTY, which we surface as a confirm before wiping it.
        try {
          await transport.deleteEntry(cwd, entry.path);
          cache.setChildren(parent, (es) => es.filter((e) => e.path !== entry.path));
          useFileExplorerStore.getState().dropExpandedPaths(entry.path);
          cache.invalidate(parent);
        } catch (err) {
          if (getErrorCode(err) === 'DIR_NOT_EMPTY') {
            setPendingRecursiveDelete(entry);
            return;
          }
          toastCrudError(err, "Couldn't delete");
        }
      }),
    [transport, cwd, cache, guard]
  );

  const confirmRecursiveDelete = useCallback(async (): Promise<void> => {
    const entry = pendingRecursiveDelete;
    setPendingRecursiveDelete(null);
    if (entry) await deleteRecursive(entry);
  }, [pendingRecursiveDelete, deleteRecursive]);

  const cancelRecursiveDelete = useCallback(() => setPendingRecursiveDelete(null), []);

  const moveEntry = useCallback(
    (fromPath: string, toDir: string): Promise<void> =>
      guard(async () => {
        const fromParent = parentOf(fromPath);
        const name = baseName(fromPath);
        const newPath = joinPath(toDir, name);
        // No-ops and self-nesting: dropping onto the current parent, onto itself,
        // or into its own subtree.
        if (toDir === fromParent || newPath === fromPath) return;
        if (isAtOrUnder(toDir, fromPath)) return;
        const entry = cache.getChildren(fromParent).find((e) => e.path === fromPath);
        if (!entry) return;

        // Add to the destination optimistically only when the name is free there.
        // A collision would make the move conflict, and an optimistic add + rollback
        // removal (both keyed on the shared path) would destroy the destination's
        // pre-existing sibling. When it collides we still remove from the source
        // optimistically; on failure it snaps back.
        const destShown = cache.isLoaded(toDir);
        const destCollides = destShown && cache.getChildren(toDir).some((e) => e.path === newPath);
        const moved: ExplorerEntry = { ...entry, name, path: newPath };
        const prevFrom = cache.snapshot(fromParent);
        const prevTo = destShown ? cache.snapshot(toDir) : undefined;
        cache.setChildren(fromParent, (es) => es.filter((e) => e.path !== fromPath));
        if (destShown && !destCollides) cache.setChildren(toDir, (es) => [...es, moved]);
        try {
          await transport.renameEntry(cwd, fromPath, newPath);
          useFileExplorerStore.getState().remapExpandedPaths(fromPath, newPath);
        } catch (err) {
          cache.restore(fromParent, prevFrom);
          if (destShown && !destCollides) cache.restore(toDir, prevTo);
          toastCrudError(err, "Couldn't move");
        } finally {
          cache.invalidate(fromParent);
          if (destShown) cache.invalidate(toDir);
        }
      }),
    [transport, cwd, cache, guard]
  );

  const copyEntry = useCallback(
    (from: EntryRef, toDir: string): Promise<void> =>
      guard(async () => {
        // A folder cannot go inside itself. The server refuses it too (400
        // COPY_INTO_SELF, which reads the same), but the round trip buys nothing
        // — and this used to return in silence, which is how a paste right after
        // copying a folder looked like nothing happening at all.
        if (from.isDir && isAtOrUnder(toDir, from.path)) {
          toast.error(COPY_INTO_SELF_MESSAGE);
          return;
        }

        let taken: string[];
        try {
          taken = await cache.takenNames(toDir);
        } catch (err) {
          toastCrudError(err, "Couldn't copy");
          return;
        }
        const name = freeCopyName({
          name: baseName(from.path),
          isDir: from.isDir,
          taken,
        });
        const newPath = joinPath(toDir, name);

        // Show the copy where it will land — but only where the destination's
        // listing is already on screen, exactly as a move does. Writing a row
        // into a directory that was never fetched would invent a listing
        // containing nothing but that row.
        //
        // The name is free by construction, so unlike create/rename/move there
        // is no collision case: the optimistic row can never be standing on top
        // of an existing one, and rolling it back can never take one out.
        const destShown = cache.isLoaded(toDir);
        const prev = destShown ? cache.snapshot(toDir) : undefined;
        if (destShown) {
          const source = cache.getChildren(parentOf(from.path)).find((e) => e.path === from.path);
          const copied: ExplorerEntry = source
            ? { ...source, name, path: newPath }
            : draftEntry(newPath, name, from.isDir ? 'dir' : 'file');
          cache.setChildren(toDir, (es) => [...es, copied]);
        }
        try {
          await transport.copyEntry(cwd, from.path, newPath);
        } catch (err) {
          if (destShown) cache.restore(toDir, prev);
          toastCrudError(err, "Couldn't copy");
        } finally {
          cache.invalidate(toDir);
        }
      }),
    [transport, cwd, cache, guard]
  );

  return {
    createEntry,
    renameEntry,
    removeEntry,
    moveEntry,
    copyEntry,
    pendingRecursiveDelete,
    confirmRecursiveDelete,
    cancelRecursiveDelete,
  };
}
