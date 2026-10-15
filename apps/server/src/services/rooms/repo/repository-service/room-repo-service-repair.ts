/** Original root-owned repo repair operations and complete failure order. */
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import type { Room } from '@dorkos/shared/room-schemas';
import { RoomError } from '../../data/room-errors.js';
import { logger } from '../../../../lib/logger.js';
import {
  commitAll,
  gitAuthorName,
  GitUnavailableError,
  OPERATOR_GIT_EMAIL,
  pathsInHead,
  restoreFromHead,
  unstagePaths,
  type StrayChange,
} from '../room-repo-git.js';
import { readMainCheckoutState } from '../room-main-checkout.js';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { readOriginalRoomRepoServiceView } from '../room-repo-service.js';
import type { RoomMainRepair } from '../room-repo-service.js';
import type { RoomMainRepairResult } from '../room-repo-service.js';
import type { RepairAction } from '../room-repo-service.js';

/**
 * The git half of {@link RoomRepoService.repairMainCheckout}, run while
 * holding the room's queue.
 *
 * Everything it does can be changed by a merge or a save running ahead of it,
 * which is exactly why it is in here and the authorization is not.
 *
 * @param roomId - The room.
 * @param repair - What the operator asked for.
 * @returns What it did.
 */
export async function repairUnderLock(
  engineOwner: object,
  roomId: string,
  repair: RoomMainRepair,
  context: InstallationRoomMutationContext
): Promise<RoomMainRepairResult> {
  const facet = readOriginalRoomRepoServiceView(engineOwner);
  const { repoPath: repoDir, homePath: ceiling } = readInstallationRoomMutationRoots(context);
  try {
    await checkInstallationRoomMutationTarget(context, repoDir);
    const state = await readMainCheckoutState(repoDir, ceiling);
    await checkInstallationRoomMutationTarget(context, repoDir);
    if (state.branch !== 'main') {
      throw new RoomError(
        'MAIN_CHECKOUT_DIRTY',
        `This room’s files are on ${state.branch ?? 'no branch'} rather than main, which only something outside DorkOS can have done. Put them back on main yourself — DorkOS will not move a branch it did not move, in case there is work on it.`
      );
    }

    const result =
      repair.action === 'commit'
        ? await facet.keepStrayChanges(repoDir, ceiling, state.strays.length, context)
        : await facet.discardStrayChanges(repoDir, ceiling, state.strays, repair.paths, context);

    const after = await readMainCheckoutState(repoDir, ceiling);
    await checkInstallationRoomMutationTarget(context, repoDir);
    requireInstallationRoomMutationTarget(context, repoDir);
    logger.info('[rooms] a room’s stray file changes were dealt with', {
      roomId,
      action: repair.action,
      paths: result.paths,
    });
    facet.requireEnabled();
    requireInstallationRoomMutationTarget(context, repoDir);
    return { ...result, clean: after.strays.length === 0 };
  } catch (err) {
    if (err instanceof GitUnavailableError) {
      throw new RoomError(
        'ROOM_REPO_GIT_UNAVAILABLE',
        'This computer doesn’t have git installed, and a room’s files are a git repository. Install git, then try again.'
      );
    }
    throw err;
  }
}

/**
 * Commit whatever is in the room's own copy, as the operator.
 *
 * `commitAll` rather than a named list: this is the "keep it" answer, and
 * keeping half of what is there would leave the room stuck for the other
 * half.
 *
 * @param repoDir - The room's main checkout.
 * @param ceiling - The room home directory git's search may not climb past.
 * @param strayCount - How many paths were waiting, for the answer.
 * @returns What was committed.
 */
export async function keepStrayChanges(
  engineOwner: object,
  repoDir: string,
  ceiling: string,
  strayCount: number,
  context: InstallationRoomMutationContext
): Promise<RepairAction> {
  const facet = readOriginalRoomRepoServiceView(engineOwner);
  if (strayCount === 0) return { action: 'commit', commit: null, paths: 0 };
  const commit = await commitAll(
    repoDir,
    facet.strayChangesCommitMessage,
    {
      name: gitAuthorName(facet.deps.operatorGitName()),
      email: OPERATOR_GIT_EMAIL,
    },
    ceiling,
    context
  );
  return { action: 'commit', commit, paths: strayCount };
}

