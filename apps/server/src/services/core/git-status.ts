import { runSafeGit } from '@dorkos/shared/safe-git';
import type { GitStatusResponse, GitStatusError } from '@dorkos/shared/types';
import { GIT } from '../../config/constants.js';
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';
// Git's kill switch, as the computer-side files directly in `core/` read it (git
// status and the file lister; spec `computer-side-starts-alone` §5.3). Only the
// one answer is held here, never the agent facts port, so nothing else about an
// agent is reachable through this file. It stays here rather than in a file of
// its own because `services/core/` is at its file limit, and rather than in
// `core/agent-identity/facts/` because importing that would cross the computer
// wall. Startup fills it from the port (`startup/agent-facts.ts`); unwired,
// git runs nowhere.
let gitGuard: ((dir: string) => boolean) | undefined;

/**
 * Hand this code git's kill switch, or clear it.
 *
 * @param next - Whether DorkOS may run git in a folder, or `undefined` to clear it.
 */
export function setGitGuard(next: ((dir: string) => boolean) | undefined): void {
  gitGuard = next;
}

/**
 * Whether DorkOS may run git in a folder: the kill switch startup hands over,
 * or no before it does.
 *
 * @param dir - The folder git would run in.
 */
export function mayRunGitIn(dir: string): boolean {
  return gitGuard ? gitGuard(dir) : false;
}

/**
 * Git repository status via `git status --porcelain=v1`.
 *
 * Parses branch, tracking, ahead/behind counts, and file change counts.
 * Returns `GitStatusError` for non-git directories.
 *
 * @module services/git-status
 */

/**
 * Get git status for a working directory.
 *
 * **Never in an agent folder** (DOR-3343; rooms since spec `agent-home-desk`
 * I3): an agent home, a workspace, a worktree or a room. Agents can write those
 * repositories' git settings, and `git status` can run a program they name (a
 * clean filter). The rooms domain reads its own repositories through
 * `room-repo-git.ts`, which audits those settings first; this general reader —
 * the per-turn context and `GET /api/git/status` — answers "not a repository"
 * there without running git at all.
 *
 * @param cwd - Directory to check (must be inside a git repo)
 */
export async function getGitStatus(cwd: string): Promise<GitStatusResponse | GitStatusError> {
  if (!mayRunGitIn(cwd)) return { error: 'not_git_repo' as const };
  try {
    await validateBoundary(cwd);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return { error: 'not_git_repo' as const };
    }
    throw err;
  }

  try {
    const stdout = await runSafeGit(['status', '--porcelain=v1', '--branch'], cwd, {
      timeoutMs: GIT.STATUS_TIMEOUT_MS,
    });
    return parsePorcelainOutput(stdout);
  } catch {
    return { error: 'not_git_repo' as const };
  }
}

const CONFLICT_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
const STAGED_CODES = new Set(['M', 'A', 'D', 'R', 'C']);

/**
 * Parse `git status --porcelain=v1 --branch` output into structured data.
 *
 * @internal Exported for testing only.
 */
export function parsePorcelainOutput(stdout: string): GitStatusResponse {
  const lines = stdout.split('\n').filter(Boolean);

  let branch = '';
  let tracking: string | null = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;

  let modified = 0;
  let staged = 0;
  let untracked = 0;
  let conflicted = 0;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const branchLine = line.slice(3);

      // Detached HEAD
      if (branchLine.startsWith('HEAD (no branch)')) {
        detached = true;
        branch = 'HEAD';
        continue;
      }

      // Extract ahead/behind from bracket notation
      const bracketMatch = branchLine.match(/\[(.+)\]/);
      if (bracketMatch) {
        const info = bracketMatch[1];
        const aheadMatch = info.match(/ahead (\d+)/);
        const behindMatch = info.match(/behind (\d+)/);
        if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
        if (behindMatch) behind = parseInt(behindMatch[1], 10);
      }

      // Extract branch and tracking
      const branchPart = branchLine.replace(/\s*\[.*\]/, '');
      const dotIndex = branchPart.indexOf('...');
      if (dotIndex !== -1) {
        branch = branchPart.slice(0, dotIndex);
        tracking = branchPart.slice(dotIndex + 3);
      } else {
        branch = branchPart;
      }

      continue;
    }

    // File status lines: XY filename
    const x = line[0];
    const y = line[1];
    const code = `${x}${y}`;

    if (code === '??') {
      untracked++;
    } else if (CONFLICT_CODES.has(code)) {
      conflicted++;
    } else {
      if (STAGED_CODES.has(x)) staged++;
      if (y === 'M' || y === 'D') modified++;
    }
  }

  const clean = modified === 0 && staged === 0 && untracked === 0 && conflicted === 0;

  return {
    branch,
    ahead,
    behind,
    modified,
    staged,
    untracked,
    conflicted,
    clean,
    detached,
    tracking,
  };
}
