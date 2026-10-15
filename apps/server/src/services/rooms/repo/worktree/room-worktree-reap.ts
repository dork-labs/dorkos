/** Original root-private Worktree reap transaction checks and idle-date ordering. */
import { lstatSync, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import {
  commitsAheadOfMain,
  deleteMergedBranch,
  hasUncommittedChanges,
  headCommittedAt,
  pruneWorktrees,
  removeWorktree,
  readRoomWorktreeRegistration,
} from '../room-repo-git.js';
import { readRoomServiceOriginalBusyAgents } from '../../room-service.js';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import {
  ROOM_REPO_SIDECAR_FILENAME,
  readOwnedRoomRepoSource,
  originalRoomRepoRoomExists,
  executeOriginalRoomRepoStoreRead,
} from '../room-repo-store.js';
import { readOriginalRoomRepoMaintenanceOperation } from '../room-repo-reconciler.js';
import { readRoomRepoConfig } from '../room-repo-config.js';
import { DocChannelNotFoundError } from '../../../canvas/doc-channel/authorization.js';
import { requireOriginalHttpRoomWorktreeOwner } from '../../../canvas/doc-channel/http-composition.js';
import {
  readOriginalRoomWorktreeReapView,
  requireRoomWorktreeManagerOwner,
  RoomWorktreeManager,
  roomWorktreeBranch,
} from '../room-worktree-manager.js';
import type { RoomWorktreeSweepResult } from './room-worktree-contracts.js';

/** Execute the original root-owned Worktree reap after private membership. */
export async function reapOwned(
  engineOwner: object,
  roomId: string,
  context: InstallationRoomMutationContext
): Promise<RoomWorktreeSweepResult> {
  const facet = readOriginalRoomWorktreeReapView(engineOwner);
  const result: RoomWorktreeSweepResult = {
    reaped: [],
    reapedTreeKeptBranch: [],
    spared: [],
    stranded: [],
  };
  const owning = facet.owning!;
  const store = facet.originalManagers.get(facet.originalManager)!.store;
  const reapingCapture: { expectedRow?: string } = {};
  const current = () => {
    requireRoomWorktreeManagerOwner(facet.originalManager, owning.owner, owning.db, owning.rooms);
    requireOriginalHttpRoomWorktreeOwner(
      owning.owner,
      facet.originalManager,
      owning.db,
      owning.rooms
    );
    const operation = readOriginalRoomRepoMaintenanceOperation(context, store, owning.db);
    if (!operation || operation.roomId !== roomId || operation.phase !== 'reap')
      throw new DocChannelNotFoundError();
    const roots = readInstallationRoomMutationRoots(context);
    const source = readOwnedRoomRepoSource(store, owning.db, roomId);
    if (
      !originalRoomRepoRoomExists(store, owning.db, roomId) ||
      source.row?.mode !== 'owned' ||
      (reapingCapture.expectedRow !== undefined &&
        JSON.stringify(source.row) !== reapingCapture.expectedRow) ||
      roots.homePath !== source.home ||
      roots.repoPath !== source.repo
    )
      throw new DocChannelNotFoundError();
    requireInstallationRoomMutationTarget(context, source.home);
    return roots;
  };
  if (!readRoomRepoConfig().enabled) {
    current();
    return result;
  }
  const roots = current(),
    root = path.join(roots.homePath, 'worktrees');
  reapingCapture.expectedRow = JSON.stringify(
    readOwnedRoomRepoSource(store, owning.db, roomId).row
  );
  facet.reapContexts.add(context);
  const sidecar = await executeOriginalRoomRepoStoreRead(store, owning.db, context, roomId);
  current();
  if (!sidecar || sidecar.mode !== 'owned') throw new DocChannelNotFoundError();
  const expectedSidecar = JSON.stringify(sidecar);
  const sidecarPath = path.join(roots.homePath, ROOM_REPO_SIDECAR_FILENAME);
  const homeIdentity = await fs.lstat(roots.homePath);
  current();
  const repoIdentity = await fs.lstat(roots.repoPath);
  current();
  const sidecarIdentity = await fs.lstat(sidecarPath);
  current();
  if (
    !homeIdentity.isDirectory() ||
    homeIdentity.isSymbolicLink() ||
    !repoIdentity.isDirectory() ||
    repoIdentity.isSymbolicLink() ||
    !sidecarIdentity.isFile() ||
    sidecarIdentity.isSymbolicLink()
  )
    throw new DocChannelNotFoundError();
  const same = (left: { dev: number; ino: number }, right: { dev: number; ino: number }) =>
    left.dev === right.dev && left.ino === right.ino;
  let rootIdentity: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootIdentity = await fs.lstat(root);
  } catch (error) {
    current();
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return result;
    throw error;
  }
  current();
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink())
    throw new DocChannelNotFoundError();
  await checkInstallationRoomMutationTarget(context, root);
  current();
  const entries = await fs.readdir(root, { withFileTypes: true });
  current();
  const cutoff = facet.nowMs() - readRoomRepoConfig().worktreeReapDays * 24 * 60 * 60 * 1000;
  current();
  const busy = (slug: string) =>
    readRoomServiceOriginalBusyAgents(owning.rooms, owning.db, owning.roomStore).some(
      (agentPath) => RoomWorktreeManager.digestFor(agentPath) === slug.slice(-facet.slugDigestChars)
    );
  const verifyParents = async () => {
    current();
    if (!readRoomRepoConfig().enabled) throw new DocChannelNotFoundError();
    await checkInstallationRoomMutationTarget(context, root);
    current();
    for (const [target, expected] of [
      [roots.homePath, homeIdentity],
      [roots.repoPath, repoIdentity],
      [root, rootIdentity],
      [sidecarPath, sidecarIdentity],
    ] as const) {
      const observed = await fs.lstat(target);
      current();
      if (!same(expected, observed) || observed.isSymbolicLink())
        throw new DocChannelNotFoundError();
    }
    const fresh = await executeOriginalRoomRepoStoreRead(store, owning.db, context, roomId);
    current();
    if (!fresh || JSON.stringify(fresh) !== expectedSidecar) throw new DocChannelNotFoundError();
  };
  const nativeTail = (slug?: string, dir?: string, identity?: Stats) => {
    // Callback-free physical checks repeat after the lowlevel launcher's own awaited guards.
    current();
    if (!readRoomRepoConfig().enabled) throw new DocChannelNotFoundError();
    for (const [target, expected] of [
      [roots.homePath, homeIdentity],
      [roots.repoPath, repoIdentity],
      [root, rootIdentity],
      [sidecarPath, sidecarIdentity],
    ] as const) {
      const observed = lstatSync(target);
      if (!same(expected, observed) || observed.isSymbolicLink())
        throw new DocChannelNotFoundError();
      if (
        target === sidecarPath &&
        (observed.size !== sidecarIdentity.size ||
          observed.mtimeMs !== sidecarIdentity.mtimeMs ||
          observed.ctimeMs !== sidecarIdentity.ctimeMs)
      )
        throw new DocChannelNotFoundError();
    }
    if (dir && identity) {
      const observed = lstatSync(dir);
      if (
        !same(identity, observed) ||
        !observed.isDirectory() ||
        observed.isSymbolicLink() ||
        observed.mtimeMs > cutoff
      )
        throw new DocChannelNotFoundError();
    }
    if (slug && busy(slug)) throw new DocChannelNotFoundError();
    current();
  };
  const effect = async <T>(guard: () => void, work: () => Promise<T>): Promise<T> => {
    if (facet.reapEffects.has(context)) throw new DocChannelNotFoundError();
    guard();
    facet.reapEffects.set(context, guard);
    try {
      return await work();
    } finally {
      facet.reapEffects.delete(context);
    }
  };
  const dated = new Map<string, { identity: Stats; date: Date }>();
  // Date every candidate before Git status, preserving the original idle-clock ordering.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      await checkInstallationRoomMutationTarget(context, dir);
      current();
      const identity = await fs.lstat(dir);
      current();
      if (!identity.isDirectory() || identity.isSymbolicLink())
        throw new Error('Unknown room worktree directory');
      const date = await lastTouchedAt(engineOwner, dir, roots.homePath);
      current();
      const after = await fs.lstat(dir);
      current();
      if (!same(identity, after)) throw new Error('Room worktree directory was replaced');
      dated.set(entry.name, { identity, date });
    } catch (error) {
      current();
      result.stranded.push(entry.name);
    }
  }
  for (const [slug, candidate] of dated) {
    const dir = path.join(root, slug),
      branch = roomWorktreeBranch(slug);
    if (busy(slug) || candidate.date.getTime() > cutoff) {
      result.spared.push(slug);
      continue;
    }
    let registration: Awaited<ReturnType<typeof readRoomWorktreeRegistration>>;
    try {
      await verifyParents();
      registration = await readRoomWorktreeRegistration(
        roots.repoPath,
        roots.homePath,
        dir,
        branch
      );
      current();
      if (!registration || (await hasUncommittedChanges(dir, roots.homePath))) {
        current();
        result.stranded.push(slug);
        continue;
      }
      current();
      if ((await commitsAheadOfMain(dir, roots.homePath)) > 0) {
        current();
        result.stranded.push(slug);
        continue;
      }
      current();
    } catch (error) {
      current();
      result.stranded.push(slug);
      continue;
    }
    // Repeat actual registration, physical identity, sidecar/native and private busy facts after all waits.
    await verifyParents();
    const finalRegistration = await readRoomWorktreeRegistration(
      roots.repoPath,
      roots.homePath,
      dir,
      branch
    );
    current();
    const finalDirectory = await fs.lstat(dir);
    current();
    if (
      !finalRegistration ||
      JSON.stringify(finalRegistration) !== JSON.stringify(registration) ||
      !same(candidate.identity, finalDirectory) ||
      finalDirectory.isSymbolicLink() ||
      finalDirectory.mtimeMs > cutoff ||
      busy(slug)
    ) {
      result.spared.push(slug);
      continue;
    }
    requireInstallationRoomMutationTarget(context, dir);
    current();
    if (busy(slug)) {
      result.spared.push(slug);
      continue;
    }
    // No force. Git additionally refuses changed files at its actual native removal boundary.
    try {
      await effect(
        () => nativeTail(slug, dir, candidate.identity),
        () => removeWorktree(roots.repoPath, dir, roots.homePath, context)
      );
    } catch (error) {
      current();
      result.spared.push(slug);
      continue;
    }
    current();
    // This successful owned removal is the private continuation receipt for branch cleanup.
    // A fresh claim keeps the branch; never roll back an already-landed worktree removal.
    await verifyParents();
    if (busy(slug)) {
      result.reapedTreeKeptBranch.push(slug);
      continue;
    }
    const branchGone = await effect(
      () => nativeTail(slug),
      () => deleteMergedBranch(roots.repoPath, branch, roots.homePath, context)
    );
    current();
    if (branchGone) result.reaped.push(slug);
    else result.reapedTreeKeptBranch.push(slug);
  }
  if (result.reaped.length + result.reapedTreeKeptBranch.length > 0) {
    await verifyParents();
    await effect(
      () => nativeTail(),
      () => pruneWorktrees(roots.repoPath, roots.homePath, context)
    );
    current();
  }
  current();
  return result;
}

