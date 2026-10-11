/** Original constructor-private Room repository status family. */
import { readOriginalRoomMergeStatusView } from '../room-merge-service.js';
import path from 'node:path';
import type { Room } from '@dorkos/shared/room-schemas';
import type {
  RoomRepoStatus,
  RoomMainStatus,
  RoomBranchStatus,
  RoomRepoCaps,
} from '@dorkos/shared/room-repo';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { logger } from '../../../../lib/logger.js';
import { readMainCheckoutState, type RoomMainCheckoutState } from '../room-main-checkout.js';
import {
  revParse,
  headCommittedAt,
  listTree,
  hasLocalBranch,
  aheadBehind,
  hasUncommittedChanges,
} from '../room-repo-git.js';
import { RoomWorktreeManager, roomWorktreeBranch } from '../room-worktree-manager.js';
import type { RoomMergeServiceDeps } from '../room-merge-service.js';
import type { InstallationRoomMutationContext } from '../../../canvas/doc-channel/writes/installation-room-writes.js';
/** Fixed constructor-private Room merge status dependencies. */
export interface OriginalRoomMergeStatusView {
  readonly deps: Readonly<RoomMergeServiceDeps>;
  readonly statusCache: Map<string, { mainCommit: string; at: number; status: RoomRepoStatus }>;
  readonly STATUS_CACHE_MS: number;
  readonly MAX_REPORTED_STRAYS: number;
  readonly directoryExists: (dir: string) => Promise<boolean>;
  readonly requireProjectRoom: (roomId: string, callerAuthorId: string) => Room;
  readonly requireCaps: (
    roomId: string,
    context?: InstallationRoomMutationContext
  ) => Promise<RoomRepoCaps>;
}
/** External factories have unrelated keys; only original constructor registration supplies the actual fixed view. */
export function createIsolatedRoomMergeStatus() {
  const views = new WeakMap<object, OriginalRoomMergeStatusView>();
  const get = WeakMap.prototype.get;
  const set = WeakMap.prototype.set;
  const apply = Reflect.apply;
  function actual(owner: object): OriginalRoomMergeStatusView {
    const view = apply(get, views, [owner]) as OriginalRoomMergeStatusView | undefined;
    if (!view) throw new Error('Unknown original Room merge status owner.');
    return view;
  }
  return Object.freeze({
    register: (owner: object, view: OriginalRoomMergeStatusView) =>
      apply(set, views, [owner, view]),
    read: actual,
  });
}

/**
 * What a room's files hold right now — the read half of §3.6.
 *
 * Deliberately outside the merge queue. Every question it asks is a read, and
 * a status call that queued behind a merge would be slowest exactly when a
 * person most wants to know what is happening. The answer may therefore be one
 * merge out of date, which is what a status always is.
 *
 * @param roomId - The room.
 * @param callerAuthorId - Who is asking; must be on the roster.
 * @returns The main tip, one row per agent branch, the stranded list and the
 *   size against the caps.
 * @throws {RoomError} `ROOM_NOT_FOUND`, `ROOM_REPOS_DISABLED`,
 *   `NOT_A_PROJECT_ROOM`.
 */
export async function status(
  owner: object,
  roomId: string,
  callerAuthorId: string
): Promise<RoomRepoStatus> {
  const facet = readOriginalRoomMergeStatusView(owner);
  facet.requireProjectRoom(roomId, callerAuthorId);
  const repoDir = facet.deps.store.repoPath(roomId);
  const ceiling = facet.deps.store.homeDir(roomId);

  // One cheap read decides whether the expensive ones have to happen at all.
  const mainCommit = await revParse(repoDir, 'main', ceiling);
  // Never cached — see {@link RoomRepoStatus.main}. Somebody editing the
  // room's own copy in a terminal, and the operator undoing it, both change
  // this without moving a commit, so a cached answer would go on saying the
  // room is stuck after it was fixed.
  const main = await readMain(owner, repoDir, ceiling);

  const cached = cachedStatus(owner, roomId, mainCommit);
  if (cached) return withCaller(owner, { ...cached, main }, callerAuthorId);

  const fresh = await computeStatus(owner, roomId, repoDir, ceiling, mainCommit, main);
  facet.statusCache.set(roomId, { mainCommit, at: Date.now(), status: fresh });
  return withCaller(owner, fresh, callerAuthorId);
}
/**
 * What the room's own copy holds on disk, in the shape the status reports.
 *
 * @param repoDir - The room's main checkout.
 * @param ceiling - The room home directory git's search may not climb past.
 */
export async function readMain(
  owner: object,
  repoDir: string,
  ceiling: string
): Promise<RoomMainStatus> {
  const facet = readOriginalRoomMergeStatusView(owner);
  const state: RoomMainCheckoutState = await readMainCheckoutState(repoDir, ceiling);
  return {
    branch: state.branch,
    dirty: state.branch !== 'main' || state.strays.length > 0,
    strays: state.strays.slice(0, facet.MAX_REPORTED_STRAYS),
    strayCount: state.strays.length,
  };
}
/**
 * The cached answer for this room, if it is still about the same `main` and
 * still young enough.
 *
 * @param roomId - The room.
 * @param mainCommit - What `main` points at right now.
 */
