import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitStatusResponse, GitStatusError } from '@dorkos/shared/types';
import { GIT } from '../../config/constants.js';
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';

/**
 * Git repository status via `git status --porcelain=v1`.
 *
 * Parses branch, tracking, ahead/behind counts, and file change counts.
 * Returns `GitStatusError` for non-git directories.
 *
 * @module services/git-status
 */
const execFileAsync = promisify(execFile);

/**
 * Get git status for a working directory.
 *
 * @param cwd - Directory to check (must be inside a git repo)
 */
export async function getGitStatus(cwd: string): Promise<GitStatusResponse | GitStatusError> {
  try {
    await validateBoundary(cwd);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return { error: 'not_git_repo' as const };
    }
    throw err;
  }

  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--branch'], {
      cwd,
      timeout: GIT.STATUS_TIMEOUT_MS,
    });
    return parsePorcelainOutput(stdout);
  } catch {
    return { error: 'not_git_repo' as const };
  }
}

const CONFLICT_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
const STAGED_CODES = new Set(['M', 'A', 'D', 'R', 'C']);

/** @internal Parse `git status --porcelain=v1 --branch` output into structured data. */
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
