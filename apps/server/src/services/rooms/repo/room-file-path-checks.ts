import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RoomRepoCaps } from '@dorkos/shared/room-repo';
import { RoomError } from '../data/room-errors.js';
import {
  isIgnored,
  GITLINK_MODE,
  SYMLINK_MODE,
  UnreadablePathError,
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
  | Buffer
  | { file: string; size: number }
  | { blob: string; size: number }
  | { upload: object; size: number };

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
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
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
