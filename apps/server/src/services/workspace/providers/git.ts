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

/**
 * Run a git command in `cwd`, returning raw stdout untrimmed. Throws on
 * non-zero exit. Callers that need trimmed output call `.trim()` themselves.
 *
 * @param args - Arguments passed to `git` (never shell-interpolated).
 * @param cwd - Directory to run in.
 * @param timeoutMs - Kill the child after this long. Provisioning can afford the
 *   30s default; a scan that blocks an HTTP response cannot, so it passes its own.
 */
export async function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs });
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
    // No remotes, or not a git checkout — the 0 default stands.
  }

  return {
    dirty: untracked.length > 0 || uncommitted.length > 0 || unpushed > 0,
    uncommitted,
    untracked,
    unpushed,
  };
}
