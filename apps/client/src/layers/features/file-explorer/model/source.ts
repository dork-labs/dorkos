/**
 * What the file explorer browses (spec `project-rooms` §3.9).
 *
 * The explorer used to be one pane over one thing: the session's working
 * directory, read through the files API, written through it too. A room's own
 * files are the same shape of question asked of a different place — one
 * directory at a time, entries with names and kinds — and answered by a
 * different route, from a git commit rather than a live checkout, read-only,
 * and with provenance the filesystem cannot give.
 *
 * So the pane takes a SOURCE rather than a working directory. A source is the
 * whole of what the explorer needs to know about where its entries come from:
 * how to list a directory, how to read a file, when to look again, and which of
 * the pane's affordances the place behind it can actually honour. Everything
 * else — the lazy tree, the keyboard model, the persisted expansion, the rows —
 * is the same component for both, which is the point.
 *
 * **Capabilities are declared, never sniffed.** `writable`, `provenance` and
 * the rest are facts about the source, so the pane asks the source rather than
 * guessing from the shape of an entry. A read-only source that merely omitted
 * its write methods would still have to be probed at every call site.
 *
 * @module features/file-explorer/model/source
 */
import type { QueryClient } from '@tanstack/react-query';
import { QUERY_TIMING } from '@/layers/shared/lib';

/**
 * Who last touched a path, when a source can say.
 *
 * Straight from git for a room's files. Every field is member-written text —
 * a name on a commit, a subject line somebody typed — so a renderer treats it
 * as a label and never as markup.
 */
export interface ExplorerCommit {
  /** The full commit sha. */
  sha: string;
  /** The name on the commit. Untrusted text. */
  author: string;
  /** When it was authored, ISO 8601 with an offset. */
  at: string;
  /** The commit's subject line. Untrusted text. */
  subject: string;
}

/**
 * One entry in a listing, whichever source produced it.
 *
 * A superset of the session files API's `FileEntry` with every added field
 * optional, so a `FileEntry` IS an `ExplorerEntry` and the session path needed
 * no mapping at all. `mtime` is optional for the opposite reason: a commit view
 * has no modification times, because a commit is not a filesystem.
 */
export interface ExplorerEntry {
  /** The entry's own name, with no directory in it. */
  name: string;
  /** Its path from the tree's root, `/`-separated and never leading with one. */
  path: string;
  /**
   * Whether the row can be opened into (a directory) or opened (everything
   * else). A symlink and a submodule are both `file`: neither is descended
   * into — a link is listed, never followed — so neither gets a chevron.
   */
  type: 'file' | 'dir';
  /** The entry's size in bytes; `0` for anything that has no bytes of its own. */
  size: number;
  /** Epoch ms, when the source has one. A commit view does not. */
  mtime?: number;
  /** Whether the entry is a symlink, which is listed rather than followed. */
  isSymlink?: boolean;
  /**
   * Who last touched it, `null` when the source looked and nothing did, and
   * absent when the source cannot answer the question at all. The column draws
   * only for a source that declares {@link FileExplorerSource.provenance}.
   */
  lastCommit?: ExplorerCommit | null;
}

/** One directory, as a source answers it. */
export interface ExplorerListing {
  /** The directory's immediate children. */
  entries: ExplorerEntry[];
}

/**
 * One file's contents, or the honest reason they are not here.
 *
 * `binary` and `too-large` are outcomes rather than failures — facts about the
 * file that a reader should render — which is why they are variants here and
 * not rejections. Only `text` carries bytes.
 */
export type ExplorerFileBody =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; maxBytes: number }
  | { kind: 'not-readable'; reason: string };

/** One file, as a source answers it. */
export interface ExplorerFile {
  /** The file's path from the tree's root. */
  path: string;
  /** Its size in bytes, whether or not the bytes are here. */
  size: number;
  /** Who last touched it, when the source can say. */
  lastCommit?: ExplorerCommit | null;
  /** The contents, or why they are not. */
  body: ExplorerFileBody;
}

