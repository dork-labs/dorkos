/** Original root-owned repo enable operations and complete failure order. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Room } from '@dorkos/shared/room-schemas';
import { type RoomRepoSidecar } from '@dorkos/shared/room-repo';
import { RoomError } from '../../data/room-errors.js';
import { logger } from '../../../../lib/logger.js';
import {
  readOwnedRoomRepoSource,
  executeOriginalRoomRepoStoreRead,
  executeOriginalRoomRepoStoreWrite,
  executeOriginalRoomRepoStoreUpsert,
} from '../room-repo-store.js';
import { GitUnavailableError } from '../room-repo-git.js';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { DocChannelNotFoundError } from '../../../canvas/doc-channel/authorization.js';
import { readOriginalRoomRepoServiceView } from '../room-repo-service.js';
import type { EnableRoomRepoResult } from '../room-repo-service.js';

/**
 * The body of {@link RoomRepoService.enable}, run while holding the room's
 * queue.
 *
 * @param roomId - The room to give files to.
 * @param callerAuthorId - Who is asking.
 * @returns The binding, and whether this call is what made it.
 */
export async function enableUnderLock(
  engineOwner: object,
  roomId: string,
  callerAuthorId: string,
  context: InstallationRoomMutationContext
): Promise<EnableRoomRepoResult> {
  const facet = readOriginalRoomRepoServiceView(engineOwner);
  if (!facet.deps.enabled()) {
    throw new RoomError(
      'ROOM_REPOS_DISABLED',
      'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
    );
  }

  const room = facet.deps.getRoom(roomId, callerAuthorId);
  if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No such room');

  if (!facet.deps.isOwnerAuthor(callerAuthorId)) {
    throw new RoomError('OPERATOR_ONLY', 'Only you can give a room files of its own');
  }

  const existing = await executeOriginalRoomRepoStoreRead(
    facet.deps.store,
    facet.owning!.db,
    context,
    roomId
  );
  if (existing) {
    // Write the row back through on the way out: the one case where a caller
    // is looking straight at a binding whose cache row may have been lost.
    executeOriginalRoomRepoStoreUpsert(facet.deps.store, facet.owning!.db, context, existing);
    // **A binding without a repo heals here rather than sticking.** The write
    // order is sidecar-then-git, so a process killed between them leaves a
    // room that reports having files and has none — and answering
    // `created: false` forever would make that permanent, with no path back
    // except deleting the sidecar by hand. Falling through to seed finishes
    // the enable the interrupted call started.
    if (await facet.repoIsInitialised(roomId, context)) {
      requireInstallationRoomMutationTarget(
        context,
        readInstallationRoomMutationRoots(context).repoPath
      );
      facet.requireEnabled();
      requireInstallationRoomMutationTarget(
        context,
        readInstallationRoomMutationRoots(context).repoPath
      );
      return { created: false, repo: existing };
    }
    logger.warn('[rooms] a room repo binding has no repo behind it; finishing the setup', {
      roomId,
    });
    await facet.seedGuarded(roomId, room, callerAuthorId, context);
    await checkInstallationRoomMutationTarget(
      context,
      readInstallationRoomMutationRoots(context).repoPath
    );
    facet.requireEnabled();
    requireInstallationRoomMutationTarget(
      context,
      readInstallationRoomMutationRoots(context).repoPath
    );
    return { created: true, repo: existing };
  }

  const sidecar: RoomRepoSidecar = {
    roomId,
    mode: 'owned',
    createdAt: new Date().toISOString(),
    createdBy: callerAuthorId,
    defaultBranch: 'main',
    caps: facet.deps.caps(),
    lastMergeSeq: null,
  };

  // The same acquired cleanup boundary includes sidecar publication/cache write,
  // not only Git seeding. It remains inside the still-admitted private operation.
  await facet.seedGuarded(roomId, room, callerAuthorId, context, sidecar);
  await checkInstallationRoomMutationTarget(
    context,
    readInstallationRoomMutationRoots(context).repoPath
  );
  facet.requireEnabled();
  requireInstallationRoomMutationTarget(
    context,
    readInstallationRoomMutationRoots(context).repoPath
  );
  return { created: true, repo: sidecar };
}

/**
 * Seed the repo, and unwind the binding if that fails.
 *
 * Split out because both {@link RoomRepoService.enable} branches need it —
 * the fresh one and the one healing a binding whose repo never got made — and
 * a second copy of "unwind on failure" is a second chance to forget it.
 *
 * @param roomId - The room.
 * @param room - Its title and topic, for the seeded file.
 * @param callerAuthorId - Who asked.
 * @throws {RoomError} `ROOM_REPO_GIT_UNAVAILABLE` when this machine has no
 *   git, and otherwise whatever git failed with.
 */
export async function seedGuarded(
  engineOwner: object,
  roomId: string,
  room: Room,
  callerAuthorId: string,
  context: InstallationRoomMutationContext,
  publish?: RoomRepoSidecar
): Promise<void> {
  const facet = readOriginalRoomRepoServiceView(engineOwner);
  try {
    if (publish)
      await executeOriginalRoomRepoStoreWrite(facet.deps.store, facet.owning!.db, context, publish);
    await facet.seedRepo(roomId, room, callerAuthorId, context);
  } catch (err) {
    // Attempt all acquired cleanup while preserving the first body failure, including undefined.
    try {
      await facet.unwindFailedEnable(roomId, context);
    } catch {
      /* original failure remains first */
    }
    if (err instanceof GitUnavailableError) {
      throw new RoomError(
        'ROOM_REPO_GIT_UNAVAILABLE',
        'This computer doesn’t have git installed, and a room’s files are a git repository. Install git, then try again.'
      );
    }
    throw err;
  }
  // **Outside the unwind, and guarded on its own.** The repo exists and the
  // seed commit is made; a canvas that refused the tab is a missing tab, not a
  // reason to tear a working repo back down. So this can never reach the
  // `catch` above, and it can never fail the enable either.
  try {
    requireInstallationRoomMutationTarget(
      context,
      readInstallationRoomMutationRoots(context).repoPath
    );
    facet.deps.pinRoomMd(roomId, callerAuthorId);
  } catch (err) {
    logger.warn('[rooms] a new room’s notes did not reach its canvas', {
      roomId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Whether the repo behind a binding actually exists.
 *
 * Asks for `.git` rather than running a git command: this runs on the enable
 * path, the answer is a yes/no about a directory, and spawning a process to
 * learn it would put a process spawn in front of every repeat call.
 *
 * @param roomId - The room.
 */
export async function repoIsInitialised(
  engineOwner: object,
  roomId: string,
  context?: InstallationRoomMutationContext
): Promise<boolean> {
  const facet = readOriginalRoomRepoServiceView(engineOwner);
  const owning = facet.owning;
  if (!owning) throw new DocChannelNotFoundError();
  const source = readOwnedRoomRepoSource(facet.deps.store, owning.db, roomId);
  const repo = context ? readInstallationRoomMutationRoots(context).repoPath : source.repo;
  if (repo !== source.repo) throw new DocChannelNotFoundError();
  const target = path.join(repo, '.git');
  if (context) await checkInstallationRoomMutationTarget(context, target);
  let present = false;
  try {
    await fs.lstat(target);
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  const current = readOwnedRoomRepoSource(facet.deps.store, owning.db, roomId);
  if (
    current.repo !== source.repo ||
    current.root !== source.root ||
    JSON.stringify(current.row) !== JSON.stringify(source.row)
  )
    throw new DocChannelNotFoundError();
  if (context) await checkInstallationRoomMutationTarget(context, target);
  return present;
}
