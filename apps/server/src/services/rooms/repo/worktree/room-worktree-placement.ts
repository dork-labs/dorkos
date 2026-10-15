/** Original root-owned Worktree placement operations and complete cleanup order. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../../../../lib/logger.js';
import { RoomError } from '../../data/room-errors.js';
import { aheadBehind } from '../room-repo-git.js';
import { readOriginalRoomRunnerLaunch } from '../../room-turn-runner.js';
import { readOriginalRoomTriggerLaunch } from '../../room-trigger.js';
import type { RoomTurnRequest } from '../../room-turn-port.js';
import { roomTurnGrants, type RoomTurnLaunch, type RoomTurnPlace } from '../room-turn-place.js';
import { readOriginalRoomPlacementFacts } from '../../service/room-core.js';
import {
  withRecognizedInstallationRoomNamespace,
  readInstallationRoomPlacementMutationContext,
  readInstallationRoomLaunchMutationContext,
  readInstallationRoomMutationRoots,
  readInstallationRoomStoreRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { readOwnedRoomRepoSource } from '../room-repo-store.js';
import { readRoomRepoConfig } from '../room-repo-config.js';
import { DocChannelNotFoundError } from '../../../canvas/doc-channel/authorization.js';
import { requireOriginalHttpRoomWorktreeOwner } from '../../../canvas/doc-channel/http-composition.js';
import { resolveWorktree, ensureRoomBranchLogs } from './room-worktree-construction.js';
import {
  readOriginalRoomWorktreeConstructionView,
  RoomWorktreeManager,
  roomWorktreeBranch,
} from '../room-worktree-manager.js';

/** Execute the original private execute placement operation after root membership. */
export async function executePlacement(engineOwner: object, token: object): Promise<RoomTurnPlace> {
  const facet = readOriginalRoomWorktreeConstructionView(engineOwner);
  const owning = facet.owning!;
  requireOriginalHttpRoomWorktreeOwner(
    owning.owner,
    facet.originalManager,
    owning.db,
    owning.rooms
  );
  const facts = readOriginalRoomPlacementFacts(token, owning.db, owning.roomStore);
  if (!facts) throw new DocChannelNotFoundError();
  const enabled = readRoomRepoConfig().enabled;
  const source = readOwnedRoomRepoSource(facet.deps.store, owning.db, facts.roomId);
  if (
    JSON.stringify(readOriginalRoomPlacementFacts(token, owning.db, owning.roomStore)) !==
    JSON.stringify(facts)
  )
    throw new DocChannelNotFoundError();
  if (!enabled || !source.row)
    throw new RoomError('NOT_A_PROJECT_ROOM', 'This room does not have files of its own.');
  return withRecognizedInstallationRoomNamespace(owning.writer, facts.roomId, async (scope) => {
    requireOriginalHttpRoomWorktreeOwner(
      owning.owner,
      facet.originalManager,
      owning.db,
      owning.rooms
    );
    const current = readOriginalRoomPlacementFacts(token, owning.db, owning.roomStore);
    if (!current || JSON.stringify(current) !== JSON.stringify(facts))
      throw new DocChannelNotFoundError();
    const context = readInstallationRoomPlacementMutationContext(
      owning.writer,
      facts.roomId,
      scope,
      token,
      owning.roomStore
    );
    const roots = readInstallationRoomMutationRoots(context);
    try {
      const slug = RoomWorktreeManager.slugFor(current.displayName, current.targetAgentPath),
        branch = roomWorktreeBranch(slug);
      const dir = path.join(roots.homePath, 'worktrees', slug);
      const worktree = await resolveWorktree(engineOwner, facts.roomId, dir, slug, branch, context);
      // This retained turn-placement duty remains inside the same original namespace,
      // rather than reopening an unowned pathname after returning the worktree DTO.
      await ensureRoomBranchLogs(engineOwner, context);
      const place = { worktreePath: worktree.path, branch, repoPath: roots.repoPath };
      let counts: { ahead: number | null; behind: number | null };
      try {
        await checkInstallationRoomMutationTarget(context, roots.repoPath);
        counts = await aheadBehind(roots.repoPath, 'main', branch, roots.homePath);
      } catch (error) {
        // An unavailable observation may omit counts; lost original authority
        // must still refuse, including when the Git observation itself failed.
        await checkInstallationRoomMutationTarget(context, roots.repoPath);
        counts = { ahead: null, behind: null };
        logger.debug('[rooms] could not measure a room worktree against main', {
          roomId: facts.roomId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await checkInstallationRoomMutationTarget(context, worktree.path);
      const storeRoots = readInstallationRoomStoreRoots(context, facet.deps.store, owning.db);
      const homeIdentity = await fs.lstat(roots.homePath),
        canonicalHome = await fs.realpath(roots.homePath);
      await checkInstallationRoomMutationTarget(context, worktree.path);
      if (
        !homeIdentity.isDirectory() ||
        homeIdentity.isSymbolicLink() ||
        canonicalHome !==
          path.join(
            storeRoots.canonicalInstallation,
            path.relative(storeRoots.installation, roots.homePath)
          )
      )
        throw new Error('Room grant home is not its original canonical namespace.');
      const additionalDirectories = roomTurnGrants(
        worktree.path,
        roots.repoPath,
        current.targetAgentPath
      );
      for (const grant of additionalDirectories) {
        const relative = path.relative(canonicalHome, grant.path);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          throw new Error('Room grant resolved outside its original canonical home.');
      }
      await checkInstallationRoomMutationTarget(context, worktree.path);
      if (
        !facet.sameWorktreeInode(homeIdentity, await fs.lstat(roots.homePath)) ||
        (await fs.realpath(roots.homePath)) !== canonicalHome
      )
        throw new Error('Room grant home replaced during projection.');
      // The native filesystem observations above are awaits. Recheck the
      // original request credential and placement before returning grants.
      await checkInstallationRoomMutationTarget(context, worktree.path);
      requireInstallationRoomMutationTarget(context, worktree.path);
      requireInstallationRoomMutationTarget(context, roots.repoPath);
      return {
        cwd: current.targetAgentPath,
        additionalDirectories,
        worktree: worktree.path,
        files: { ...place, ...counts },
      };
    } catch (error) {
      if (error instanceof DocChannelNotFoundError) throw error;
      // Preserve ordinary unavailable-files behavior only while the exact
      // original placement and scope still pass their live guards. Admission,
      // native/currentness, and root failures cannot authorize a fallback.
      await checkInstallationRoomMutationTarget(context, roots.repoPath);
      requireInstallationRoomMutationTarget(context, roots.repoPath);
      logger.warn(
        '[rooms] could not open this agent’s copy of the room’s files; answering without it',
        {
          roomId: facts.roomId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      requireInstallationRoomMutationTarget(context, roots.repoPath);
      return {
        cwd: current.targetAgentPath,
        additionalDirectories: [],
        worktree: null,
        files: null,
      };
    }
  });
}

/** Execute the original private execute launch operation after root membership. */
export async function executeLaunch(
  engineOwner: object,
  request: RoomTurnRequest
): Promise<RoomTurnLaunch> {
  const facet = readOriginalRoomWorktreeConstructionView(engineOwner);
  const owning = facet.owning!;
  requireOriginalHttpRoomWorktreeOwner(
    owning.owner,
    facet.originalManager,
    owning.db,
    owning.rooms
  );
  const launch = readOriginalRoomRunnerLaunch(request),
    input = launch && readOriginalRoomTriggerLaunch(request, launch.runner);
  if (!launch || !input || input.manager !== facet.originalManager)
    throw new DocChannelNotFoundError();
  if (!readOwnedRoomRepoSource(facet.deps.store, owning.db, input.roomId).row)
    throw new RoomError('NOT_A_PROJECT_ROOM', 'This room does not have files of its own.');
  return withRecognizedInstallationRoomNamespace(owning.writer, input.roomId, async (scope) => {
    const context = readInstallationRoomLaunchMutationContext(
      owning.writer,
      input.roomId,
      scope,
      request,
      facet.originalManager,
      owning.rooms,
      owning.roomStore
    );
    const roots = readInstallationRoomMutationRoots(context),
      worktrees = path.join(roots.homePath, 'worktrees');
    if (path.dirname(input.worktree) !== worktrees || input.worktree === worktrees)
      throw new DocChannelNotFoundError();
    await checkInstallationRoomMutationTarget(context, input.worktree);
    const result = await input.run(context, launch.sessionId);
    await checkInstallationRoomMutationTarget(context, input.worktree);
    requireInstallationRoomMutationTarget(context, input.worktree);
    return result;
  });
}
