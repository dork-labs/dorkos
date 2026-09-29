/**
 * Tree changes for a source with its own door — a room's files (spec
 * `agent-home-desk` §7.3).
 *
 * The session explorer's mutations live in `use-file-crud`, against the files
 * API. This is the same shape of work against {@link ExplorerChanges}: every
 * change is one commit that carries the version the person saw, so three
 * things differ and each is a decision a person makes rather than one this hook
 * makes for them:
 *
 * - **A lost race is a question.** A rename, a move, a delete or an upload over
 *   files somebody else changed since comes back `conflict`, and nothing was
 *   changed. The person sees who got there first and chooses: look at their
 *   version, or make the change anyway.
 * - **A name clash on upload is a question too.** The folder is read first, and
 *   any name it already holds is put to the person — replace it, or keep both
 *   under a free name — before a byte is sent.
 * - **Every delete is confirmed**, naming the file or the folder and how many
 *   files are in it, because a delete here is a commit everybody in the room
 *   sees.
 *
 * Optimistic like the session path: the tree shows the change at once and
 * snaps back on anything but success, and the shared in-flight counter keeps
 * the explorer's prune from reading a transient edit as the entry vanishing.
 *
 * @module features/file-explorer/model/use-source-changes
 */
import { useCallback, useMemo, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import type { QueryClient } from '@tanstack/react-query';
import { freeCopyName } from '../lib/copy-name';
import { nameTakenMessage, roomChangeRefusalMessage } from '../lib/crud-errors';
import { useFileExplorerStore } from './file-explorer-store';
import {
  explorerDirQueryKey,
  type ExplorerChangeOutcome,
  type ExplorerCommit,
  type ExplorerEntry,
  type ExplorerListing,
  type FileExplorerSource,
} from './source';
import { baseName, isAtOrUnder, joinPath, parentOf, sortEntries } from './tree';

/**
 * The most files a folder delete counts before it stops and says "more than".
 *
 * The count is for a sentence, not for the delete — the server removes
 * everything under the folder whatever this says — so past this many a
 * number is not worth another round trip per folder.
 */
export const DELETE_COUNT_LIMIT = 1000;

/** What {@link useSourceChanges} needs. */
export interface SourceChangesDeps {
  /** The source being changed. Only one with `changes` is ever acted on. */
  source: FileExplorerSource;
  /** Whether hidden entries are shown — part of each directory's query key. */
  showHidden: boolean;
  /** The active query client, for optimistic cache reads and writes. */
  queryClient: QueryClient;
  /** The explorer's in-flight counter; see `use-file-crud`'s own. */
  inFlightRef: RefObject<number>;
}

/** Which change a lost race was about, so "do it anyway" can say so. */
export type ChangeKind = 'rename' | 'move' | 'delete' | 'upload';

/** A lost race, waiting for the person to choose. */
export interface PendingConflict {
  /** What the person was doing. */
  kind: ChangeKind;
  /** The file somebody else changed first. */
  path: string;
  /** Who changed it, when the room could say. Member-written text. */
  lastCommit: ExplorerCommit | null;
  /** Make the change anyway, over their version. */
  retry: () => Promise<void>;
}

/** A delete waiting to be confirmed. */
export interface PendingDelete {
  /** What would be deleted. */
  entry: ExplorerEntry;
  /**
   * How many files are in it: `null` while counting (or when the count could
   * not be made), and a number otherwise — capped at {@link DELETE_COUNT_LIMIT}.
   */
  fileCount: number | null;
  /** Whether the count stopped at the limit. */
  moreThan: boolean;
}

/** An upload whose names the folder already holds, waiting for a choice. */
export interface PendingClash {
  /** The folder the files are going into; `''` for the top. */
  dir: string;
  /** The names that are taken there. */
  names: string[];
}

/** The change surface the explorer UI drives over a source with `changes`. */
export interface SourceChangesApi {
  /** Rename an entry in place. Resolves whether it landed. */
  renameEntry: (entry: ExplorerEntry, newName: string) => Promise<boolean>;
  /** Move an entry into another folder. */
  moveEntry: (fromPath: string, toDir: string) => Promise<void>;
  /** Ask to delete an entry — opens the confirmation. */
  requestDelete: (entry: ExplorerEntry) => void;
  /** The delete waiting to be confirmed, or `null`. */
  pendingDelete: PendingDelete | null;
  /** Delete what is waiting. */
  confirmDelete: () => Promise<void>;
  /** Keep it. */
  cancelDelete: () => void;
  /** Upload files into a folder. Asks first when a name is taken there. */
  upload: (dir: string, files: File[]) => Promise<void>;
  /** The upload waiting on a replace-or-keep-both choice, or `null`. */
  pendingClash: PendingClash | null;
  /** Answer the clash. */
  resolveClash: (choice: 'replace' | 'keep-both') => Promise<void>;
  /** Upload nothing. */
  cancelClash: () => void;
  /** The race waiting on an open-theirs-or-do-it-anyway choice, or `null`. */
  conflict: PendingConflict | null;
  /** Put the choice away without doing anything. */
  dismissConflict: () => void;
  /** Whether a change is on its way to the room. */
  busy: boolean;
}

/**
 * Drive the tree changes of a source that has its own door for them.
 *
 * @param deps - The source, the cache, and the explorer's in-flight counter.
 */
export function useSourceChanges(deps: SourceChangesDeps): SourceChangesApi {
  const { source, showHidden, queryClient, inFlightRef } = deps;
  const changes = source.changes;
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [pendingUpload, setPendingUpload] = useState<{
    dir: string;
    files: File[];
    names: string[];
    taken: string[];
    baseCommit: string | null;
  } | null>(null);
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const [busyCount, setBusyCount] = useState(0);

  const guard = useCallback(
    async <T>(op: () => Promise<T>): Promise<T> => {
      inFlightRef.current += 1;
      setBusyCount((n) => n + 1);
      try {
        return await op();
      } finally {
        inFlightRef.current -= 1;
        setBusyCount((n) => n - 1);
      }
    },
    [inFlightRef]
  );

  const cache = useMemo(() => {
    const key = (dir: string) => explorerDirQueryKey(source, dir, showHidden);
    return {
      listing: (dir: string) => queryClient.getQueryData<ExplorerListing>(key(dir)),
      isLoaded: (dir: string) => queryClient.getQueryData(key(dir)) !== undefined,
      entries: (dir: string) => queryClient.getQueryData<ExplorerListing>(key(dir))?.entries ?? [],
      // Keeps the listing's own fields — its commit above all, which is the
      // lock the next change in this directory carries.
      setEntries: (dir: string, next: (entries: ExplorerEntry[]) => ExplorerEntry[]) =>
        queryClient.setQueryData<ExplorerListing>(key(dir), (prev) => ({
          ...prev,
          entries: sortEntries(next(prev?.entries ?? [])),
        })),
      restore: (dir: string, data: ExplorerListing | undefined) =>
        queryClient.setQueryData(key(dir), data),
      /**
       * A fresh read of one directory, straight from the source — hidden
       * entries included, because a name you cannot see is still a name that
       * is taken.
       *
       * **Deliberately NOT through the tree's cache entry.** Every change ends
       * by invalidating the tree, and an invalidation cancels whatever fetch is
       * in flight for that entry — so a second drop made while the first upload
       * was still landing read a cancelled fetch and told the person their
       * upload had failed (found in the browser; jsdom never overlaps them).
       */
      fetch: (dir: string) => source.list(dir, { showHidden: true }),
      /** Every listing and every open file of this source, re-asked. */
      refreshAll: () => {
        void queryClient.invalidateQueries({
          queryKey: ['file-explorer', 'tree', source.scopeKey],
        });
        void queryClient.invalidateQueries({
          queryKey: ['file-explorer', 'preview', source.scopeKey],
        });
      },
    };
  }, [queryClient, source, showHidden]);

  /**
   * The version the person's view of a directory came from.
   *
   * The cached listing is what is on screen, so its commit is exactly "what
   * they saw". A directory that is not on screen is read first; its answer is
   * what they are about to see.
   */
  const baseFor = useCallback(
    async (dir: string): Promise<string | null> => {
      const cached = cache.listing(dir);
      if (cached?.commit !== undefined) return cached.commit;
      return (await cache.fetch(dir)).commit ?? null;
    },
    [cache]
  );

  /**
   * Tell the person how a change ended, when it did not land. Returns whether
   * it landed.
   */
  const settle = useCallback(
    (
      outcome: ExplorerChangeOutcome,
      kind: ChangeKind,
      retry: (baseCommit: string) => Promise<void>,
      takenName?: string
    ): boolean => {
      switch (outcome.status) {
        case 'changed':
          return true;
        case 'conflict':
          setConflict({
            kind,
            path: outcome.path,
            lastCommit: outcome.lastCommit,
            retry: () => retry(outcome.commit),
          });
          return false;
        case 'exists':
          toast.error(takenName === undefined ? outcome.reason : nameTakenMessage(takenName));
          return false;
        case 'refused':
          toast.error(outcome.reason);
          return false;
      }
    },
    []
  );

  /** One change the transport threw on — a refusal nobody wrote copy for. */
  const failed = useCallback((err: unknown, fallback: string) => {
    toast.error(roomChangeRefusalMessage(err) ?? fallback);
  }, []);

  /**
   * Move `from` to `to` — the one operation behind both a rename and a move,
   * which the room does not tell apart either.
   */
  const relocate = useCallback(
    (entry: ExplorerEntry, to: string, kind: 'rename' | 'move'): Promise<boolean> => {
      // `baseCommit` is `null` on the first try — the version on screen is
      // read — and the conflict's own commit when the person says "anyway".
      const attempt = (baseCommit: string | null): Promise<boolean> =>
        guard(async () => {
          if (changes === undefined) return false;
          const fromDir = parentOf(entry.path);
          const toDir = parentOf(to);
          const name = baseName(to);
          const destShown = cache.isLoaded(toDir);
          // Only drawn where the name is free: an optimistic row on top of an
          // existing one would take that one with it on rollback.
          const collides = destShown && cache.entries(toDir).some((e) => e.path === to);
          const prevFrom = cache.listing(fromDir);
          const prevTo = toDir === fromDir ? undefined : cache.listing(toDir);
          const moved: ExplorerEntry = { ...entry, name, path: to };
          if (!collides) {
            if (toDir === fromDir) {
              cache.setEntries(fromDir, (es) => es.map((e) => (e.path === entry.path ? moved : e)));
            } else {
              cache.setEntries(fromDir, (es) => es.filter((e) => e.path !== entry.path));
              if (destShown) cache.setEntries(toDir, (es) => [...es, moved]);
            }
          }
          const rollback = () => {
            cache.restore(fromDir, prevFrom);
            if (toDir !== fromDir && destShown) cache.restore(toDir, prevTo);
          };
          try {
            const base = baseCommit ?? (await baseFor(fromDir));
            if (base === null) {
              rollback();
              toast.error('There’s nothing in this room’s files to change yet.');
              return false;
            }
            const outcome = await changes.move({ from: entry.path, to, baseCommit: base });
            const landed = settle(
              outcome,
              kind,
              async (next) => {
                await attempt(next);
              },
              name
            );
            if (landed) useFileExplorerStore.getState().remapExpandedPaths(entry.path, to);
            else rollback();
            return landed;
          } catch (err) {
            rollback();
            failed(err, kind === 'rename' ? 'Couldn’t rename' : 'Couldn’t move');
            return false;
          } finally {
            cache.refreshAll();
          }
        });
      return attempt(null);
    },
    [changes, cache, guard, baseFor, settle, failed]
  );

  const renameEntry = useCallback(
    async (entry: ExplorerEntry, newName: string): Promise<boolean> => {
      if (newName === entry.name || newName.length === 0) return true;
      return relocate(entry, joinPath(parentOf(entry.path), newName), 'rename');
    },
    [relocate]
  );

  const moveEntry = useCallback(
    async (fromPath: string, toDir: string): Promise<void> => {
      const fromDir = parentOf(fromPath);
      const to = joinPath(toDir, baseName(fromPath));
      if (toDir === fromDir || to === fromPath || isAtOrUnder(toDir, fromPath)) return;
      const entry = cache.entries(fromDir).find((e) => e.path === fromPath);
      if (!entry) return;
      await relocate(entry, to, 'move');
    },
    [cache, relocate]
  );

  /** How many files are under a folder, walking its listings. */
  const countFiles = useCallback(
    async (dir: string): Promise<{ count: number; moreThan: boolean }> => {
      let count = 0;
      const queue = [dir];
      while (queue.length > 0) {
        const next = queue.shift()!;
        const listing = await cache.fetch(next);
        for (const entry of listing.entries) {
          if (entry.type === 'dir') queue.push(entry.path);
          else count += 1;
          if (count >= DELETE_COUNT_LIMIT) return { count, moreThan: true };
        }
      }
      return { count, moreThan: false };
    },
    [cache]
  );

  const requestDelete = useCallback(
    (entry: ExplorerEntry): void => {
      if (entry.type !== 'dir') {
        setPendingDelete({ entry, fileCount: 1, moreThan: false });
        return;
      }
      setPendingDelete({ entry, fileCount: null, moreThan: false });
      countFiles(entry.path).then(
        ({ count, moreThan }) =>
          // Only if the same delete is still waiting: a person who cancelled
          // and asked about a different folder must not see this one's count.
          setPendingDelete((current) =>
            current?.entry.path === entry.path ? { entry, fileCount: count, moreThan } : current
          ),
        () => {
          // Uncounted is still confirmable: the sentence says "everything in it"
          // instead of a number. The delete itself is the server's to refuse.
        }
      );
    },
    [countFiles]
  );

  const remove = useCallback(
    (entry: ExplorerEntry): Promise<void> => {
      const attempt = (baseCommit: string | null): Promise<void> =>
        guard(async () => {
          if (changes === undefined) return;
          const dir = parentOf(entry.path);
          const prev = cache.listing(dir);
          cache.setEntries(dir, (es) => es.filter((e) => e.path !== entry.path));
          try {
            const base = baseCommit ?? (await baseFor(dir));
            if (base === null) {
              cache.restore(dir, prev);
              return;
            }
            const outcome = await changes.remove({ path: entry.path, baseCommit: base });
            const landed = settle(outcome, 'delete', (next) => attempt(next));
            if (landed) useFileExplorerStore.getState().dropExpandedPaths(entry.path);
            else cache.restore(dir, prev);
          } catch (err) {
            cache.restore(dir, prev);
            failed(err, 'Couldn’t delete');
          } finally {
            cache.refreshAll();
          }
        });
      return attempt(null);
    },
    [changes, cache, guard, baseFor, settle, failed]
  );

  const confirmDelete = useCallback(async (): Promise<void> => {
    const waiting = pendingDelete;
    setPendingDelete(null);
    if (waiting) await remove(waiting.entry);
  }, [pendingDelete, remove]);

  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  /** Send an upload whose names are settled — nothing left to ask. */
  const send = useCallback(
    (dir: string, files: File[], replace: string[], firstBase: string | null): Promise<void> => {
      const attempt = (baseCommit: string | null): Promise<void> =>
        guard(async () => {
          if (changes === undefined) return;
          const shown = cache.isLoaded(dir);
          const prev = shown ? cache.listing(dir) : undefined;
          if (shown) {
            const present = new Set(cache.entries(dir).map((e) => e.name));
            const added = files
              .filter((file) => !present.has(file.name))
              .map<ExplorerEntry>((file) => ({
                name: file.name,
                path: joinPath(dir, file.name),
                type: 'file',
                size: file.size,
              }));
            if (added.length > 0) cache.setEntries(dir, (es) => [...es, ...added]);
          }
          try {
            const outcome = await changes.upload({ dir, baseCommit, replace, files });
            const landed = settle(outcome, 'upload', (next) => attempt(next));
            if (!landed && shown) cache.restore(dir, prev);
          } catch (err) {
            if (shown) cache.restore(dir, prev);
            failed(err, 'Couldn’t upload');
          } finally {
            cache.refreshAll();
          }
        });
      return attempt(firstBase);
    },
    [changes, cache, guard, settle, failed]
  );

  const upload = useCallback(
    async (dir: string, files: File[]): Promise<void> => {
      if (changes === undefined || files.length === 0) return;
      if (files.length > changes.maxUploadFiles) {
        toast.error(
          `One upload can carry up to ${changes.maxUploadFiles} files, so nothing was uploaded. Try again with fewer.`
        );
        return;
      }
      // Read the folder as it is NOW rather than as the tree last drew it: the
      // question "is this name taken?" only has a useful answer when it is fresh.
      let listing: ExplorerListing;
      try {
        listing = await cache.fetch(dir);
      } catch (err) {
        failed(err, 'Couldn’t upload');
        return;
      }
      const taken = listing.entries.map((e) => e.name);
      const takenSet = new Set(taken);
      const names = files.map((f) => f.name).filter((name) => takenSet.has(name));
      const baseCommit = listing.commit ?? null;
      if (names.length === 0) {
        await send(dir, files, [], baseCommit);
        return;
      }
      setPendingUpload({ dir, files, names, taken, baseCommit });
    },
    [changes, cache, failed, send]
  );

  const resolveClash = useCallback(
    async (choice: 'replace' | 'keep-both'): Promise<void> => {
      const waiting = pendingUpload;
      setPendingUpload(null);
      if (waiting === null) return;
      if (choice === 'replace') {
        await send(waiting.dir, waiting.files, waiting.names, waiting.baseCommit);
        return;
      }
      // Keep both: each clashing file goes up under the name a copy would get,
      // steering around what the folder holds AND what this upload is adding.
      const used = new Set([...waiting.taken, ...waiting.files.map((f) => f.name)]);
      const clashing = new Set(waiting.names);
      const renamed = waiting.files.map((file) => {
        if (!clashing.has(file.name)) return file;
        const name = freeCopyName({ name: file.name, isDir: false, taken: used });
        used.add(name);
        return new File([file], name, { type: file.type, lastModified: file.lastModified });
      });
      await send(waiting.dir, renamed, [], waiting.baseCommit);
    },
    [pendingUpload, send]
  );

  const cancelClash = useCallback(() => setPendingUpload(null), []);
  const dismissConflict = useCallback(() => setConflict(null), []);

  const pendingClash = useMemo<PendingClash | null>(
    () => (pendingUpload === null ? null : { dir: pendingUpload.dir, names: pendingUpload.names }),
    [pendingUpload]
  );

  return {
    renameEntry,
    moveEntry,
    requestDelete,
    pendingDelete,
    confirmDelete,
    cancelDelete,
    upload,
    pendingClash,
    resolveClash,
    cancelClash,
    conflict,
    dismissConflict,
    busy: busyCount > 0,
  };
}
