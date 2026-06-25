/**
 * Shared git plumbing for the workspace providers.
 *
 * Mirrors the `services/core/git-status.ts` idiom (`execFile` + timeout) and
 * computes the {@link DirtyState} that gates conservative cleanup (the safety
 * invariant that prevents the Claude Code / Cursor data-loss class).
 *
 * @module server/services/workspace/providers/git
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DirtyState } from '@dorkos/shared/workspace';

const execFileAsync = promisify(execFile);

/** Default git command timeout (ms). */
const GIT_TIMEOUT_MS = 30_000;

/** Run a git command in `cwd`, returning trimmed stdout. Throws on non-zero exit. */
export async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout;
}

/**
 * Compute the dirty state of a checkout: uncommitted (staged/unstaged) files,
 * untracked files, and commits not present on any remote (unpushed). Any of the
 * three makes the workspace "dirty" and blocks automatic removal.
 *
 * @param cwd - The checkout directory.
 */
export async function computeDirtyState(cwd: string): Promise<DirtyState> {
  const porcelain = await runGit(['status', '--porcelain=v1'], cwd);
  const lines = porcelain.split('\n').filter((l) => l.length > 0);
  const untracked = lines.filter((l) => l.startsWith('??')).map((l) => l.slice(3));
  const uncommitted = lines.filter((l) => !l.startsWith('??')).map((l) => l.slice(3));

  // Commits reachable from HEAD but not from any remote-tracking ref. Protects
  // committed-but-unpushed work; 0 for a fresh checkout sitting on a pushed base.
  let unpushed = 0;
  try {
    const out = await runGit(['rev-list', '--count', 'HEAD', '--not', '--remotes'], cwd);
    unpushed = Number.parseInt(out.trim(), 10) || 0;
  } catch {
    unpushed = 0;
  }

  return {
    dirty: untracked.length > 0 || uncommitted.length > 0 || unpushed > 0,
    uncommitted,
    untracked,
    unpushed,
  };
}
