import {
  assertWritablePath,
  assertNoLinkOnDisk,
  type RoomFileContent,
  type RoomFileChange,
} from './room-file-path-checks.js';
export {
  contentSize,
  assertWritablePath,
  assertNotIgnored,
  assertText,
  assertNoLinkOnDisk,
  assertFits,
  describeBytes,
  assertOrdinaryFile,
  isExecutable,
} from './room-file-path-checks.js';
export type { RoomFileContent, RoomFileChange } from './room-file-path-checks.js';
import { RoomTreeIndex } from './room-tree-index.js';
export { RoomTreeIndex } from './room-tree-index.js';
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
import { finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { openRoomFileUploadSource } from './room-file-upload-storage.js';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';
import type { RoomFileCommit } from '@dorkos/shared/room-files';
import { logger } from '../../../lib/logger.js';
import { RoomError } from '../data/room-errors.js';
import {
  commitStaged,
  GitUnavailableError,
  hasStagedChanges,
  listTree,
  restoreFromHead,
  readRoomFileBlobRaw,
  readRoomFileCommitRaw,
  stagePaths,
  unstagePaths,
  type GitIdentity,
  type TreeEntry,
} from './room-repo-git.js';

/**
 * `O_NOFOLLOW` where the platform has it, and nothing where it does not.
 *
 * The final component of every write is opened with it, so a symlink that
 * appears between the check and the write is refused by the KERNEL rather than
 * followed. Windows has no such flag and no symlinks without a privilege, so
 * there it is zero and the lstat walk is the whole guard.
 */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

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
  identity: GitIdentity,
  context: InstallationRoomMutationContext
): Promise<string | null> {
  const roots = readInstallationRoomMutationRoots(context);
  if (
    !path.isAbsolute(repoDir) ||
    !path.isAbsolute(ceiling) ||
    path.resolve(repoDir) !== roots.repoPath ||
    path.resolve(ceiling) !== roots.homePath
  ) {
    throw new Error('File change set must use the captured main checkout and home.');
  }
  await checkInstallationRoomMutationTarget(context, repoDir);
  const undo: ChangeSetUndo = { folders: [], files: [] };
  let failed = false;
  let firstCause: unknown;
  let commit: string | null = null;
  try {
    const removals = changes.filter((change) => change.content === null);
    const writes = changes.filter((change) => change.content !== null);
    for (const change of removals) {
      const target = await checkFileMutation(context, repoDir, change.path, true);
      requireInstallationRoomMutationTarget(context, target);
      await fs.rm(target, { force: true });
      await pruneEmptyParents(repoDir, change.path, context);
    }
    for (const change of writes) {
      await makeParents(repoDir, change.path, context, undo.folders);
      await writeContent(repoDir, ceiling, change, () => undo.files.push(change.path), context);
    }
    await inBatches(
      removals.map((change) => change.path),
      (batch) => unstagePaths(repoDir, batch, ceiling, context)
    );
    await inBatches(
      writes.map((change) => change.path),
      (batch) => stagePaths(repoDir, batch, ceiling, context)
    );
    if (await hasStagedChanges(repoDir, ceiling))
      commit = await commitStaged(repoDir, subject, identity, ceiling, context);
  } catch (error) {
    // The boolean distinguishes a thrown undefined from no failure.
    failed = true;
    firstCause = error;
  }
  if (failed) {
    try {
      await rollbackChangeSet(repoDir, ceiling, changes, undo, context);
    } catch (cleanupCause) {
      // Logging is also fallible; neither it nor rollback may replace the primary.
      try {
        logger.error(
          '[rooms] a room file change could not be rolled back; its files are now dirty',
          {
            repoDir,
            paths: changes.map((change) => change.path),
            err: cleanupCause,
          }
        );
      } catch {
        /* Exact primary remains the reported cause. */
      }
    }
    throw firstCause;
  }
  return commit;
}

interface ChangeSetUndo {
  folders: string[];
  files: string[];
}

/** Recheck the original no-link confinement after the asynchronous fixed fence check. */
async function checkFileMutation(
  context: InstallationRoomMutationContext,
  repoDir: string,
  filePath: string,
  allowLinkTarget = false
): Promise<string> {
  assertWritablePath(filePath);
  const target = path.resolve(repoDir, filePath);
  const rel = path.relative(repoDir, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new RoomError('ROOM_FILE_PATH_INVALID', 'That path is outside this room’s copy.');
  }
  await checkInstallationRoomMutationTarget(context, target);
  await assertNoLinkOnDisk(repoDir, filePath, allowLinkTarget);
  return target;
}

