/** Original root-owned repo seed operations and complete failure order. */
import { randomUUID } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Room } from '@dorkos/shared/room-schemas';
import { logger } from '../../../../lib/logger.js';
import { rollbackOriginalRoomRepoStoreWrite } from '../room-repo-store.js';
import { commitAll, gitAuthorName, initRepo, OPERATOR_GIT_EMAIL } from '../room-repo-git.js';
import { ROOM_MD_FILENAME, ROOM_MD_SEED_COMMIT_MESSAGE, seedRoomMd } from '../room-md.js';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import {
  readOriginalRoomRepoServiceView,
  readOriginalRoomRepoCleanupOperation,
} from '../room-repo-service.js';

/**
 * Create the repo and put `ROOM.md` in it, committed as the operator.
 *
 * @param roomId - The room.
 * @param room - Its title and topic, for the seeded file.
 * @param callerAuthorId - Who asked, for the commit author fallback.
 */
export async function seedRepo(
  engineOwner: object,
  roomId: string,
  room: Room,
  callerAuthorId: string,
  context: InstallationRoomMutationContext
): Promise<void> {
  const facet = readOriginalRoomRepoServiceView(engineOwner);
  const roots = readInstallationRoomMutationRoots(context),
    repoDir = roots.repoPath,
    ceiling = roots.homePath;
  const seed = seedRoomMd({ title: room.title, topic: room.topic });
  const gitAuthor = {
    name: gitAuthorName(facet.deps.operatorGitName()),
    email: OPERATOR_GIT_EMAIL,
  };
  await checkInstallationRoomMutationTarget(context, repoDir);
  const home = await fs.lstat(ceiling);
  if (!home.isDirectory() || home.isSymbolicLink())
    throw new Error('Room seed home is not its actual directory.');
  let previousRepo: Stats | undefined;
  try {
    previousRepo = await fs.lstat(repoDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  await checkInstallationRoomMutationTarget(context, repoDir);
  if (!facet.sameRepoInode(home, await fs.lstat(ceiling)))
    throw new Error('Room seed home replaced before acquisition.');
  requireInstallationRoomMutationTarget(context, repoDir);
  if (!previousRepo) await fs.mkdir(repoDir);
  const repo = await fs.lstat(repoDir);
  if (
    !repo.isDirectory() ||
    repo.isSymbolicLink() ||
    (previousRepo && !facet.sameRepoInode(previousRepo, repo))
  )
    throw new Error('Room seed repository replaced before acquisition.');
  if (!previousRepo)
    facet.acquiredSeedRepos.set(context, {
      roomId,
      home: ceiling,
      homeStat: home,
      repo: repoDir,
      repoStat: repo,
    });
  await checkInstallationRoomMutationTarget(context, repoDir);
  await initRepo(repoDir, ceiling, context);
  await checkInstallationRoomMutationTarget(context, repoDir);
  if (
    !facet.sameRepoInode(home, await fs.lstat(ceiling)) ||
    !facet.sameRepoInode(repo, await fs.lstat(repoDir))
  )
    throw new Error('Room seed repository replaced during native initialization.');
  const target = path.join(repoDir, ROOM_MD_FILENAME),
    tmp = path.join(repoDir, `.${randomUUID()}.seed.tmp`);
  let previousTarget: Stats | undefined;
  try {
    previousTarget = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  if (previousTarget && (!previousTarget.isFile() || previousTarget.isSymbolicLink()))
    throw new Error('Room seed destination is not its regular file.');
  let handle: FileHandle | undefined, acquired: Stats | undefined;
  let failed = false,
    cause: unknown;
  // Join this scope to its captured cleanup before returning or reporting failure.
  const drainOriginalCleanup = async () => {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
    }
    if (acquired) {
      try {
        let current: Stats | undefined;
        try {
          current = await fs.lstat(tmp);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
        if (current) {
          if (
            !facet.sameRepoInode(acquired, current) ||
            !facet.sameRepoInode(repo, await fs.lstat(repoDir)) ||
            !facet.sameRepoInode(home, await fs.lstat(ceiling))
          )
            throw new Error('Room seed cleanup refuses a foreign file/parent.');
          if (!readOriginalRoomRepoCleanupOperation(context, facet.deps.store, facet.owning!.db))
            throw new Error('Room seed cleanup is retired.');
          await fs.unlink(tmp);
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
    }
  };
  try {
    await checkInstallationRoomMutationTarget(context, tmp);
    if (
      !facet.sameRepoInode(home, await fs.lstat(ceiling)) ||
      !facet.sameRepoInode(repo, await fs.lstat(repoDir))
    )
      throw new Error('Room seed acquisition lost its parent.');
    requireInstallationRoomMutationTarget(context, tmp);
    handle = await fs.open(
      tmp,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600
    );
    acquired = await handle.stat();
    if (!acquired.isFile()) throw new Error('Room seed acquisition is not a regular file.');
    await checkInstallationRoomMutationTarget(context, tmp);
    await handle.writeFile(seed, 'utf8');
    await checkInstallationRoomMutationTarget(context, tmp);
    await handle.sync();
    await checkInstallationRoomMutationTarget(context, target);
    let currentTarget: Stats | undefined;
    try {
      currentTarget = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    if (
      (previousTarget === undefined) !== (currentTarget === undefined) ||
      (previousTarget &&
        currentTarget &&
        (!currentTarget.isFile() ||
          currentTarget.isSymbolicLink() ||
          !facet.sameRepoInode(previousTarget, currentTarget)))
    )
      throw new Error('Room seed destination replaced before publication.');
    if (
      !facet.sameRepoInode(acquired, await handle.stat()) ||
      !facet.sameRepoInode(acquired, await fs.lstat(tmp)) ||
      !facet.sameRepoInode(repo, await fs.lstat(repoDir)) ||
      !facet.sameRepoInode(home, await fs.lstat(ceiling))
    )
      throw new Error('Room seed publication lost its acquired file/parent.');
    requireInstallationRoomMutationTarget(context, target);
    await fs.rename(tmp, target);
    await checkInstallationRoomMutationTarget(context, target);
    if (
      !facet.sameRepoInode(acquired, await fs.lstat(target)) ||
      !facet.sameRepoInode(repo, await fs.lstat(repoDir))
    )
      throw new Error('Room seed readback lost its acquired publication.');
  } catch (error) {
    failed = true;
    cause = error;
  } finally {
    await drainOriginalCleanup();
  }
  if (failed) throw cause;
  await checkInstallationRoomMutationTarget(context, repoDir);
  if (
    !facet.sameRepoInode(home, await fs.lstat(ceiling)) ||
    !facet.sameRepoInode(repo, await fs.lstat(repoDir))
  )
    throw new Error('Room seed commit lost its acquired parent.');
  requireInstallationRoomMutationTarget(context, repoDir);
  await commitAll(repoDir, ROOM_MD_SEED_COMMIT_MESSAGE, gitAuthor, ceiling, context);
  await checkInstallationRoomMutationTarget(context, repoDir);
  facet.acquiredSeedRepos.delete(context);
  logger.info('[rooms] room repo created', { roomId, createdBy: callerAuthorId });
}

/**
 * Undo a half-made enable: **the binding first, then the directory**.
 *
 * That order is the whole point, and it is the reverse of what reads
 * naturally. The binding is what every other path believes — `hasRepo`, the
 * next `enable`, the reconciler — so retracting it is the step that must not
 * be skipped. Deleting `repo/` first meant a failing `fs.rm` (a file locked by
 * another process, a permission the server has lost) threw out of the shared
 * `try` and left the sidecar standing: a room advertising files it does not
 * have, permanently.
 *
 * Both cleanup duties are attempted. The caller preserves its first seed failure,
 * including undefined. Only an actually acquired sidecar is retracted; a newly
 * acquired partial repository is quarantined with its bytes retained. An observed
 * existing directory never becomes recursive deletion custody.
 *
 * @param roomId - The room whose enable failed.
 */
export async function unwindFailedEnable(
  engineOwner: object,
  roomId: string,
  context: InstallationRoomMutationContext
): Promise<void> {
  const facet = readOriginalRoomRepoServiceView(engineOwner);
  let failed = false,
    cause: unknown;
  try {
    await rollbackOriginalRoomRepoStoreWrite(facet.deps.store, facet.owning!.db, context);
  } catch (error) {
    failed = true;
    cause = error;
  }
  const acquired = facet.acquiredSeedRepos.get(context);
  if (acquired) {
    // Preserve a partial native repository as a quarantine. Recursive pathname deletion
    // cannot prove ownership of every child written by Git or an external process.
    const quarantine = `${acquired.repo}.failed-${randomUUID()}`;
    let reservation: Stats | undefined,
      published = false;
    // Join this scope to its captured cleanup before returning or reporting failure.
    const drainOriginalCleanup = async () => {
      if (reservation && !published) {
        try {
          if (
            !facet.sameRepoInode(acquired.homeStat, await fs.lstat(acquired.home)) ||
            !facet.sameRepoInode(reservation, await fs.lstat(quarantine))
          )
            throw new Error('Room seed reservation cleanup refuses a foreign directory/parent.');
          if (!readOriginalRoomRepoCleanupOperation(context, facet.deps.store, facet.owning!.db))
            throw new Error('Room seed cleanup is retired.');
          await fs.rmdir(quarantine);
        } catch (error) {
          if (!failed) {
            failed = true;
            cause = error;
          }
        }
      }
    };
    try {
      if (
        !readOriginalRoomRepoCleanupOperation(context, facet.deps.store, facet.owning!.db) ||
        acquired.roomId !== roomId
      )
        throw new Error('Room seed cleanup is foreign or retired.');
      if (
        !facet.sameRepoInode(acquired.homeStat, await fs.lstat(acquired.home)) ||
        !facet.sameRepoInode(acquired.repoStat, await fs.lstat(acquired.repo))
      )
        throw new Error('Room seed cleanup refuses a foreign repository/parent.');
      await fs.mkdir(quarantine);
      reservation = await fs.lstat(quarantine);
      if (!reservation.isDirectory() || reservation.isSymbolicLink())
        throw new Error('Room seed quarantine is not its acquired reservation.');
      if (
        !facet.sameRepoInode(acquired.homeStat, await fs.lstat(acquired.home)) ||
        !facet.sameRepoInode(acquired.repoStat, await fs.lstat(acquired.repo)) ||
        !facet.sameRepoInode(reservation, await fs.lstat(quarantine))
      )
        throw new Error('Room seed quarantine refuses observed replacement.');
      if (!readOriginalRoomRepoCleanupOperation(context, facet.deps.store, facet.owning!.db))
        throw new Error('Room seed cleanup retired before quarantine.');
      await fs.rename(acquired.repo, quarantine);
      published = true;
      if (!facet.sameRepoInode(acquired.repoStat, await fs.lstat(quarantine)))
        throw new Error('Room seed quarantine lost its acquired repository.');
    } catch (error) {
      if (!failed) {
        failed = true;
        cause = error;
      }
    } finally {
      await drainOriginalCleanup();
    }
    facet.acquiredSeedRepos.delete(context);
  }
  if (failed) throw cause;
}
