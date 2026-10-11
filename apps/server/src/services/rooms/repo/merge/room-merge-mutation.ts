/** Original constructor-private Room merge commit and exact sidecar lifetime. */
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { recordAudit } from '../../../audit/audit-trail.js';
import { readOriginalRoomMergeMutationView } from '../room-merge-service.js';
import path from 'node:path';
import type { Room } from '@dorkos/shared/room-schemas';
import type { RoomRepoCaps, RoomMergeResult } from '@dorkos/shared/room-repo';
import { behindMainMessage } from '@dorkos/shared/room-repo';
import { MERGE_SUMMARY_MAX_CHARS } from '@dorkos/shared/room-schemas';
import { logger } from '../../../../lib/logger.js';
import { RoomError } from '../../data/room-errors.js';
import {
  executeOriginalRoomRepoStoreRead,
  executeOriginalRoomRepoStoreWrite,
} from '../room-repo-store.js';
import { assertMainCheckoutReady } from '../room-main-checkout.js';
import {
  aheadBehind,
  hasLocalBranch,
  hasUncommittedChanges,
  listTree,
  MergeConflictError,
  mergeNoFf,
  readBlob,
  revParse,
  shortstat,
  GITLINK_MODE,
  SYMLINK_MODE,
  type TreeEntry,
} from '../room-repo-git.js';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { mergeSentence, describeBytes, symlinkLeavesRepo } from './room-merge-data.js';
import type { RoomMergeServiceDeps } from '../room-merge-service.js';
import type { RoomMergeOwningConstruction } from './room-merge-owner-custody.js';
/** Fixed constructor-private Room merge mutation dependencies. */
export interface OriginalRoomMergeMutationView {
  readonly deps: Readonly<RoomMergeServiceDeps>;
  readonly owning: RoomMergeOwningConstruction | undefined;
  readonly AGENT_GIT_EMAIL_DOMAIN: string;
  readonly directoryExists: (dir: string) => Promise<boolean>;
  readonly requireCaps: (
    roomId: string,
    context?: InstallationRoomMutationContext
  ) => Promise<RoomRepoCaps>;
}
/** External factories have unrelated keys; the actual fixed mutation view is only registered by the original constructor. */
export function createIsolatedRoomMergeMutation() {
  const views = new WeakMap<object, OriginalRoomMergeMutationView>();
  const get = WeakMap.prototype.get;
  const set = WeakMap.prototype.set;
  const apply = Reflect.apply;
  function actual(owner: object): OriginalRoomMergeMutationView {
    const view = apply(get, views, [owner]) as OriginalRoomMergeMutationView | undefined;
    if (!view) throw new Error('Unknown original Room merge mutation owner.');
    return view;
  }
  return Object.freeze({
    register: (owner: object, view: OriginalRoomMergeMutationView) =>
      apply(set, views, [owner, view]),
    read: actual,
  });
}

/**
 * Every check that reads git, the merge itself, and the announcement — all
 * while holding the room's lane.
 *
 * @param room - The room, already authorized.
 * @param target - Whose branch is being merged.
 * @param rawSummary - The caller's own summary, unsanitized.
 */
