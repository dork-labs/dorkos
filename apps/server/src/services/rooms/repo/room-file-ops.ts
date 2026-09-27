/**
 * The mechanics under every change a person makes to a room's files (spec
 * `agent-home-desk` §7.1): the path checks a write needs, the per-file lock,
 * and **one change set — a list of `{ path, content | null }` — written,
 * staged and committed once, or rolled back entirely.**
 *
 * `room-file-editor.ts` decides WHAT a save, an upload, a rename, a delete or a
 * copy of a chat attachment changes, and who may ask. This module is how any of
 * them lands, so the rules below are stated once and hold for all five:
 *
 * - **Every spelling of `.git` a filesystem opens as the real thing is
 *   refused** ({@link assertWritablePath}): any case, trailing dots and spaces,
 *   HFS-ignorable characters, the 8.3 alias `git~N`, and — by refusing colons —
 *   NTFS stream names like `.git::$INDEX_ALLOCATION`. `repo/.git` is the common
 *   directory every worktree of the room shares.
 * - **No ancestor of a written path may be a symlink on disk**, and the target
 *   itself is opened `O_NOFOLLOW` ({@link assertNoLinkOnDisk}). A link in the
 *   TREE is refused by the tree checks, but one that is not in the tree at all —
 *   untracked and hidden by a member-written `.gitignore` — would otherwise be
 *   followed straight out of the room.
 * - **A new path is placed against the tree one folder at a time**
 *   ({@link RoomTreeIndex.assertPlaceable}): a parent that is a file is refused,
 *   and so is any segment that differs only in capitals from what is really
 *   there. APFS and NTFS fold case, so `Notes/plan.md` beside an existing
 *   `notes/` lands inside `notes/` on disk while git records `Notes/` — a commit
 *   that names the wrong path and a checkout left dirty.
 * - **Nothing is left half-done.** If any step fails, every path in the set is
 *   put back the way `HEAD` has it (or removed, when `HEAD` never had it), and
 *   every folder the set created is removed again — because a tree left dirty
 *   stops every merge in the room with `MAIN_CHECKOUT_DIRTY`, and a change that
 *   fails must not be the thing that wedges a room.
 *
 * @module server/services/rooms/repo/room-file-ops
 */