/**
 * Throw away exactly the named changes, and nothing else.
 *
 * Every path has to be one the room is reporting as changed RIGHT NOW,
 * compared byte for byte against git's own output — no normalising, no case
 * folding, no prefix matching. That single rule is what makes this narrow: a
 * path the caller invented, a path that has since been committed, and a path
 * from a screen drawn ten minutes ago are all refused rather than acted on.
 *
 * Then two ways to undo, chosen per path by whether `HEAD` has it: restore it
 * from the commit, or take it out of the index and delete the file. `git
 * clean` is deliberately not used — its whole reputation is for removing more
 * than it was asked to.
 *
 * **A rename is one change with two paths, and undoing it needs both.**
 * `git mv notes.md renamed.md` is reported as one stray — `renamed.md`, which
 * `HEAD` does not hold — so the removal half alone deleted `renamed.md` and
 * left `notes.md` still missing: the file was gone from the room, and the room
 * was still stuck. So a discarded rename also restores the name it came from
 * ({@link StrayChange.renamedFrom}), which is the only reading of "undo" that
 * ends with the room where it started.
 *
 * @param repoDir - The room's main checkout.
 * @param ceiling - The room home directory git's search may not climb past.
 * @param strays - What the room is reporting as changed.
 * @param paths - What the operator named.
 * @returns How many paths were discarded — the paths the operator named, not
 *   the files that were touched putting them back.
 * @throws {RoomError} `ROOM_FILE_NOT_FOUND` naming the first path that is not
 *   one of the reported changes.
 */
export async function discardStrayChanges(
  engineOwner: object,
  repoDir: string,
  ceiling: string,
  strays: readonly StrayChange[],
  paths: readonly string[],
  context: InstallationRoomMutationContext
): Promise<RepairAction> {
  const facet = readOriginalRoomRepoServiceView(engineOwner);
  const reported = new Map(strays.map((stray) => [stray.path, stray]));
  for (const filePath of paths) {
    if (!reported.has(filePath)) {
      throw new RoomError(
        'ROOM_FILE_NOT_FOUND',
        `\`${filePath}\` is not one of the changes waiting in this room’s files. Look again — it may already have been dealt with.`
      );
    }
  }

  const wanted = [...new Set(paths)];
  // The name a rename came FROM is restored with it. It was never offered as
  // a stray of its own (it is not there to discard), and it is not counted as
  // one either — the answer says how many changes the operator named.
  const alsoRestore = wanted
    .map((filePath) => reported.get(filePath)?.renamedFrom)
    .filter((from): from is string => from !== undefined);
  const inHead = await pathsInHead(repoDir, [...wanted, ...alsoRestore], ceiling);
  const restore = [...new Set([...wanted, ...alsoRestore])].filter((filePath) =>
    inHead.has(filePath)
  );
  const remove = wanted.filter((filePath) => !inHead.has(filePath));

  await restoreFromHead(repoDir, restore, ceiling, context);
  if (remove.length > 0) {
    // The files first, then the index — see {@link unstagePaths} for why that
    // order is what lets this run without a force flag.
    for (const filePath of remove) {
      const target = path.join(repoDir, filePath);
      // Git's own output cannot climb out of the repo, and this is the line
      // that says so rather than assuming it. `fs.rm` does not follow a
      // symlink, so a link named here is unlinked and never followed.
      if (target !== repoDir && !target.startsWith(`${repoDir}${path.sep}`)) continue;
      await checkInstallationRoomMutationTarget(context, target);
      let acquired: Stats | undefined;
      try {
        acquired = await fs.lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      if (!acquired) continue;
      // An observed directory is never recursive file-removal custody.
      if (acquired.isDirectory())
        throw new RoomError(
          'ROOM_FILE_NOT_FOUND',
          'That change is a directory, not a file to discard.'
        );
      const parentPath = path.dirname(target),
        parent = await fs.lstat(parentPath);
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error('Room discard parent is not its actual directory.');
      await checkInstallationRoomMutationTarget(context, target);
      if (
        !facet.sameRepoInode(acquired, await fs.lstat(target)) ||
        !facet.sameRepoInode(parent, await fs.lstat(parentPath))
      )
        throw new Error('Room discard refuses a replaced file/parent.');
      requireInstallationRoomMutationTarget(context, target);
      await fs.unlink(target);
      await checkInstallationRoomMutationTarget(context, repoDir);
    }
    await unstagePaths(repoDir, remove, ceiling, context);
  }
  return { action: 'discard', commit: null, paths: wanted.length };
}
