/**
 * Whether a directory's `.dork/agent.json` belongs to a git repository — the
 * one question that decides if DorkOS may delete it (DOR-1019).
 *
 * A manifest git is tracking is part of somebody's repo: it was committed on
 * purpose, teammates get it on clone, and deleting it is a change to their
 * source tree that DorkOS was never asked to make. A manifest git has never
 * heard of is DorkOS's own bookkeeping, and removing it on unregister is what
 * stops the agent walking back in on the next scan (ADR-0043).
 *
 * @module mesh/git-tracked
 */
import { execFile } from 'child_process';
import { access } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { MANIFEST_DIR, MANIFEST_FILE } from './manifest.js';

const execFileAsync = promisify(execFile);

/** How long git gets to answer before the fallback probe decides instead. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * How far up the tree to look for a `.git` when git itself could not answer.
 * Deep enough for any real checkout, bounded so a pathological path cannot
 * turn one unregister into an unbounded walk.
 */
const MAX_GIT_PROBE_DEPTH = 64;

/**
 * Whether `<projectPath>/.dork/agent.json` is tracked by git.
 *
 * Three answers, from one `git ls-files --error-unmatch`:
 *
 * - **exit 0** — git knows the file. Tracked.
 * - **exit 1** — git is running in a repo and this path matches nothing in the
 *   index. Untracked, which is the ordinary DorkOS-owned case.
 * - **anything else** — git could not be asked (not installed, exit 128 for a
 *   dubious-ownership or broken repo, a timeout). We do not know, so we look
 *   for a `.git` above the directory and let that decide: inside a working
 *   tree, assume tracked and keep the file; outside one, there is no repo to
 *   damage and the answer is untracked. A directory that has vanished
 *   altogether skips even that — there is nothing left to protect.
 *
 * Never throws — a guard that fails loudly on unregister would be worse than
 * the deletion it exists to prevent.
 *
 * @param projectPath - The agent's project directory.
 * @param logger - Where the "git could not answer" line goes.
 * @returns `true` when the manifest must be left alone.
 */
export async function isManifestGitTracked(
  projectPath: string,
  logger: Pick<import('@dorkos/shared/logger').Logger, 'warn'>
): Promise<boolean> {
  const manifestPath = path.join(projectPath, MANIFEST_DIR, MANIFEST_FILE);
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', manifestPath], {
      cwd: projectPath,
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    if (code === 1) return false;
    // git never even started because the directory is gone (an unreachable
    // agent being swept). There is no file to protect and nothing to say.
    if (!(await exists(projectPath))) return false;
    const insideWorkingTree = await hasGitDirAbove(projectPath);
    logger.warn('[mesh] git could not say whether an agent manifest is tracked', {
      event: 'mesh.manifest.tracked_unknown',
      manifestPath,
      detail: String(code ?? (err as Error).message),
      treatingAsTracked: insideWorkingTree,
    });
    return insideWorkingTree;
  }
}

/**
 * Whether a path exists at all.
 *
 * @param target - Path to test.
 * @returns `true` when it is there.
 */
async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether any ancestor of `startPath` (itself included) holds a `.git`.
 *
 * Existence only, never `isDirectory()`: a linked worktree and a submodule both
 * carry a `.git` FILE pointing at the real git directory, and both are working
 * trees whose files DorkOS must not delete.
 *
 * @param startPath - Directory to start the upward walk from.
 * @returns `true` when a `.git` entry was found within {@link MAX_GIT_PROBE_DEPTH}.
 */
async function hasGitDirAbove(startPath: string): Promise<boolean> {
  let dir = startPath;
  for (let depth = 0; depth < MAX_GIT_PROBE_DEPTH; depth++) {
    try {
      await access(path.join(dir, '.git'));
      return true;
    } catch {
      // No `.git` here — keep climbing.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}