export function cachedStatus(
  owner: object,
  roomId: string,
  mainCommit: string
): RoomRepoStatus | null {
  const facet = readOriginalRoomMergeStatusView(owner);
  const hit = facet.statusCache.get(roomId);
  if (!hit) return null;
  // A merge moves `main`, so a stale entry cannot outlive the thing it is
  // most likely to be wrong about.
  if (hit.mainCommit !== mainCommit) return null;
  if (Date.now() - hit.at > facet.STATUS_CACHE_MS) return null;
  return hit.status;
}
/**
 * Re-aim a cached answer at whoever is asking now.
 *
 * `mine` is the one field in the payload that is about the CALLER rather than
 * about the room, so a cache shared between two members would otherwise hand
 * the second one the first one's idea of which branch is theirs.
 *
 * @param status - The cached answer.
 * @param callerAuthorId - Who is asking.
 */
export function withCaller(
  owner: object,
  status: RoomRepoStatus,
  callerAuthorId: string
): RoomRepoStatus {
  readOriginalRoomMergeStatusView(owner);
  return {
    ...status,
    branches: status.branches.map((branch) => ({
      ...branch,
      mine: branch.authorId === callerAuthorId,
    })),
  };
}
/**
 * Ask git everything, for one room at one commit.
 *
 * **Split out so it can be cached, and it needed to be.** The work here is
 * `2 + 3n` git spawns for `n` agent members — a branch probe, an ahead/behind
 * and a dirty check each — so a forty-member room is around a hundred and
 * twenty processes, serially, per call. `room_repo_status` is what task 2.4's
 * explorer badges poll, so that would have been paid on a timer, per viewer.
 * The cache is keyed on `main`'s own sha as well as on time, so the answer can
 * never survive the event most likely to change it.
 *
 * @param roomId - The room.
 * @param repoDir - Its main checkout.
 * @param ceiling - The room home directory git's search may not climb past.
 * @param mainCommit - What `main` points at.
 * @param main - What the room's own copy holds on disk, read fresh by the
 *   caller. Stored on the cached answer only so the shape is whole; every
 *   later read replaces it.
 */
export async function computeStatus(
  owner: object,
  roomId: string,
  repoDir: string,
  ceiling: string,
  mainCommit: string,
  main: RoomMainStatus
): Promise<RoomRepoStatus> {
  const facet = readOriginalRoomMergeStatusView(owner);
  const caps = await facet.requireCaps(roomId);
  const committedAt = await headCommittedAt(repoDir, ceiling);

  const tree = await listTree(repoDir, mainCommit, ceiling);
  let usedBytes = 0;
  for (const entry of tree.values()) usedBytes += entry.size;

  const branches: RoomBranchStatus[] = [];
  for (const member of facet.deps.listAgentMembers(roomId)) {
    const slug = RoomWorktreeManager.slugFor(member.displayName, member.agentPath);
    const branch = roomWorktreeBranch(slug);
    if (!(await hasLocalBranch(repoDir, branch, ceiling))) continue;
    const { ahead, behind } = await aheadBehind(repoDir, 'main', branch, ceiling);
    const worktreeDir = path.join(facet.deps.store.worktreesPath(roomId), slug);
    const hasWorktree = await facet.directoryExists(worktreeDir);
    // A working copy git cannot read is unfinished work, never clean — the
    // same conservative direction `listStrandedWorktrees` takes, and for the
    // same reason: nothing here may decide that what it does not understand
    // is disposable.
    let dirty = false;
    if (hasWorktree) {
      try {
        dirty = await hasUncommittedChanges(worktreeDir, ceiling);
      } catch (err) {
        logger.warn('[rooms] could not read a room worktree for status; calling it unfinished', {
          roomId,
          worktree: slug,
          err,
        });
        dirty = true;
      }
    }
    branches.push({
      slug,
      branch,
      // Somebody's display name, rendered next to facts DorkOS states.
      agent: sanitizeIdentity(member.displayName) ?? 'an agent',
      authorId: member.authorId,
      // Re-aimed per caller by `withCaller`, because this is the one field in
      // the payload that is about who asked rather than about the room.
      mine: false,
      hasWorktree,
      ahead,
      behind,
      dirty,
      stranded: dirty || ahead > 0,
    });
  }

  return {
    mainCommit,
    mainCommittedAt: committedAt?.toISOString() ?? null,
    main,
    branches,
    strandedWorktrees: await facet.deps.listStrandedWorktrees(roomId),
    size: {
      usedBytes,
      maxRepoBytes: caps.maxRepoBytes,
      maxFileBytes: caps.maxFileBytes,
    },
  };
}
