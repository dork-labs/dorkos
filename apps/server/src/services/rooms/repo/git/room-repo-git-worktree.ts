/** Original finite Room Git worktree operations; the real launcher key stays private. */
import { type InstallationRoomMutationContext } from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import {
  readOriginalRoomGitCommandPorts,
  GitUnavailableError,
  type NativeLaunch,
} from '../room-repo-git.js';

/** Build finite operations for an opaque key; unrelated keys fail the original private lookup. */
export function createOriginalRoomGitWorktreeFamily(owner: object) {
  /**
   * Add a standing worktree at `worktreeDir` on branch `branch`.
   *
   * Two shapes, because the branch may already exist: the reap removes a
   * worktree's DIRECTORY and `git worktree remove` leaves the branch behind, so
   * "create the branch" is right the first time and wrong every time after. The
   * caller decides which with `createFrom`, having asked
   * {@link hasLocalBranch} — see {@link addWorktree}'s only caller for why that
   * probe is not replaced by catching the failure.
   *
   * @param repoDir - The room's main checkout, which owns the worktree list.
   * @param worktreeDir - Where the new working tree goes. Must not exist.
   * @param branch - The branch to check out in it.
   * @param createFrom - The commit-ish to branch FROM (`'main'`), or `null` to
   *   check out a branch that already exists.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function addWorktree(
    repoDir: string,
    worktreeDir: string,
    branch: string,
    createFrom: string | null,
    ceilingDir: string,
    context: InstallationRoomMutationContext
  ): Promise<void> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(branch);
    if (createFrom !== null) ports.requireRevisionOperand(createFrom);
    const args = createFrom
      ? ['worktree', 'add', '--quiet', '-b', branch, worktreeDir, createFrom]
      : ['worktree', 'add', '--quiet', worktreeDir, branch];
    await ports.runOwnedGit(args, repoDir, ceilingDir, context, {}, [worktreeDir]);
  }

  /**
   * Remove a standing worktree — **never forced**.
   *
   * The absent `--force` is the point. Git refuses to remove a working tree that
   * holds modified or untracked files, so this call is a second, independent
   * check on the reap's own dirty gate, made by git at the moment of deletion
   * rather than by DorkOS a few milliseconds earlier. An agent that started
   * writing between the two is protected by the one that runs last.
   *
   * @param repoDir - The room's main checkout.
   * @param worktreeDir - The working tree to remove.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @throws When git refuses, which includes "it is not empty".
   */
  async function removeWorktree(
    repoDir: string,
    worktreeDir: string,
    ceilingDir: string,
    context: InstallationRoomMutationContext
  ): Promise<void> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    await ports.runOwnedGit(['worktree', 'remove', worktreeDir], repoDir, ceilingDir, context, {}, [
      worktreeDir,
    ]);
  }

  /**
   * Drop the administrative records of worktrees whose directories are gone.
   *
   * Run after a reap so `git worktree list` matches the disk. Harmless when
   * nothing was removed.
   *
   * @param repoDir - The room's main checkout.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function pruneWorktrees(
    repoDir: string,
    ceilingDir: string,
    context: InstallationRoomMutationContext
  ): Promise<void> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    await ports.runOwnedGit(['worktree', 'prune'], repoDir, ceilingDir, context);
  }

  /**
   * Delete a branch **only if `main` already contains it** (`-d`, never `-D`).
   *
   * The safe form is load-bearing rather than tidy: it means this call cannot be
   * the thing that loses a commit even if every check above it were wrong. Git
   * refuses and the branch stays.
   *
   * @param repoDir - The room's main checkout.
   * @param branch - The branch to retire.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns `true` when the branch is gone, `false` when git refused.
   */
  async function deleteMergedBranch(
    repoDir: string,
    branch: string,
    ceilingDir: string,
    context: InstallationRoomMutationContext
  ): Promise<boolean> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(branch);
    const launch: NativeLaunch = { started: false };
    try {
      await ports.runOwnedGit(
        ['branch', '--quiet', '-d', branch],
        repoDir,
        ceilingDir,
        context,
        {},
        [],
        launch
      );
      return true;
    } catch (err) {
      if (!launch.started || err instanceof GitUnavailableError) throw err;
      return false;
    }
  }

  return Object.freeze({ addWorktree, removeWorktree, pruneWorktrees, deleteMergedBranch });
}
