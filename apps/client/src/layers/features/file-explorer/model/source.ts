/**
 * What the file explorer browses (spec `project-rooms` §3.9).
 *
 * The explorer used to be one pane over one thing: the session's working
 * directory, read through the files API, written through it too. A room's own
 * files are the same shape of question asked of a different place — one
 * directory at a time, entries with names and kinds — and answered by a
 * different route, from a git commit rather than a live checkout, changed one
 * commit at a time, and with provenance the filesystem cannot give.
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
  /**
   * Set when the place behind the source does not have files at all.
   *
   * Different from an empty directory, and deliberately not an error. Most
   * rooms are conversations and will never have files of their own, so "this
   * room has none" is the ordinary answer rather than a failure — and routing
   * it through the rejection path would mean every repo-less room a person
   * opened logged a query error and dropped a breadcrumb into their next bug
   * report. Same move {@link ExplorerFileBody}'s `not-readable` makes for a
   * file there is nothing to show for.
   *
   * A surface that offers files only where there are any renders nothing on
   * this; one that always shows a tree renders an empty one.
   */
  absent?: true;
  /**
   * The version this listing was read at, for a source that has versions —
   * `null` when the place has none yet (a repo with no commits).
   *
   * What a change to an entry in this directory carries as its lock: a rename
   * or a delete is only safe over files the person has SEEN, and this names
   * exactly the version they saw. Absent on a source that lists a live
   * filesystem.
   */
  commit?: string | null;
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
  /**
   * The version this copy came from, for a source that has versions.
   *
   * Not decoration: it is the whole of the optimistic lock a save carries back
   * (spec §3.10). Absent on a source that reads a live filesystem, where there
   * is no version to name.
   */
  commit?: string | null;
  /** The contents, or why they are not. */
  body: ExplorerFileBody;
}

/**
 * How a save ended.
 *
 * Three outcomes rather than one plus two rejections, for the reason
 * {@link ExplorerFileBody} has three: "somebody else changed it" and "that is
 * too big for this room" are facts a person acts on, not failures of the
 * request. Only something nobody wrote copy for is left to throw.
 */
export type ExplorerSaveOutcome =
  /** It landed. `commit` is the next save's base. */
  | { status: 'saved'; commit: string; lastCommit: ExplorerCommit | null; committed: boolean }
  /**
   * The file moved under the editor and NOTHING was written. `commit` is where
   * the place is now — re-read at it to take theirs, or send it back as the
   * base to save yours over it.
   */
  | { status: 'conflict'; commit: string; lastCommit: ExplorerCommit | null }
  /** It was refused for a reason the person can be told in one sentence. */
  | { status: 'refused'; reason: string };

/** What a save sends. */
export interface ExplorerSaveInput {
  /** The file, relative to the source's root. */
  path: string;
  /** The version the editor's copy came from — {@link ExplorerFile.commit}. */
  baseCommit: string | null;
  /** The file's whole new contents. */
  text: string;
}

/**
 * How a change to a source's tree ended — an upload, a rename or move, or a
 * delete through {@link ExplorerChanges}.
 *
 * Four outcomes rather than one plus rejections, for the reason
 * {@link ExplorerSaveOutcome} has three: each of the last three is something a
 * person answers or acts on, not a failure of the request. Only a refusal
 * nobody wrote copy for is left to throw.
 */
export type ExplorerChangeOutcome =
  /** It landed as one commit. `commit` is where the place is now. */
  | { status: 'changed'; commit: string }
  /**
   * A file the change would touch moved since the person's view of it, and
   * NOTHING was changed. `commit` is where the place is now: re-read at it to
   * see theirs, or send it back as the base to make the change anyway.
   */
  | { status: 'conflict'; path: string; commit: string; lastCommit: ExplorerCommit | null }
  /**
   * The destination already holds something with that name. The person picks:
   * replace it (an upload only), or another name.
   */
  | { status: 'exists'; reason: string }
  /** Refused for a reason the person can be told in one sentence. */
  | { status: 'refused'; reason: string };

/** What an upload sends. */
export interface ExplorerUploadInput {
  /** The folder to upload into; `''` for the source's root. */
  dir: string;
  /** The version the person's view of that folder came from. */
  baseCommit: string | null;
  /** The file NAMES the person agreed to overwrite. */
  replace: string[];
  /** The files, each uploaded under its own name. */
  files: File[];
}

/**
 * The tree writes a source makes through a door of its own, one commit each
 * (spec `agent-home-desk` §7.3).
 *
 * A session's tree is a directory on disk and is written through the files API
 * — which `use-file-crud` already drives, copy and paste included. A room's
 * tree is a git commit, and every change to it is a commit with a person's
 * name on it and a lock on the version they saw. That is a different contract,
 * so it is a different interface rather than the files API in disguise: the
 * operations here are exactly the ones the place has, and nothing else. There
 * is no copy, because a room has no route for one; the pane offers what is
 * here and nothing it would have to refuse.
 *
 * Every method answers an {@link ExplorerChangeOutcome} and throws only on a
 * refusal nobody wrote copy for.
 */
