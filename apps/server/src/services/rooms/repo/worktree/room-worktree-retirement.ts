/** Original exact legacy retirement mutation under the genuine launch context. */
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { commonGitDir } from '../room-repo-git.js';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  requireInstallationRoomLaunchTarget,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { readOriginalRoomWorktreeRetirementView } from '../room-worktree-manager.js';
import {
  readIfPresent,
  blockPatterns,
  withoutExcludeBlock,
  hiddenUntracked,
  isLegacyPlumbing,
  sameWorktreeInode,
  noWorktreeNeedsBlock,
} from './room-worktree-retirement-reads.js';

/** Retire only acquired original legacy targets, preserving launch checks and first cause. */
export async function retireOwned(
  engineOwner: object,
  roomId: string,
  worktree: string,
  agentPath: string,
  context: InstallationRoomMutationContext
): Promise<{ removed: number; blockRemoved: boolean }> {
  const facet = readOriginalRoomWorktreeRetirementView(engineOwner);
  const outcome = { removed: 0, blockRemoved: false };
  const requireLaunch = () =>
    requireInstallationRoomLaunchTarget(
      context,
      facet.originalManager,
      roomId,
      worktree,
      agentPath
    );
  requireLaunch();
  if (facet.retired.has(worktree)) return outcome;
  const roots = readInstallationRoomMutationRoots(context);
  const tree = await fs.lstat(worktree),
    canonicalTree = await fs.realpath(worktree);
  if (
    !tree.isDirectory() ||
    tree.isSymbolicLink() ||
    canonicalTree !==
      path.join(await fs.realpath(roots.homePath), path.relative(roots.homePath, worktree))
  )
    throw new Error('Legacy retirement worktree is not the original native target.');
  const checkTree = async () => {
    await checkInstallationRoomMutationTarget(context, worktree);
    if (
      !sameWorktreeInode(engineOwner, tree, await fs.lstat(worktree)) ||
      (await fs.realpath(worktree)) !== canonicalTree
    )
      throw new Error('Legacy retirement worktree changed.');
    requireLaunch();
  };
  const parentOf = async (target: string) => {
    await checkTree();
    const parent = path.dirname(target),
      stat = await fs.lstat(parent);
    const real = await fs.realpath(parent);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      real !== path.join(canonicalTree, path.relative(worktree, parent))
    )
      throw new Error('Legacy retirement refuses a replaced or linked ancestor.');
    await checkTree();
    return { parent, stat };
  };
  const excludeFile = path.join(
    await commonGitDir(roots.repoPath, roots.homePath),
    'info',
    'exclude'
  );
  await checkTree();
  const patterns = blockPatterns(engineOwner, await readIfPresent(engineOwner, excludeFile));
  await checkTree();
  if (patterns.length === 0) {
    facet.retired.add(worktree);
    return outcome;
  }
  const emptyParents = new Set(facet.LEGACY_PARENT_DIRS);
  for (const rel of await hiddenUntracked(engineOwner, worktree, roots.homePath, patterns)) {
    await checkTree();
    const target = path.resolve(worktree, rel);
    if (target === worktree || !target.startsWith(`${worktree}${path.sep}`))
      throw new Error('Legacy retirement path escaped its original worktree.');
    const parent = await parentOf(target);
    const acquired = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!acquired || (!acquired.isFile() && !acquired.isSymbolicLink())) continue;
    if (!(await isLegacyPlumbing(engineOwner, worktree, rel, agentPath))) continue;
    await checkTree();
    if (
      !sameWorktreeInode(engineOwner, acquired, await fs.lstat(target)) ||
      !sameWorktreeInode(engineOwner, parent.stat, await fs.lstat(parent.parent))
    )
      throw new Error('Legacy retirement refuses an observed replacement.');
    requireLaunch();
    requireInstallationRoomMutationTarget(context, target);
    await fs.unlink(target); // Never recursively delete an observed directory.
    await checkTree();
    outcome.removed++;
    // Only this successfully acquired/unlinked legacy leaf contributes dynamic
    // ancestors (for example attachment entry folders). Never remove content.
    for (
      let ancestor = path.dirname(path.relative(worktree, target));
      ancestor !== '.';
      ancestor = path.dirname(ancestor)
    )
      emptyParents.add(ancestor);
  }
  // Empty ancestor cleanup is identity-checked and never recursively removes content.
  for (const rel of [...emptyParents].sort(
    (left, right) => right.split(path.sep).length - left.split(path.sep).length
  )) {
    const directory = path.join(worktree, rel),
      parent = await parentOf(directory).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      });
    if (!parent) continue;
    const acquired = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    });
    if (
      !acquired?.isDirectory() ||
      acquired.isSymbolicLink() ||
      (await fs.readdir(directory)).length !== 0
    )
      continue;
    await checkTree();
    if (
      !sameWorktreeInode(engineOwner, acquired, await fs.lstat(directory)) ||
      !sameWorktreeInode(engineOwner, parent.stat, await fs.lstat(parent.parent))
    )
      throw new Error('Legacy empty directory replaced.');
    requireLaunch();
    await fs.rmdir(directory);
    await checkTree();
  }
  if (await noWorktreeNeedsBlock(engineOwner, roomId, roots.homePath, patterns, context)) {
    await checkTree();
    await checkInstallationRoomMutationTarget(context, excludeFile);
    const parentPath = path.dirname(excludeFile),
      parent = await fs.lstat(parentPath),
      previous = await fs.lstat(excludeFile);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      !previous.isFile() ||
      previous.isSymbolicLink() ||
      (await fs.realpath(parentPath)) !==
        path.join(await fs.realpath(roots.homePath), path.relative(roots.homePath, parentPath))
    )
      throw new Error('Legacy exclude target is not its original regular file.');
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    let failed = false,
      cause: unknown;
    try {
      requireLaunch();
      file = await fs.open(excludeFile, constants.O_RDWR | constants.O_NOFOLLOW);
      const acquired = await file.stat();
      if (!sameWorktreeInode(engineOwner, previous, acquired))
        throw new Error('Legacy exclude acquisition changed.');
      const current = await file.readFile('utf8'),
        next = withoutExcludeBlock(engineOwner, current);
      await checkTree();
      if (
        !sameWorktreeInode(engineOwner, acquired, await fs.lstat(excludeFile)) ||
        !sameWorktreeInode(engineOwner, parent, await fs.lstat(parentPath))
      )
        throw new Error('Legacy exclude publication replaced.');
      if (next !== current) {
        requireLaunch();
        requireInstallationRoomMutationTarget(context, excludeFile);
        const bytes = Buffer.from(next);
        for (let offset = 0; offset < bytes.length;) {
          await checkTree();
          if (
            !sameWorktreeInode(engineOwner, acquired, await fs.lstat(excludeFile)) ||
            !sameWorktreeInode(engineOwner, parent, await fs.lstat(parentPath))
          )
            throw new Error('Legacy exclude replaced before retained write.');
          requireLaunch();
          requireInstallationRoomMutationTarget(context, excludeFile);
          const wrote = await file.write(bytes, offset, bytes.length - offset, offset);
          if (wrote.bytesWritten <= 0)
            throw new Error('Legacy retained exclude write made no progress.');
          offset += wrote.bytesWritten;
        }
        await checkTree();
        if (
          !sameWorktreeInode(engineOwner, acquired, await fs.lstat(excludeFile)) ||
          !sameWorktreeInode(engineOwner, parent, await fs.lstat(parentPath))
        )
          throw new Error('Legacy exclude replaced after write.');
        requireLaunch();
        await file.truncate(bytes.length);
        await checkTree();
        outcome.blockRemoved = true;
      }
    } catch (error) {
      failed = true;
      cause = error;
    } finally {
      if (file)
        try {
          await file.close();
        } catch (error) {
          if (!failed) {
            failed = true;
            cause = error;
          }
        }
    }
    if (failed) throw cause;
  }
  await checkTree();
  requireLaunch();
  facet.retired.add(worktree);
  return outcome;
}