/** Where the explorer's entries come from, and what may be done with them. */
export interface FileExplorerSource {
  /**
   * This source's stable identity.
   *
   * Two jobs, and they are the same job: it segments the query cache, and it is
   * the key the pane's expansion, selection and scroll are persisted under. A
   * session source uses its working directory verbatim, which is exactly the
   * key the explorer used before there were sources — so a session's saved tree
   * survived this refactor rather than being reset by it.
   */
  readonly scopeKey: string;
  /**
   * The session working directory behind this source, or `null` when there
   * isn't one.
   *
   * The write and reveal paths are defined in terms of a real directory on this
   * machine, and a room's files are a commit — no directory to name, so `null`,
   * and those paths are never reachable because {@link writable} is false.
   */
  readonly cwd: string | null;
  /** Whether entries may be created, renamed, moved, copied and deleted. */
  readonly writable: boolean;
  /** Whether entries carry {@link ExplorerEntry.lastCommit} — the provenance column. */
  readonly provenance: boolean;
  /**
   * Whether the source has already dropped hidden and plumbing entries by the
   * time the pane sees them.
   *
   * The session files API filters server-side (dotfiles plus whatever
   * `git check-ignore` claims), and it knows things the client cannot — so the
   * pane leaves that source alone and filters only what a source hands over
   * unfiltered. The toggle drives both; only the place the filtering happens
   * differs.
   */
  readonly filtersHidden: boolean;
  /**
   * Where a chosen file is shown: pushed into the app's canvas, or previewed in
   * the pane itself.
   *
   * The canvas is a session surface — it opens a document beside a
   * conversation, against that session's working directory — so a room's files,
   * which have neither, preview in place instead.
   */
  readonly preview: 'canvas' | 'inline';
  /**
   * List one directory.
   *
   * @param path - The directory, `''` for the source's root.
   * @param options - `showHidden` is passed through for a source that filters
   *   its own listings; a source that does not may ignore it.
   */
  list(path: string, options: { showHidden: boolean }): Promise<ExplorerListing>;
  /**
   * Read one file, for a source that previews in place. Absent on a source
   * whose files open somewhere else.
   *
   * @param path - The file, relative to the source's root.
   */
  read?(path: string): Promise<ExplorerFile>;
  /**
   * Subscribe to whatever means "these files may have changed".
   *
   * Optional, and absent on a source nothing else writes to: a session's
   * working directory changes because the person or their agent changed it, and
   * both of those already refresh the pane. A room's files change because
   * somebody merged, which this client learns from the room's own stream.
   *
   * @param onChange - Called when the listing may be stale. Cheap to call
   *   often; the pane turns it into a refetch.
   * @returns An unsubscribe function.
   */
  events?(onChange: () => void): () => void;
}

/**
 * The query key one directory of one source is cached under.
 *
 * Deliberately the shape it has always had, with the scope key sitting where
 * the working directory used to: a session source's `scopeKey` IS its cwd, so
 * the keys are byte-identical to the ones before sources existed.
 *
 * @param scopeKey - The source's identity.
 * @param dirPath - The directory, `''` for the root.
 * @param showHidden - Part of the key, because it partitions the answer.
 */
export function explorerDirQueryKey(
  scopeKey: string,
  dirPath: string,
  showHidden: boolean
): readonly unknown[] {
  return ['file-explorer', 'tree', scopeKey, dirPath, showHidden] as const;
}

/**
 * How one directory of one source is fetched and cached — the single
 * definition, so that everything asking the same question shares one cache
 * entry and one request.
 *
 * The pane asks for every visible directory; a surface deciding whether to
 * offer files at all asks for the root. Both go through here, which is what
 * makes the second question free: it is already the first one's answer.
 *
 * @param source - Where the entries come from.
 * @param dirPath - The directory, `''` for the root.
 * @param showHidden - Whether hidden entries are wanted.
 * @param queryClient - The cache, read for the show-hidden placeholder.
 */
export function explorerDirQueryOptions(
  source: FileExplorerSource,
  dirPath: string,
  showHidden: boolean,
  queryClient: QueryClient
) {
  return {
    queryKey: explorerDirQueryKey(source.scopeKey, dirPath, showHidden),
    queryFn: () => source.list(dirPath, { showHidden }),
    staleTime: QUERY_TIMING.FILE_TREE_STALE_TIME_MS,
    gcTime: QUERY_TIMING.FILE_TREE_GC_TIME_MS,
    // Hold the previous rows while a show-hidden toggle refetches, so the tree
    // never blanks to a root spinner (DOR-404 review nit 3). Toggling
    // show-hidden repartitions this dir's key, and a fresh observer for the new
    // key finds no previous data of its own — so read the sibling (opposite
    // show-hidden) listing straight from the cache as the placeholder instead.
    // A first-ever expand has neither key cached, so its skeleton still shows.
    placeholderData: (prev: ExplorerListing | undefined) =>
      prev ??
      queryClient.getQueryData<ExplorerListing>(
        explorerDirQueryKey(source.scopeKey, dirPath, !showHidden)
      ),
  };
}
