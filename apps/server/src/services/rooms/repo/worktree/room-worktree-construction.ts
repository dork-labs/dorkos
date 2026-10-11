/** Original root-owned Worktree construction operations and complete cleanup order. */
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { logger } from '../../../../lib/logger.js';
import { addWorktree, hasLocalBranch, pruneWorktrees } from '../room-repo-git.js';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { readOriginalRoomWorktreeConstructionView } from '../room-worktree-manager.js';
import type { RoomWorktreeHandle } from './room-worktree-contracts.js';

/**
 * Reuse the working copy, heal it, or make it — the body of one resolution.
 *
 * @param roomId - The room.
 * @param dir - Where the working copy lives.
 * @param slug - Its directory name.
 * @param branch - The branch it checks out.
 */
export async function resolveWorktree(
  engineOwner: object,
  roomId: string,
  dir: string,
  slug: string,
  branch: string,
  context: InstallationRoomMutationContext
): Promise<RoomWorktreeHandle> {
  const facet = readOriginalRoomWorktreeConstructionView(engineOwner);
  if (await facet.isCheckout(dir)) {
    // Handing the path out is the use. See `ensureWorktree`'s docs. Stamped
    // from the same clock the reap's cutoff reads, so the two never disagree
    // about what "now" is.
    await stampOwnedDirectory(engineOwner, dir, context);
    requireInstallationRoomMutationTarget(context, dir);
    return {
      slug,
      path: dir,
      branch,
      created: false,
      repo: readInstallationRoomMutationRoots(context).repoPath,
    };
  }
  if (await facet.directoryExists(dir))
    await setCorpseAside(engineOwner, roomId, dir, slug, context);
  return createWorktree(engineOwner, roomId, dir, slug, branch, context);
}