import { constants as fsConstants, createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { RoomRepoCaps } from '@dorkos/shared/room-repo';
import type { RoomFileCommit } from '@dorkos/shared/room-files';
import { logger } from '../../../lib/logger.js';
import { RoomError } from '../room-errors.js';
import {
  commitStaged,
  GITLINK_MODE,
  GitUnavailableError,
  hasStagedChanges,
  isIgnored,
  listTree,
  restoreFromHead,
  runGitRaw,
  stagePaths,
  SYMLINK_MODE,
  UnreadablePathError,
  unstagePaths,
  type GitIdentity,
  type TreeEntry,
} from './room-repo-git.js';

/**
 * Code points HFS+ ignores when it compares names — git's own `is_hfs_dotgit`
 * list (ZWNJ/ZWJ, the bidi marks and embeddings, the deprecated format
 * characters, the BOM). On a filesystem that ignores them, `.g\u200cit` opens
 * `.git`.
 */
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * Whether one path segment is a door into the repository's own `.git`, on any
 * filesystem a room might live on — git's `is_ntfs_dotgit` and `is_hfs_dotgit`,
 * applied together because a room repo can be checked out on either.
 *
 * - **Case** is folded (APFS, NTFS: `.GIT` is `.git`).
 * - **HFS-ignorable code points** are dropped ({@link HFS_IGNORABLE}).
 * - **Trailing dots and spaces** are trimmed: NTFS opens `.git.`, `.git..` and
 *   `.git. .` as `.git`.
 * - **The 8.3 short name** `git~<digit>` is NTFS's alias for `.git` — any digit,
 *   not only `1`, because which one it gets depends on what else the folder
 *   held when it was made.
 *
 * Colons never get here: {@link assertWritablePath} refuses any segment with
 * one, which is what closes the NTFS stream syntax (`.git::$INDEX_ALLOCATION`,
 * `.git:x`) — a name that opens `.git` itself as a folder.
 *
 * @param segment - One path segment.
 */
function isGitDirSegment(segment: string): boolean {
  const folded = segment
    .replace(HFS_IGNORABLE, '')
    .replace(/[. ]+$/, '')
    .toLowerCase();
  return folded === '.git' || /^git~\d$/.test(folded);
}

/**
 * `O_NOFOLLOW` where the platform has it, and nothing where it does not.
 *
 * The final component of every write is opened with it, so a symlink that
 * appears between the check and the write is refused by the KERNEL rather than
 * followed. Windows has no such flag and no symlinks without a privilege, so
 * there it is zero and the lstat walk is the whole guard.
 */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** The git mode of an executable file, the one mode bit git records. */
const EXECUTABLE_MODE = '100755';

/**
 * What one path in a change set becomes.
 *
 * Bytes already in memory (a text save, a chat attachment), a file on disk to
 * stream from (an upload multer staged), or a blob already in the repository (a
 * file being moved), read only at the moment it is written — so a large upload
 * or a large folder being moved never sits in memory all at once.
 */
export type RoomFileContent =
  Buffer | { file: string; size: number } | { blob: string; size: number };

/** One path in a change set: its new contents, or `null` to remove it. */
export interface RoomFileChange {
  /** The normalised repo-relative path. */
  path: string;
  /** What it will hold, or `null` when the change removes it. */
  content: RoomFileContent | null;
  /** Whether `main` holds this path now, which decides how a failure is undone. */
  existed: boolean;
  /** Written with the executable bit — a file moved keeps the mode it had. */
  executable?: boolean;
}

/**
 * The size of one piece of content, in bytes.
 *
 * @param content - Bytes, or a staged file with its measured size.
 */
export function contentSize(content: RoomFileContent): number {
  return Buffer.isBuffer(content) ? content.length : content.size;
}

/** How many paths one git command is handed, so a large folder never outgrows a command line. */
const PATH_BATCH = 200;

/**
 * Run a path-taking git step over a list in batches of {@link PATH_BATCH}.
 *
 * @param paths - Every path.
 * @param step - The step, for one batch.
 */
async function inBatches(
  paths: readonly string[],
  step: (batch: readonly string[]) => Promise<void>
): Promise<void> {
  for (let at = 0; at < paths.length; at += PATH_BATCH) {
    await step(paths.slice(at, at + PATH_BATCH));
  }
}

/**
 * Refuse a path that names the repository's own git directory.
 *
 * Runs AFTER `normalizeRoomFilePath`, which has already refused `..`, an
 * absolute path, a backslash and a control character — so what is left to check
 * is what the path NAMES rather than where it could climb to.
 *
 * @param filePath - A normalised repo-relative path.
 * @throws {RoomError} `ROOM_FILE_PATH_INVALID`.
 */
export function assertWritablePath(filePath: string): void {
  // **A colon anywhere is refused**, for two reasons that each suffice. A
  // LEADING colon is pathspec magic that `check-ignore` cannot disarm
  // ({@link isIgnored} cannot wrap it in `:(literal)`), which surfaced as a 500
  // with no code (`:!x.md`, found in review). And ANY colon is NTFS stream
  // syntax: `.git::$INDEX_ALLOCATION` and `.git:x` open the repository's own
  // `.git` folder on Windows. Windows cannot hold a filename with a colon at
  // all, so no room that has to travel between machines needs one.
  if (filePath.includes(':')) {
    throw new RoomError(
      'ROOM_FILE_PATH_INVALID',
      'That path is not one this room can have: a name cannot contain a colon.'
    );
  }
  for (const segment of filePath.split('/')) {
    if (isGitDirSegment(segment)) {
      throw new RoomError(
        'ROOM_FILE_PATH_INVALID',
        'That path is not one this room can have: it names the room’s own git directory.'
      );
    }
  }
}

/**
 * Refuse a path this room's own `.gitignore` excludes.
 *
 * A change is a commit, and `git add` refuses an ignored path outright — so
 * without this the request would fail deep inside git and answer a server
 * error, having written a file it then has to take back. The ignore rules are
 * member-written, so this is not a security boundary; it is an honest answer
 * about what the room keeps.
 *
 * @param repoDir - The room's main checkout.
 * @param ceilingDir - The room home directory git's search may not climb past.
 * @param filePath - The normalised repo-relative path.
 * @throws {RoomError} `ROOM_FILE_NOT_READABLE`, or `ROOM_FILE_PATH_INVALID` for
 *   a path git cannot read as a path.
 */
export async function assertNotIgnored(
  repoDir: string,
  ceilingDir: string,
  filePath: string
): Promise<void> {
  let ignored: boolean;
  try {
    ignored = await isIgnored(repoDir, filePath, ceilingDir);
  } catch (err) {
    // A path git cannot read as a path is a bad path, not a broken server —
    // the second closure behind {@link assertWritablePath}'s leading-colon
    // rule, so a spelling nobody predicted still answers with a code.
    if (err instanceof UnreadablePathError) {
      throw new RoomError(
        'ROOM_FILE_PATH_INVALID',
        'That path is not one this room can have: git cannot read it as a file name.'
      );
    }
    throw err;
  }
  if (!ignored) return;
  throw new RoomError(
    'ROOM_FILE_NOT_READABLE',
    `This room’s files are set to ignore \`${filePath}\`, so saving it would not keep it. Change the room’s \`.gitignore\` first, or save somewhere else.`
  );
}

/**
 * Refuse contents that would not survive being read back as text.
 *
 * A `NUL` anywhere makes the file binary by git's own test, and the read path
 * answers a binary file as `binary` — so committing one through the TEXT editor
 * would hand somebody a file they saved and can no longer open. Uploads and
 * attachment copies are bytes on purpose and never come through here.
 *
 * @param filePath - The path being saved.
 * @param bytes - The contents.
 * @throws {RoomError} `ROOM_FILE_NOT_TEXT`.
 */
export function assertText(filePath: string, bytes: Buffer): void {
  if (!bytes.includes(0)) return;
  throw new RoomError(
    'ROOM_FILE_NOT_TEXT',
    `\`${filePath}\` would not be a text file any more, and DorkOS only saves text here. Share a file like that as an attachment instead.`
  );
}

/**
 * Refuse a change whose path passes through, or lands on, a symlink on disk.
 *
 * The tree already says what git knows about; this is about what git does NOT
 * know about. An untracked symlink hidden from `git status` by a member-written
 * `.gitignore` is invisible to every tree check, and writing through it puts the
 * person's file wherever it points — outside the room.
 *
 * Each existing ancestor is `lstat`ed, deepest last, and the target itself with
 * it. Nothing is resolved: the question is "is this component a link", which a
 * `lstat` answers exactly.
 *
 * @param repoDir - The room's main checkout.
 * @param filePath - The normalised repo-relative path.
 * @param allowLinkTarget - Whether the final component may itself be a link —
 *   true only when REMOVING a link the tree records, which unlinks the link and
 *   follows nothing.
 * @throws {RoomError} `ROOM_FILE_NOT_READABLE`.
 */
export async function assertNoLinkOnDisk(
  repoDir: string,
  filePath: string,
  allowLinkTarget = false
): Promise<void> {
  const segments = filePath.split('/');
  let at = repoDir;
  for (const [index, segment] of segments.entries()) {
    at = path.join(at, segment);
    let stat;
    try {
      stat = await fs.lstat(at);
    } catch {
      // Not there yet: a file or folder being created. Nothing to follow.
      return;
    }
    const isTarget = index === segments.length - 1;
    if (stat.isSymbolicLink() && !(isTarget && allowLinkTarget)) {
      throw new RoomError(
        'ROOM_FILE_NOT_READABLE',
        `\`${segments.slice(0, index + 1).join('/')}\` is a link, and DorkOS does not write through links out of a room.`
      );
    }
  }
}

/**
 * Refuse a change set that would not fit the room's frozen ceilings.
 *
 * The repo total is measured on the tree the change WOULD leave, not on how much
 * it adds — the same way the merge validation measures it — so a replaced
 * file's current bytes are replaced rather than counted twice, and a removed
 * file stops counting.
 *
 * @param changes - The change set.
 * @param tree - Every blob in `main`'s tree.
 * @param caps - The room's frozen ceilings.
 * @throws {RoomError} `FILE_TOO_LARGE` or `REPO_CAP_EXCEEDED`.
 */
export function assertFits(
  changes: readonly RoomFileChange[],
  tree: ReadonlyMap<string, TreeEntry>,
  caps: RoomRepoCaps
): void {
  const touched = new Set(changes.map((change) => change.path));
  let total = 0;
  for (const entry of tree.values()) {
    if (!touched.has(entry.path)) total += entry.size;
  }
  for (const change of changes) {
    if (change.content === null) continue;
    const size = contentSize(change.content);
    if (size > caps.maxFileBytes) {
      throw new RoomError(
        'FILE_TOO_LARGE',
        `\`${change.path}\` would be ${describeBytes(size)}, and this room’s limit for one file is ${describeBytes(caps.maxFileBytes)}.`
      );
    }
    total += size;
  }
  if (total > caps.maxRepoBytes) {
    throw new RoomError(
      'REPO_CAP_EXCEEDED',
      `This would take the room’s files to ${describeBytes(total)}, past its ${describeBytes(caps.maxRepoBytes)} limit. Remove what is no longer needed, or attach large files to a message instead.`
    );
  }
}

/**
 * A byte count as a person reads it — the same coarse shape the merge refusals
 * use, so two ceilings on the same act are described the same way.
 *
 * @param bytes - The count.
 */
export function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** One name in a folder of the tree, as it is really spelled. */
interface TreeChild {
  /** The name, exactly as the tree spells it. */
  name: string;
  /** Whether it is a folder (holds other paths) rather than a file. */
  isDir: boolean;
}

/**
 * A room's tree seen folder by folder, for placing NEW paths in it.
 *
 * A recursive `ls-tree` lists files only; this indexes every folder those files
 * imply, keyed by parent path and by {@link foldName} — NFC, then lower case —
 * so "is there already something at this level that this filesystem would open
 * instead" is one lookup per segment. APFS and NTFS fold case, and APFS also
 * treats `café` spelled with a combining accent (NFD) and with a precomposed one
 * (NFC) as one name. Paths a change set is about to add are {@link add}ed as they are
 * placed, so two uploads in one batch cannot collide with each other either.
 */
export class RoomTreeIndex {
  /** parent path (`''` for the root) → lower-cased name → the real child. */
  private readonly children = new Map<string, Map<string, TreeChild>>();
  /** Every file path, exactly spelled. */
  private readonly files = new Set<string>();

  /**
   * Index a tree's file paths.
   *
   * @param paths - The file paths already in the tree (and staying there).
   */
  constructor(paths: Iterable<string>) {
    for (const filePath of paths) this.add(filePath);
  }

  /**
   * Record one file path, and every folder above it.
   *
   * @param filePath - A normalised repo-relative file path.
   */
  add(filePath: string): void {
    this.files.add(filePath);
    const segments = filePath.split('/');
    let parent = '';
    for (const [index, name] of segments.entries()) {
      const isDir = index < segments.length - 1;
      let level = this.children.get(parent);
      if (!level) {
        level = new Map();
        this.children.set(parent, level);
      }
      const key = foldName(name);
      const known = level.get(key);
      if (!known || (isDir && !known.isDir)) level.set(key, { name, isDir });
      parent = parent === '' ? name : `${parent}/${name}`;
    }
  }

  /**
   * Whether the tree holds this exact path as a file.
   *
   * @param filePath - The path.
   */
  hasFile(filePath: string): boolean {
    return this.files.has(filePath);
  }

  /**
   * The spelling a path a person sent has in THIS tree.
   *
   * A person's path and the tree's can name the same file with different bytes:
   * `café.md` typed on one machine arrives NFD, the tree (git with
   * `core.precomposeunicode`) holds it NFC, and APFS opens either as the one
   * file. Compared byte for byte, the tree would say "no such file", the lock
   * and `ROOM_FILE_EXISTS` would be skipped, and the write would overwrite the
   * real file. So each segment that matches an existing name once both are NFC
   * takes the tree's own spelling; a segment the tree does not have is NFC, the
   * form git on macOS records. Case is NOT canonicalized — a name that differs
   * in capitals stays different, and {@link assertPlaceable} refuses it naming
   * the real one.
   *
   * @param filePath - A normalised repo-relative path.
   * @returns The same path, spelled as the tree spells it.
   */
  canonicalize(filePath: string): string {
    const out: string[] = [];
    let parent = '';
    for (const segment of filePath.split('/')) {
      const nfc = segment.normalize('NFC');
      const known = this.children.get(parent)?.get(foldName(segment));
      const name = known && known.name.normalize('NFC') === nfc ? known.name : nfc;
      out.push(name);
      parent = parent === '' ? name : `${parent}/${name}`;
    }
    return out.join('/');
  }

  /**
   * Refuse a NEW file path that cannot be placed in this tree as spelled.
   *
   * Walked one segment at a time from the root, because each level is its own
   * question:
   *
   * - **A folder segment that is a FILE** (`notes.md/x`) is refused
   *   `ROOM_FILE_PATH_INVALID` — the folder cannot be made, and saving now
   *   creates missing folders, so this is the one way a parent can be wrong.
   * - **Any segment that differs only in capitals from the name really there**
   *   is refused, naming what is there — `notes/` for a folder. On macOS and
   *   Windows the two are one name: the write would land in the existing folder
   *   (or on the existing file's bytes) while git recorded the new spelling.
   * - **The path itself naming a folder** is refused: a file cannot replace
   *   one.
   *
   * @param filePath - The new path, normalised.
   * @throws {RoomError} `ROOM_FILE_PATH_INVALID` or `ROOM_FILE_NOT_READABLE`.
   */
  assertPlaceable(filePath: string): void {
    const segments = filePath.split('/');
    let parent = '';
    for (const [index, name] of segments.entries()) {
      const isLast = index === segments.length - 1;
      const known = this.children.get(parent)?.get(foldName(name));
      const here = parent === '' ? name : `${parent}/${name}`;
      if (known) {
        const real = parent === '' ? known.name : `${parent}/${known.name}`;
        if (known.name !== name) {
          throw new RoomError(
            'ROOM_FILE_NOT_READABLE',
            `This room already has \`${known.isDir ? `${real}/` : real}\`, and a name that differs only in capital letters or accents is the same ${known.isDir ? 'folder' : 'file'} on some computers. Use \`${known.isDir ? `${real}/` : real}\` instead.`
          );
        }
        if (!isLast && !known.isDir) {
          throw new RoomError(
            'ROOM_FILE_PATH_INVALID',
            `\`${here}\` is a file in this room, so it cannot hold other files.`
          );
        }
        if (isLast && known.isDir) {
          throw new RoomError('ROOM_FILE_NOT_READABLE', `\`${here}\` is a folder, not a file.`);
        }
      }
      parent = here;
    }
  }
}

/**
 * The key two names collide on, on a filesystem that folds case and Unicode
 * normalization: NFC, then lower case.
 *
 * @param name - One path segment.
 */
function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Refuse to overwrite something in the tree that is not an ordinary file.
 *
 * A symlink and a submodule answer the same way a READ of them does — they are
 * the two things a room's files can hold at a file's path that are not a file,
 * and a change that "worked" on either would destroy something.
 *
 * @param filePath - The path being written.
 * @param existing - What the tree holds there.
 * @throws {RoomError} `ROOM_FILE_NOT_READABLE`.
 */
export function assertOrdinaryFile(filePath: string, existing: TreeEntry): void {
  if (existing.mode === SYMLINK_MODE) {
    throw new RoomError(
      'ROOM_FILE_NOT_READABLE',
      `\`${filePath}\` is a link, not a file. DorkOS does not write through links out of a room.`
    );
  }
  if (existing.mode === GITLINK_MODE) {
    throw new RoomError(
      'ROOM_FILE_NOT_READABLE',
      `\`${filePath}\` is another repository inside this one, not a file.`
    );
  }
}

/**
 * Whether an entry is executable — the one mode bit a move carries over.
 *
 * @param entry - The tree entry.
 */
export function isExecutable(entry: TreeEntry): boolean {
  return entry.mode === EXECUTABLE_MODE;
}

/** What the optimistic lock found. */
export type RoomFileLockOutcome =
  | { status: 'unchanged' }
  /** A locked path differs between the base commit and `main` — the first, in byte order. */
  | { status: 'changed'; path: string };

/**
 * The optimistic lock over a SET of paths: did any of them change since the
 * editor read them?
 *
 * The same question the single-file save always asked, widened to a folder:
 * `isLocked` names which paths count (one file, every file under a folder, the
 * files an upload replaces), and every such path present in EITHER commit is
 * compared by blob AND mode. Created since, deleted since and made executable
 * since are all changes. The room moving on somewhere else is not.
 *
 * - The editor read the commit `main` is at — nothing can have changed.
 * - The editor read a commit this repository does not have — reported as a
 *   change on the first locked path the room has now: overwriting blind is not
 *   the fix for being out of step.
 *
 * @param repoDir - The room's main checkout.
 * @param ceiling - The room home directory git's search may not climb past.
 * @param head - The commit `main` points at.
 * @param headTree - `main`'s tree.
 * @param baseCommit - What the editor read.
 * @param isLocked - Which paths the lock covers.
 * @param fallbackPath - The path to name when the base is unknown and no locked
 *   path exists at `main`.
 */
export async function checkLockedPaths(
  repoDir: string,
  ceiling: string,
  head: string,
  headTree: ReadonlyMap<string, TreeEntry>,
  baseCommit: string,
  isLocked: (filePath: string) => boolean,
  fallbackPath: string
): Promise<RoomFileLockOutcome> {
  if (baseCommit === head) return { status: 'unchanged' };

  let baseTree: Map<string, TreeEntry>;
  try {
    baseTree = await listTree(repoDir, baseCommit, ceiling);
  } catch (err) {
    if (err instanceof GitUnavailableError) throw err;
    logger.warn('[rooms] a room file change named a commit this room does not have', {
      repoDir,
      baseCommit,
      err,
    });
    const first = [...headTree.keys()].filter(isLocked).sort()[0];
    return { status: 'changed', path: first ?? fallbackPath };
  }

  const locked = new Set<string>();
  for (const key of headTree.keys()) if (isLocked(key)) locked.add(key);
  for (const key of baseTree.keys()) if (isLocked(key)) locked.add(key);
  for (const filePath of [...locked].sort()) {
    const before = baseTree.get(filePath);
    const now = headTree.get(filePath);
    if (before?.sha !== now?.sha || before?.mode !== now?.mode) {
      return { status: 'changed', path: filePath };
    }
  }
  return { status: 'unchanged' };
}

/**
 * Write a change set to disk, stage exactly its paths, and commit it once —
 * undoing every part of it if any step fails.
 *
 * Removals run first, then writes. The order is what lets a rename that only
 * changes capitals work on a filesystem that folds case: `notes.md` is gone
 * before `Notes.md` is created, so the create does not open — and then the
 * removal delete — the same file. For the same reason removals are unstaged
 * (`git rm --cached`) before writes are staged: git's index keeps a case-folded
 * name's old spelling otherwise, and the commit would record no rename at all.
 * Measured on APFS both ways.
 *
 * @param repoDir - The room's main checkout.
 * @param ceiling - The room home directory git's search may not climb past.
 * @param changes - The change set, already checked.
 * @param subject - The commit subject.
 * @param identity - Who the commit is authored as.
 * @returns The new commit, or `null` when the set changed nothing git records
 *   (bytes identical to what `main` holds) and nothing was committed.
 */
export async function commitChangeSet(
  repoDir: string,
  ceiling: string,
  changes: readonly RoomFileChange[],
  subject: string,
  identity: GitIdentity
): Promise<string | null> {
  const undo: ChangeSetUndo = { folders: [], files: [] };
  try {
    const removals = changes.filter((change) => change.content === null);
    const writes = changes.filter((change) => change.content !== null);
    for (const change of removals) {
      await fs.rm(path.join(repoDir, change.path), { force: true });
      await pruneEmptyParents(repoDir, change.path);
    }
    for (const change of writes) {
      undo.folders.push(...(await makeParents(repoDir, change.path)));
      // **A path the tree does not hold must not exist on disk either.** If it
      // does, it is another name for something that is there — a different
      // Unicode spelling or case of a real file — and writing would overwrite
      // it, and undoing the write would delete it. `writeContent` creates such
      // a path `O_EXCL`, so the refusal is the kernel's and atomic, and a file
      // is recorded as ours to remove only once the create has succeeded.
      await writeContent(repoDir, ceiling, change, () => undo.files.push(change.path));
    }

    await inBatches(
      removals.map((change) => change.path),
      (batch) => unstagePaths(repoDir, batch, ceiling)
    );
    await inBatches(
      writes.map((change) => change.path),
      (batch) => stagePaths(repoDir, batch, ceiling)
    );
    if (!(await hasStagedChanges(repoDir, ceiling))) return null;
    return await commitStaged(repoDir, subject, identity, ceiling);
  } catch (err) {
    await rollbackChangeSet(repoDir, ceiling, changes, undo);
    throw err;
  }
}

/** What a change set made that did not exist before it — the only things its rollback removes. */
interface ChangeSetUndo {
  /** Folders it created, shallowest first. */
  folders: string[];
  /** Files it created where nothing stood on disk. */
  files: string[];
}

/**
 * Put every path of a change set back the way `main` has it, after a set that
 * could not finish.
 *
 * Best-effort and never throws: the caller is already reporting the reason the
 * change failed, and replacing it with a cleanup error would hide it. A rollback
 * that fails is logged loudly, because what it leaves behind is exactly the
 * dirty-main state the operator will be asked about.
 *
 * **It removes only what this change set created** — files it wrote where
 * nothing stood, and folders it made — never a path merely because the tree did
 * not list it. A path the tree missed can still be somebody's file under another
 * spelling (found in review: an NFD upload over an NFC file, rolled back, deleted
 * the person's tracked file).
 *
 * Created files are removed BEFORE `main`'s paths are restored — on a filesystem
 * that folds case, a case-only rename's new name and its old one are one file,
 * and the other order would delete what was just restored.
 *
 * @param repoDir - The room's main checkout.
 * @param ceiling - The room home directory git's search may not climb past.
 * @param changes - The change set.
 * @param undo - What the set created.
 */
async function rollbackChangeSet(
  repoDir: string,
  ceiling: string,
  changes: readonly RoomFileChange[],
  undo: ChangeSetUndo
): Promise<void> {
  try {
    for (const filePath of undo.files) {
      await fs.rm(path.join(repoDir, filePath), { force: true });
    }
    // The file first, then the index — see {@link unstagePaths} for why that
    // order is what lets this run without a force flag.
    await inBatches(undo.files, (batch) => unstagePaths(repoDir, batch, ceiling));
    await inBatches(
      changes.filter((change) => change.existed).map((change) => change.path),
      (batch) => restoreFromHead(repoDir, batch, ceiling)
    );
    for (const dir of [...undo.folders].reverse()) {
      await fs.rmdir(path.join(repoDir, dir)).catch(() => undefined);
    }
  } catch (err) {
    logger.error('[rooms] a room file change could not be rolled back; its files are now dirty', {
      repoDir,
      paths: changes.map((change) => change.path),
      err,
    });
  }
}

/**
 * Create every missing folder above a file, one at a time, and say which.
 *
 * One `mkdir` per level rather than `recursive: true`, so the list of what was
 * created is exact and a rollback removes those folders and nothing else. A
 * level that exists as something other than a folder — an ignored or untracked
 * file the tree does not know about — answers `ROOM_FILE_PATH_INVALID`.
 *
 * @param repoDir - The room's main checkout.
 * @param filePath - The file whose parents to make.
 * @returns The folders created, repo-relative, shallowest first.
 */
async function makeParents(repoDir: string, filePath: string): Promise<string[]> {
  const created: string[] = [];
  const segments = filePath.split('/').slice(0, -1);
  let rel = '';
  for (const segment of segments) {
    rel = rel === '' ? segment : `${rel}/${segment}`;
    try {
      await fs.mkdir(path.join(repoDir, rel));
      created.push(rel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const stat = await fs.lstat(path.join(repoDir, rel));
      if (!stat.isDirectory()) {
        throw new RoomError(
          'ROOM_FILE_PATH_INVALID',
          `\`${rel}\` is a file in this room’s copy, so it cannot hold other files.`
        );
      }
    }
  }
  return created;
}

/**
 * Remove folders a removal left empty, deepest first, stopping at the first one
 * that still holds something.
 *
 * git does not record folders, so an empty one is invisible to it — but it is
 * still on disk, and a person who deleted `old/` expects `old/` gone.
 *
 * @param repoDir - The room's main checkout.
 * @param filePath - The path that was removed.
 */
async function pruneEmptyParents(repoDir: string, filePath: string): Promise<void> {
  const segments = filePath.split('/').slice(0, -1);
  while (segments.length > 0) {
    try {
      await fs.rmdir(path.join(repoDir, ...segments));
    } catch {
      return;
    }
    segments.pop();
  }
}

/**
 * Write one path's contents, refusing to follow a link at the final component.
 *
 * @param repoDir - The room's main checkout.
 * @param ceiling - The room home directory git's search may not climb past.
 * @param change - The write.
 * @param onCreated - Called once a new path has been created, so a rollback
 *   removes it — and only then.
 */
async function writeContent(
  repoDir: string,
  ceiling: string,
  change: RoomFileChange,
  onCreated: () => void
): Promise<void> {
  // `O_NOFOLLOW` on the final component: the lstat walk cannot close the window
  // between looking and writing, and the kernel can. A path `main` does not hold
  // is created `O_EXCL`: anything already standing there — another spelling of
  // a real file — is refused rather than truncated.
  const flags = change.existed
    ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;
  let handle;
  try {
    handle = await fs.open(
      path.join(repoDir, change.path),
      flags,
      change.executable ? 0o755 : 0o644
    );
  } catch (err) {
    if (!change.existed && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RoomError(
        'ROOM_FILE_EXISTS',
        `This room already has a file at \`${change.path}\` under another spelling. Replace it, or choose another name.`
      );
    }
    throw err;
  }
  if (!change.existed) onCreated();
  try {
    const content = change.content as RoomFileContent;
    if (Buffer.isBuffer(content)) await handle.writeFile(content);
    else if ('file' in content) await handle.writeFile(createReadStream(content.file));
    // One blob in memory at a time, at the moment it is written.
    else await handle.writeFile(await readBlobBytes(repoDir, content.blob, ceiling));
    // `O_CREAT`'s mode only applies to a file that did not exist; a moved file
    // replacing nothing is new, but say it explicitly so the bit is certain.
    if (change.executable) await handle.chmod(0o755);
  } finally {
    await handle.close();
  }
}

/**
 * One blob's bytes, exactly — for carrying a file to a new path.
 *
 * @param repoDir - The room's main checkout.
 * @param sha - The blob.
 * @param ceiling - The room home directory git's search may not climb past.
 */
export function readBlobBytes(repoDir: string, sha: string, ceiling: string): Promise<Buffer> {
  return runGitRaw(['cat-file', 'blob', sha], repoDir, ceiling, {
    // A blob here is at most the room's own file cap, which may be larger than
    // the shared output default.
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * One commit, in the shape a room's file surfaces describe provenance.
 *
 * NUL-separated, because the one free-text field that could hold a separator —
 * the author name — cannot hold a NUL.
 *
 * @param repoDir - The room's main checkout.
 * @param sha - The commit.
 * @param ceiling - The room home directory git's search may not climb past.
 */
export async function describeCommit(
  repoDir: string,
  sha: string,
  ceiling: string
): Promise<RoomFileCommit> {
  const out = (
    await runGitRaw(['log', '-1', '--format=%H%x00%an%x00%aI%x00%s', sha], repoDir, ceiling)
  ).toString('utf-8');
  const [commit = sha, author = '', at = '', subject = ''] = out.replace(/\n$/, '').split('\0');
  return { sha: commit, author, at, subject };
}