export interface ExplorerChanges {
  /** The most files one upload may carry. */
  readonly maxUploadFiles: number;
  /**
   * Upload files into one folder.
   *
   * @param input - The folder, the version seen, the names to replace, the files.
   */
  upload(input: ExplorerUploadInput): Promise<ExplorerChangeOutcome>;
  /**
   * Rename or move one file or folder.
   *
   * @param input - What moves, where to, and the version the person saw.
   */
  move(input: { from: string; to: string; baseCommit: string }): Promise<ExplorerChangeOutcome>;
  /**
   * Delete one file or folder.
   *
   * @param input - What to delete, and the version the person saw.
   */
  remove(input: { path: string; baseCommit: string }): Promise<ExplorerChangeOutcome>;
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
   * The files API's write paths and the reveal and copy-path actions are
   * defined in terms of a real directory on this machine, and a room's files
   * are a commit — no directory to name, so `null`. A room writes through
   * {@link changes} instead, and the actions that would name a place on disk
   * are not offered.
   */
  readonly cwd: string | null;
  /** Whether entries may be created, renamed, moved and deleted. */
  readonly writable: boolean;
  /**
   * The source's own door for tree writes, for a {@link writable} source whose
   * tree is not a directory on disk (a room's files). Absent on a source the
   * files API writes to, which is every session directory.
   *
   * When present, the pane makes its changes through here, offers upload, and
   * offers nothing this interface does not have — no copy, paste or duplicate.
   */
  readonly changes?: ExplorerChanges;
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
   * Put one file where every member of this place can see it, when the place
   * has such a surface (spec `room-canvas` §9.5).
   *
   * A room does: its canvas is a table the whole room shares, so showing a file
   * on it is a thing one member does FOR the others. A session directory does
   * not — its canvas is already this browser's own, and opening a file there is
   * what clicking it already does.
   *
   * Absent means there is nowhere to put it, and the control is not drawn.
   *
   * **It REJECTS when the place refused**, because a write everybody else can
   * see is exactly the kind a person must not be told succeeded when it did
   * not. The caller owns what they are told.
   */
  readonly showToEveryone?: (path: string) => Promise<void>;
  /**
   * Whether a file opened from this source may be changed and saved back
   * (spec `project-rooms` §3.10).
   *
   * Separate from {@link writable}, which is about the TREE — creating,
   * renaming, moving and deleting entries. A room's files are the opposite pair
   * from a session's: their contents are a person's to edit, while the shape of
   * the tree is what merging changes.
   *
   * Declared rather than inferred from `save` being present, for the reason the
   * module header gives: a call site must not have to probe.
   */
  readonly editable: boolean;
  /**
   * Save one file, for an {@link editable} source. Absent otherwise.
   *
   * Refusals a person can act on come back as an outcome; anything else
   * rejects.
   *
   * @param input - The file, the version it was read at, and its new contents.
   */
  save?(input: ExplorerSaveInput): Promise<ExplorerSaveOutcome>;
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

/** The parts of a source that decide where its listings are cached. */
type ExplorerCacheIdentity = Pick<FileExplorerSource, 'scopeKey' | 'filtersHidden'>;

/**
 * The query key one directory of one source is cached under.
 *
 * Deliberately the shape it has always had, with the scope key sitting where
 * the working directory used to: a session source's `scopeKey` IS its cwd and
 * it filters server-side, so its keys are byte-identical to the ones before
 * sources existed.
 *
 * **`showHidden` partitions the key only for a source that filters it.** The
 * flag is in the key because it changes the server's ANSWER — ask with it off
 * and the dotfiles are not in the response. A source that serves its tree whole
 * and leaves the filtering to the pane gives the same bytes either way, so
 * partitioning on it there would buy a fresh round trip every time the eye is
 * pressed, to be handed back what is already in the cache.
 *
 * @param source - The source's identity: where it caches, and who filters.
 * @param dirPath - The directory, `''` for the root.
 * @param showHidden - Whether hidden entries are wanted.
 */
export function explorerDirQueryKey(
  source: ExplorerCacheIdentity,
  dirPath: string,
  showHidden: boolean
): readonly unknown[] {
  return [
    'file-explorer',
    'tree',
    source.scopeKey,
    dirPath,
    source.filtersHidden ? showHidden : null,
  ] as const;
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
    queryKey: explorerDirQueryKey(source, dirPath, showHidden),
    queryFn: () => source.list(dirPath, { showHidden }),
    staleTime: QUERY_TIMING.FILE_TREE_STALE_TIME_MS,
    gcTime: QUERY_TIMING.FILE_TREE_GC_TIME_MS,
    // Hold the previous rows while a show-hidden toggle refetches, so the tree
    // never blanks to a root spinner (DOR-404 review nit 3). Toggling
    // show-hidden repartitions this dir's key, and a fresh observer for the new
    // key finds no previous data of its own — so read the sibling (opposite
    // show-hidden) listing straight from the cache as the placeholder instead.
    // A first-ever expand has neither key cached, so its skeleton still shows.
    // For a source the pane filters itself both keys are the same one, and
    // `prev` answers before the cache is ever consulted.
    placeholderData: (prev: ExplorerListing | undefined) =>
      prev ??
      queryClient.getQueryData<ExplorerListing>(explorerDirQueryKey(source, dirPath, !showHidden)),
  };
}