/** Execute the original private ensure room branch logs operation after root membership. */
export async function ensureRoomBranchLogs(
  engineOwner: object,
  context: InstallationRoomMutationContext
): Promise<void> {
  const facet = readOriginalRoomWorktreeConstructionView(engineOwner);
  const { repoPath } = readInstallationRoomMutationRoots(context);
  await checkInstallationRoomMutationTarget(context, repoPath);
  const repo = await fs.lstat(repoPath),
    canonicalRepo = await fs.realpath(repoPath);
  if (!repo.isDirectory() || repo.isSymbolicLink())
    throw new Error('Room branch logs lost their actual repository.');
  let parentPath = repoPath,
    parent = repo;
  for (const segment of ['.git', 'logs', 'refs', 'heads', 'room']) {
    const directory = path.join(parentPath, segment);
    await checkInstallationRoomMutationTarget(context, directory);
    let previous: Stats | undefined;
    try {
      previous = await fs.lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    if (previous && (!previous.isDirectory() || previous.isSymbolicLink()))
      throw new Error('Room branch log directory is not its actual directory.');
    if (
      !facet.sameWorktreeInode(parent, await fs.lstat(parentPath)) ||
      !facet.sameWorktreeInode(repo, await fs.lstat(repoPath))
    )
      throw new Error('Room branch log parent replaced before acquisition.');
    requireInstallationRoomMutationTarget(context, directory);
    if (!previous) await fs.mkdir(directory);
    const current = await fs.lstat(directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      (previous && !facet.sameWorktreeInode(previous, current)) ||
      (await fs.realpath(directory)) !==
        path.join(canonicalRepo, path.relative(repoPath, directory)) ||
      !facet.sameWorktreeInode(parent, await fs.lstat(parentPath)) ||
      !facet.sameWorktreeInode(repo, await fs.lstat(repoPath))
    )
      throw new Error('Room branch logs refuse a replaced directory/parent.');
    requireInstallationRoomMutationTarget(context, directory);
    parentPath = directory;
    parent = current;
  }
}

/**
 * Move a directory that is not a checkout out of the way, keeping everything
 * in it.
 *
 * An empty one is simply removed. Anything else is renamed rather than
 * deleted: this runs unattended, and "I do not recognize this directory" has
 * never been a reason to destroy its contents anywhere else in this domain.
 *
 * @param roomId - The room, for the log line.
 * @param dir - The directory in the way.
 * @param slug - Its name, for the log line.
 */
export async function setCorpseAside(
  engineOwner: object,
  roomId: string,
  dir: string,
  slug: string,
  context: InstallationRoomMutationContext
): Promise<void> {
  const facet = readOriginalRoomWorktreeConstructionView(engineOwner);
  const parentPath = path.dirname(dir);
  await checkInstallationRoomMutationTarget(context, dir);
  const parent = await fs.lstat(parentPath),
    original = await fs.lstat(dir);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    !original.isDirectory() ||
    original.isSymbolicLink()
  )
    throw new Error('Room worktree repair lost its actual directory.');
  const empty = (await fs.readdir(dir)).length === 0;
  await checkInstallationRoomMutationTarget(context, dir);
  if (
    !facet.sameWorktreeInode(parent, await fs.lstat(parentPath)) ||
    !facet.sameWorktreeInode(original, await fs.lstat(dir))
  )
    throw new Error('Room worktree repair directory replaced.');
  if (empty) {
    requireInstallationRoomMutationTarget(context, dir);
    await fs.rmdir(dir); // only the observed empty directory, never a recursive foreign tree
    await checkInstallationRoomMutationTarget(context, dir);
    return;
  }
  const moved = `${dir}.orphaned-${Date.now()}`;
  await checkInstallationRoomMutationTarget(context, moved);
  requireInstallationRoomMutationTarget(context, moved);
  await fs.mkdir(moved); // reserve destination rather than overwrite somebody else's path
  const reservation = await fs.lstat(moved);
  let failed = false,
    cause: unknown,
    published = false;
  // Join this scope to its captured cleanup before returning or reporting failure.
  const drainOriginalCleanup = async () => {
    if (!published) {
      try {
        if (
          !facet.sameWorktreeInode(parent, await fs.lstat(parentPath)) ||
          !facet.sameWorktreeInode(reservation, await fs.lstat(moved))
        )
          throw new Error('Room worktree cleanup refuses a foreign reservation.');
        // Cleanup of this actual empty reservation only; admitted namespace remains held.
        await fs.rmdir(moved);
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
    }
  };
  try {
    await checkInstallationRoomMutationTarget(context, dir);
    if (
      !reservation.isDirectory() ||
      reservation.isSymbolicLink() ||
      !facet.sameWorktreeInode(parent, await fs.lstat(parentPath)) ||
      !facet.sameWorktreeInode(original, await fs.lstat(dir)) ||
      !facet.sameWorktreeInode(reservation, await fs.lstat(moved))
    )
      throw new Error('Room worktree move lost its original source/reserved destination.');
    requireInstallationRoomMutationTarget(context, dir);
    requireInstallationRoomMutationTarget(context, moved);
    await fs.rename(dir, moved);
    published = true;
    await checkInstallationRoomMutationTarget(context, moved);
    if (
      !facet.sameWorktreeInode(parent, await fs.lstat(parentPath)) ||
      !facet.sameWorktreeInode(original, await fs.lstat(moved))
    )
      throw new Error('Room orphan move readback changed.');
  } catch (error) {
    failed = true;
    cause = error;
  } finally {
    await drainOriginalCleanup();
  }
  if (failed) throw cause;
  logger.warn('[rooms] a room worktree directory was not a checkout; moved it aside', {
    roomId,
    worktree: slug,
    movedTo: moved,
    note: 'nothing was deleted; the sweep will list it as unfinished work',
  });
}

/** Execute the original private stamp owned directory operation after root membership. */
export async function stampOwnedDirectory(
  engineOwner: object,
  dir: string,
  context: InstallationRoomMutationContext
): Promise<void> {
  const facet = readOriginalRoomWorktreeConstructionView(engineOwner);
  const now = new Date(facet.nowMs());
  await checkInstallationRoomMutationTarget(context, dir);
  const original = await fs.lstat(dir);
  if (!original.isDirectory() || original.isSymbolicLink())
    throw new Error('Room worktree stamp requires the actual directory.');
  let file: import('node:fs/promises').FileHandle | undefined;
  let failed = false,
    cause: unknown;
  try {
    requireInstallationRoomMutationTarget(context, dir);
    file = await fs.open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
    const acquired = await file.stat();
    await checkInstallationRoomMutationTarget(context, dir);
    if (
      !acquired.isDirectory() ||
      !facet.sameWorktreeInode(original, acquired) ||
      !facet.sameWorktreeInode(acquired, await fs.lstat(dir))
    )
      throw new Error('Room worktree stamp directory replaced.');
    requireInstallationRoomMutationTarget(context, dir);
    await file.utimes(now, now);
    await checkInstallationRoomMutationTarget(context, dir);
  } catch (error) {
    failed = true;
    cause = error;
  } finally {
    if (file) {
      try {
        await file.close();
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
    }
  }
  if (failed) throw cause;
}

/**
 * Make the worktree, project into it, and report what happened.
 *
 * @param roomId - The room.
 * @param dir - Where the working copy goes.
 * @param slug - Its directory name.
 * @param branch - The branch to check out.
 */
export async function createWorktree(
  engineOwner: object,
  roomId: string,
  dir: string,
  slug: string,
  branch: string,
  context: InstallationRoomMutationContext
): Promise<RoomWorktreeHandle> {
  const facet = readOriginalRoomWorktreeConstructionView(engineOwner);
  const roots = readInstallationRoomMutationRoots(context),
    repoDir = roots.repoPath,
    ceiling = roots.homePath;
  const parentPath = path.join(ceiling, 'worktrees');
  await checkInstallationRoomMutationTarget(context, dir);
  const home = await fs.lstat(ceiling);
  if (!home.isDirectory() || home.isSymbolicLink())
    throw new Error('Room worktree home is not its actual directory.');
  let previousParent: Stats | undefined;
  try {
    previousParent = await fs.lstat(parentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  await checkInstallationRoomMutationTarget(context, dir);
  if (!facet.sameWorktreeInode(home, await fs.lstat(ceiling)))
    throw new Error('Room worktree home replaced before parent acquisition.');
  requireInstallationRoomMutationTarget(context, parentPath);
  if (!previousParent) await fs.mkdir(parentPath);
  const parent = await fs.lstat(parentPath);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (previousParent && !facet.sameWorktreeInode(previousParent, parent))
  )
    throw new Error('Room worktree parent replaced.');

  // The branch may outlive its directory: the reap removes the working copy
  // and `git branch -d` can refuse (or never run, if the process died in
  // between). Probing tells "never had one" from "had one, lost the
  // directory"; catching the failure would make every other failure look the
  // same, which is the bug `hasMainBranch` was split out to avoid.
  const branchExists = await hasLocalBranch(repoDir, branch, ceiling);
  // A worktree that was moved aside leaves git's own record of the path
  // behind, and `worktree add` refuses a path it still believes in.
  try {
    await pruneWorktrees(repoDir, ceiling, context);
  } catch {
    // Nothing to prune, or a repo that cannot be read — `addWorktree` below
    // gives the caller the real error either way.
  }
  await checkInstallationRoomMutationTarget(context, dir);
  if (
    !facet.sameWorktreeInode(home, await fs.lstat(ceiling)) ||
    !facet.sameWorktreeInode(parent, await fs.lstat(parentPath))
  )
    throw new Error('Room worktree creation lost its acquired parent.');
  requireInstallationRoomMutationTarget(context, dir);
  await addWorktree(repoDir, dir, branch, branchExists ? null : 'main', ceiling, context);
  await checkInstallationRoomMutationTarget(context, dir);
  if (
    !facet.sameWorktreeInode(home, await fs.lstat(ceiling)) ||
    !facet.sameWorktreeInode(parent, await fs.lstat(parentPath))
  )
    throw new Error('Room worktree creation parent changed after native child.');
  await stampOwnedDirectory(engineOwner, dir, context);
  // Nothing is written into it: the agent's turns stand at home, where its
  // skills and instructions already are (spec `agent-home-desk` §5.8). A new
  // tree is exactly the room's files on the agent's branch.
  facet.retired.add(dir);
  logger.info('[rooms] room worktree created', { roomId, worktree: slug, branch });
  return { slug, path: dir, branch, created: true, repo: repoDir };
}