/**
 * The most recent moment anything in a worktree moved.
 *
 * **Bounded on purpose, and every source it keeps is one the sweep cannot
 * move.** Three cheap sources are taken, and the newest wins:
 *
 * - the committer date of `HEAD` — when the agent last committed here, and
 *   the floor for a worktree that has done nothing else (a fresh one inherits
 *   `main`'s tip),
 * - the mtime of the working tree's own root directory — moved by anything
 *   created or deleted at the top level, including the `git worktree add`
 *   that made it, so a brand-new worktree reads as touched now,
 * - the newest mtime among the root's direct children.
 *
 * **The `index` mtime is deliberately NOT among them, and that is a fix
 * rather than an omission.** It used to be the fourth source, and it was the
 * one that made the reap load-sensitive: git rewrites its index whenever a
 * read finds the cached `stat` untrustworthy — a plain `git status`, and on a
 * slow filesystem an ordinary read — and that rewrite stamps the index file
 * `now`. Reproduced directly: after a worktree was aged forty days, one
 * index-refreshing git call in this very method read the index back as
 * "touched now", and the reap spared a genuinely idle tree. On a busy CI
 * runner that surfaced as a reap that removed nothing. Dropping the source
 * removes the coupling at the root: the sweep runs `git status` in every
 * candidate (`listStrandedWorktrees`) and this method runs `git log` — none
 * of it moves a directory or a working-file mtime, only the index, which is
 * no longer read.
 *
 * Nothing real is lost with it. The index mtime moves on `git add` (which
 * leaves the tree dirty — the stranded gate catches it), on `commit` (which
 * moves `HEAD` and puts the branch ahead of main — the stranded gate again,
 * and the head date here), and on a bare `git status` (which is a read, not
 * work). The one thing it uniquely marked was "somebody ran `git status`
 * here", which is not a reason to keep a checkout alive.
 *
 * That is one `readdir` and a handful of `stat`s, no matter how large the
 * tree. A full recursive walk would be the complete answer and would also be
 * a disk scan of every agent's checkout every five minutes, on a machine
 * already running the agents.
 *
 * What the bound misses: an edit deep inside an existing top-level directory.
 * For work that matters this costs nothing, because such a tree is dirty by
 * git's own reckoning and the reap never reaches the date. The real residue
 * is a worktree whose only recent activity is writing IGNORED files deep down
 * — build output, `node_modules` under an existing directory. That can be
 * reaped after the idle window, and what is lost is regenerable.
 *
 * @param dir - The worktree.
 * @param ceiling - The room home directory git's search may not climb past.
 * @returns The newest of the three.
 */