export async function mergeUnderLock(
  owner: object,
  room: Room,
  target: { slug: string; branch: string; authorId: string; agentName: string },
  rawSummary: string,
  context: InstallationRoomMutationContext
): Promise<RoomMergeResult> {
  const facet = readOriginalRoomMergeMutationView(owner);
  const roomId = room.id;
  const roots = readInstallationRoomMutationRoots(context),
    repoDir = roots.repoPath,
    ceiling = roots.homePath;
  const caps = await facet.requireCaps(roomId, context);
  await checkInstallationRoomMutationTarget(context, repoDir);

  // The one dirty-main gate, shared with the human save path
  // (`room-main-checkout.ts`): two writers into one tree must agree about
  // what "somebody else has been writing here" means, or one of them
  // eventually writes on top of it.
  await assertMainCheckoutReady(repoDir, ceiling);

  if (!(await hasLocalBranch(repoDir, target.branch, ceiling))) {
    throw new RoomError(
      'NOTHING_TO_MERGE',
      'There is no work to merge yet — nothing has been committed in that working copy.'
    );
  }

  const worktreeDir = path.join(roots.homePath, 'worktrees', target.slug);
  // A branch whose working copy the reap removed has nothing to be dirty, and
  // its commits are still mergeable. Only an existing tree is asked.
  if (await facet.directoryExists(worktreeDir)) {
    if (await hasUncommittedChanges(worktreeDir, ceiling)) {
      throw new RoomError(
        'UNCOMMITTED_WORK',
        'Your working copy has changes you have not committed. Commit them (or undo them), then merge.'
      );
    }
  }

  const { ahead, behind } = await aheadBehind(repoDir, 'main', target.branch, ceiling);
  if (behind > 0) {
    throw new RoomError('BEHIND_MAIN', behindMainMessage(behind, ahead));
  }
  if (ahead === 0) {
    throw new RoomError(
      'NOTHING_TO_MERGE',
      'Your branch holds nothing the room does not already have.'
    );
  }

  const mainCommit = await revParse(repoDir, 'main', ceiling);
  await assertDeltaAllowed(owner, repoDir, ceiling, mainCommit, target.branch, caps);

  const stat = await shortstat(repoDir, mainCommit, target.branch, ceiling);
  const summary = sanitizeIdentity(rawSummary, MERGE_SUMMARY_MAX_CHARS);
  const subject = summary ?? `Merge ${target.branch}`;

  await checkInstallationRoomMutationTarget(context, repoDir);
  requireInstallationRoomMutationTarget(context, repoDir);
  let commit: string;
  try {
    commit = await mergeNoFf(
      repoDir,
      target.branch,
      subject,
      {
        // Sanitized for the same reason the room's own labels are: this string
        // ends up inside a `-c user.name=` argument and then inside `git log`,
        // and a name carrying a newline is a name that can forge a header.
        name: sanitizeIdentity(target.agentName) ?? 'an agent',
        email: `${target.slug}@${facet.AGENT_GIT_EMAIL_DOMAIN}`,
      },
      ceiling,
      context
    );
  } catch (err) {
    if (err instanceof MergeConflictError) {
      logger.warn('[rooms] a room merge was rolled back; main is unchanged', {
        roomId,
        branch: target.branch,
        err,
      });
      throw new RoomError(
        'MERGE_CONFLICT',
        'That merge would not go in cleanly, so nothing was changed. Run `git merge main` in your own working copy, sort it out there, and try again.'
      );
    }
    throw err;
  }

  // Past this line the work IS on main. If the announcement throws — the room
  // was archived in the window between the gate and here, which takes a
  // deliberate human act — it propagates, because a merge nobody was told
  // about is worse news than an error. The commit is not rolled back: a room's
  // repo is append-only, and undoing it is the one thing this domain cannot do.
  await checkInstallationRoomMutationTarget(context, repoDir);
  requireInstallationRoomMutationTarget(context, repoDir);
  const entry = facet.deps.announce(roomId, {
    text: mergeSentence(target.agentName, subject, stat),
    merge: {
      branch: target.branch,
      commit,
      files: stat.files,
      insertions: stat.insertions,
      deletions: stat.deletions,
    },
    subjectAuthorId: target.authorId,
  });

  await checkInstallationRoomMutationTarget(context, repoDir);
  await recordLastMergeSeq(owner, roomId, entry.seq, context);
  await checkInstallationRoomMutationTarget(context, repoDir);
  requireInstallationRoomMutationTarget(context, repoDir);
  // The commit is authored as the agent whose work it is; the audit log names
  // who MERGED it, from the caller's own scope (spec `audit-trail` PR2), so
  // an owner merging an agent's copy is not recorded as the agent.
  recordAudit({
    action: 'room.merged',
    operation: 'modify',
    target: {
      type: 'room-branch',
      id: target.branch,
      name: `${target.agentName}'s work`,
      containerId: roomId,
    },
    outcome: 'ok',
    // The short form: a full commit id is long hex, which the audit log's
    // redaction treats as a possible secret. Twelve characters is what git
    // itself shows, and is enough to find the commit.
    change: [{ field: 'main', after: commit.slice(0, 12) }],
    summary: `Merged ${target.agentName}'s work into the room (${stat.files} file${
      stat.files === 1 ? '' : 's'
    })`,
  });
  logger.info('[rooms] work merged into a room’s main', {
    roomId,
    branch: target.branch,
    commit,
    files: stat.files,
  });

  requireInstallationRoomMutationTarget(context, repoDir);
  return {
    branch: target.branch,
    commit,
    files: stat.files,
    insertions: stat.insertions,
    deletions: stat.deletions,
    seq: entry.seq,
  };
}
/**
 * Refuse work that must not enter the room's tree, before any of it does.
 *
 * Run against the BRANCH's whole tree compared with `main`'s, which is exactly
 * the delta the merge will apply — the branch already contains `main`
 * (`BEHIND_MAIN` saw to that), so its tree is what `main` will hold. Two of the
 * three checks are per-changed-file and the third is a total:
 *
 * - **Symlinks** are checked only where they are NEW or CHANGED (spec §3.6
 *   validates the incoming delta). A link that is already in `main` blocks
 *   nothing; refusing on it would wedge every future merge over something
 *   nobody in this call did.
 * - **File size** likewise: an over-cap file already in the tree is history,
 *   and a cap that was raised and lowered again must not make the room
 *   unmergeable.
 * - **Repo size** is the total, because that is what the cap means.
 *
 * @param repoDir - The room's main checkout.
 * @param ceiling - The room home directory git's search may not climb past.
 * @param mainCommit - The commit `main` points at.
 * @param branch - The branch being merged.
 * @param caps - The room's frozen ceilings.
 */