/** Attempt every owned rollback obligation, recording the first cleanup failure exactly. */
async function rollbackChangeSet(
  repoDir: string,
  ceiling: string,
  changes: readonly RoomFileChange[],
  undo: ChangeSetUndo,
  context: InstallationRoomMutationContext
): Promise<void> {
  let failed = false;
  let firstCause: unknown;
  const attempt = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstCause = error;
      }
    }
  };
  for (const filePath of undo.files)
    await attempt(async () => {
      const target = await checkFileMutation(context, repoDir, filePath, true);
      requireInstallationRoomMutationTarget(context, target);
      await fs.rm(target, { force: true });
    });
  // Each batch retains this exact context. A failed batch does not skip other obligations.
  for (let at = 0; at < undo.files.length; at += PATH_BATCH) {
    await attempt(() =>
      unstagePaths(repoDir, undo.files.slice(at, at + PATH_BATCH), ceiling, context)
    );
  }
  const restore = changes.filter((change) => change.existed).map((change) => change.path);
  for (let at = 0; at < restore.length; at += PATH_BATCH) {
    await attempt(() =>
      restoreFromHead(repoDir, restore.slice(at, at + PATH_BATCH), ceiling, context)
    );
  }
  for (const dir of [...undo.folders].reverse())
    await attempt(async () => {
      const target = await checkFileMutation(context, repoDir, dir);
      requireInstallationRoomMutationTarget(context, target);
      try {
        await fs.rmdir(target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
      }
    });
  if (failed) throw firstCause;
}

/** Record each successful mkdir immediately, including when a later parent fails. */
async function makeParents(
  repoDir: string,
  filePath: string,
  context: InstallationRoomMutationContext,
  created: string[]
): Promise<void> {
  let rel = '';
  for (const segment of filePath.split('/').slice(0, -1)) {
    rel = rel === '' ? segment : `${rel}/${segment}`;
    const target = await checkFileMutation(context, repoDir, rel);
    requireInstallationRoomMutationTarget(context, target);
    try {
      await fs.mkdir(target);
      created.push(rel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(target);
      if (!stat.isDirectory())
        throw new RoomError(
          'ROOM_FILE_PATH_INVALID',
          `\`${rel}\` is a file in this room’s copy, so it cannot hold other files.`
        );
    }
  }
}

async function pruneEmptyParents(
  repoDir: string,
  filePath: string,
  context: InstallationRoomMutationContext
): Promise<void> {
  const segments = filePath.split('/').slice(0, -1);
  while (segments.length > 0) {
    const target = await checkFileMutation(context, repoDir, segments.join('/'));
    requireInstallationRoomMutationTarget(context, target);
    try {
      await fs.rmdir(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') return;
      throw error;
    }
    segments.pop();
  }
}

/** Own the target FD and any staged-input stream until both have actually closed. */
async function writeContent(
  repoDir: string,
  ceiling: string,
  change: RoomFileChange,
  onCreated: () => void,
  context: InstallationRoomMutationContext
): Promise<void> {
  const flags = change.existed
    ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;
  const mode = change.executable ? 0o755 : 0o644;
  const target = await checkFileMutation(context, repoDir, change.path);
  let handle;
  requireInstallationRoomMutationTarget(context, target);
  try {
    handle = await fs.open(target, flags, mode);
  } catch (error) {
    if (!change.existed && (error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new RoomError(
        'ROOM_FILE_EXISTS',
        `This room already has a file at \`${change.path}\` under another spelling. Replace it, or choose another name.`
      );
    }
    throw error;
  }
  let failed = false;
  let firstCause: unknown;
  let stream: Readable | undefined;
  let streamSettled: Promise<{ failed: boolean; cause?: unknown }> | undefined;
  try {
    if (!change.existed) onCreated();
    const content = change.content as RoomFileContent;
    const bytes = Buffer.isBuffer(content)
      ? content
      : 'blob' in content
        ? await readBlobBytes(repoDir, content.blob, ceiling)
        : undefined;
    // Opening the staged input is also owned until its actual close; it is not a mutation of the room.
    if (!Buffer.isBuffer(content) && ('file' in content || 'upload' in content)) {
      stream =
        'upload' in content
          ? await openRoomFileUploadSource(content.upload, context, content.size)
          : createReadStream(content.file);
      streamSettled = finished(stream).then(
        () => ({ failed: false }),
        (cause: unknown) => ({ failed: true, cause })
      );
    }
    await checkFileMutation(context, repoDir, change.path);
    requireInstallationRoomMutationTarget(context, target);
    await handle.writeFile(stream ?? bytes!);
    if (change.executable) {
      await checkFileMutation(context, repoDir, change.path);
      requireInstallationRoomMutationTarget(context, target);
      await handle.chmod(0o755);
    }
  } catch (error) {
    failed = true;
    firstCause = error;
  } finally {
    if (stream && streamSettled) {
      try {
        stream.destroy();
        const result = await streamSettled;
        if (result.failed && !failed) {
          failed = true;
          firstCause = result.cause;
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          firstCause = error;
        }
      }
    }
    // A failed/retired fence must never leak a descriptor; closing is unconditional owned cleanup.
    try {
      await handle.close();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstCause = error;
      }
    }
  }
  if (failed) throw firstCause;
}

/** One finite blob read, preserving raw bytes and the original file-reader output bound. */
export function readBlobBytes(repoDir: string, sha: string, ceiling: string): Promise<Buffer> {
  return readRoomFileBlobRaw(repoDir, sha, ceiling);
}

/** One finite provenance read; no unowned arbitrary command escapes this module. */
export async function describeCommit(
  repoDir: string,
  sha: string,
  ceiling: string
): Promise<RoomFileCommit> {
  const out = (await readRoomFileCommitRaw(repoDir, sha, ceiling)).toString('utf-8');
  const [commit = sha, author = '', at = '', subject = ''] = out.replace(/\n$/, '').split('\0');
  return { sha: commit, author, at, subject };
}