export async function lastTouchedAt(
  engineOwner: object,
  dir: string,
  ceiling: string
): Promise<Date> {
  readOriginalRoomWorktreeReapView(engineOwner);
  const stamps: number[] = [];

  // The filesystem mtimes first, and the one git spawn last: even though
  // `git log` does not touch a directory or working-file mtime, reading the
  // durable sources before any child process runs keeps this method's answer
  // provably independent of anything git might do.
  const entries = await fs.readdir(dir);
  stamps.push(...(await newestMtime([dir, ...entries.map((name) => path.join(dir, name))])));

  const head = await headCommittedAt(dir, ceiling);
  if (head) stamps.push(head.getTime());

  return new Date(Math.max(...stamps, 0));
}

/**
 * The mtimes of the paths that exist, in milliseconds.
 *
 * Missing paths contribute nothing rather than throwing: an `index` a worktree
 * has not written yet, and a file removed between the `readdir` and the `stat`,
 * are both ordinary.
 *
 * @param targets - Paths to stat.
 */
async function newestMtime(targets: string[]): Promise<number[]> {
  const stamps: number[] = [];
  for (const target of targets) {
    try {
      stamps.push((await fs.lstat(target)).mtimeMs);
    } catch {
      // Gone, or never there. Not a date.
    }
  }
  return stamps;
}