export async function assertDeltaAllowed(
  owner: object,
  repoDir: string,
  ceiling: string,
  mainCommit: string,
  branch: string,
  caps: RoomRepoCaps
): Promise<void> {
  readOriginalRoomMergeMutationView(owner);
  const before = await listTree(repoDir, mainCommit, ceiling);
  const after = await listTree(repoDir, branch, ceiling);

  let totalBytes = 0;
  const changed: TreeEntry[] = [];
  for (const entry of after.values()) {
    totalBytes += entry.size;
    const previous = before.get(entry.path);
    if (!previous || previous.sha !== entry.sha || previous.mode !== entry.mode) {
      changed.push(entry);
    }
  }

  for (const entry of changed) {
    // **A gitlink is refused before anything else looks at it**, because
    // nothing else CAN: it names a commit in a repository that is not this
    // one, so there is no blob to size, no target to resolve and no content to
    // inspect. It reached `main` unchecked while `listTree` was dropping
    // non-blobs — it appeared in neither tree, so it was never in the delta.
    // A room's files are the room's; a pointer at somebody else's repository
    // is a dependency every member would have to fetch from a place this
    // room knows nothing about.
    if (entry.mode === GITLINK_MODE) {
      throw new RoomError(
        'SUBMODULE_NOT_ALLOWED',
        `\`${entry.path}\` is a link to another git repository (a submodule). A room's files have to be the room's own — copy in what you need, or share the other repository another way.`
      );
    }
    if (entry.mode === SYMLINK_MODE) {
      const target = await readBlob(repoDir, entry.sha, ceiling);
      if (symlinkLeavesRepo(entry.path, target)) {
        throw new RoomError(
          'SYMLINK_ESCAPES_REPO',
          `\`${entry.path}\` is a shortcut pointing outside the room’s files (at \`${target}\`). Copy what you need into the room instead — a shortcut only works on the computer that made it.`
        );
      }
    }
    if (entry.size > caps.maxFileBytes) {
      throw new RoomError(
        'FILE_TOO_LARGE',
        `\`${entry.path}\` is ${describeBytes(entry.size)}, and this room’s limit for one file is ${describeBytes(caps.maxFileBytes)}. Attach big files to a message instead — that is what attachments are for.`
      );
    }
  }

  if (totalBytes > caps.maxRepoBytes) {
    throw new RoomError(
      'REPO_CAP_EXCEEDED',
      `This would take the room’s files to ${describeBytes(totalBytes)}, past its ${describeBytes(caps.maxRepoBytes)} limit. Remove what is no longer needed, or attach large files to a message instead.`
    );
  }
}
/**
 * Point the sidecar at the entry that announced this merge.
 *
 * Best-effort by design. The merge has landed and the room has been told; a
 * sidecar write that fails costs the explorer a refresh hint, and throwing
 * here would report a merge that did happen as one that did not. The
 * reconciler rebuilds the row from the file either way.
 *
 * @param roomId - The room.
 * @param seq - The announcing entry's seq.
 */
export async function recordLastMergeSeq(
  owner: object,
  roomId: string,
  seq: number,
  context: InstallationRoomMutationContext
): Promise<void> {
  const facet = readOriginalRoomMergeMutationView(owner);
  try {
    const sidecar = await executeOriginalRoomRepoStoreRead(
      facet.deps.store,
      facet.owning!.db,
      context,
      roomId
    );
    if (!sidecar) return;
    await executeOriginalRoomRepoStoreWrite(facet.deps.store, facet.owning!.db, context, {
      ...sidecar,
      lastMergeSeq: seq,
    });
  } catch (err) {
    logger.warn('[rooms] could not record a room’s last merge; the merge itself is fine', {
      roomId,
      seq,
      err,
    });
  }
}
