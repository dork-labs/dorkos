/**
 * Read-only adoption scan of the workspace root (DOR-1056).
 *
 * The managed layer only ever knew about checkouts it provisioned itself, and it
 * has never provisioned one — while the worktrees agents really work in land in
 * the very same root, put there by the repo's `.gtrconfig` "so the manager
 * inherits them in place". This module is the missing read side: it walks
 * `<root>/<project>/<checkout>` and reports what is actually on disk.
 *
 * Two properties are load-bearing:
 *
 * 1. **It never writes.** Every git call is a query, and `status` runs under
 *    `--no-optional-locks` so it cannot even refresh another agent's index while
 *    that agent is mid-turn. Other worktrees on this machine are live.
 * 2. **It never throws for one bad checkout.** A locked, moved, or corrupt
 *    checkout yields a row with `readable: false` instead of failing the scan.
 *    The checkout you cannot read is the one most worth seeing.
 *
 * @module server/services/workspace/worktree-scan
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorktreeScanEntry, WorktreeScanResult } from '@dorkos/shared/workspace';
import { runGit } from './providers/git.js';

/**
 * Per-git-command ceiling. Short on purpose: the scan answers an HTTP request,
 * and one wedged checkout must not hold the page. A timeout reads as unreadable.
 */
const SCAN_GIT_TIMEOUT_MS = 5_000;

/**
 * How many checkouts are inspected at once. Each one spawns three short-lived
 * `git` processes, and the root routinely holds 30+ checkouts — unbounded fan-out
 * would spawn a hundred processes on a machine already running several agents.
 */
const SCAN_CONCURRENCY = 8;

/** Parsed `git status --porcelain=v1 --branch` output. */
interface StatusSummary {
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  changedFiles: number;
}

/**
 * Parse the porcelain v1 status of a checkout.
 *
 * The `--branch` header is the first line and carries three shapes:
 * `## HEAD (no branch)` (detached), `## main` (no upstream), and
 * `## main...origin/main [ahead 1, behind 2]`. Every later line is one changed
 * or untracked path.
 *
 * @param stdout - Raw output of `git status --porcelain=v1 --branch`.
 * @internal Exported for testing only.
 */
export function parseStatusSummary(stdout: string): StatusSummary {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  const header = lines.find((line) => line.startsWith('## ')) ?? '';
  const changedFiles = lines.filter((line) => !line.startsWith('## ')).length;

  // A detached HEAD has no branch to name, and `HEAD (no branch)` is git's
  // literal wording for it — not a branch called "HEAD".
  if (header.startsWith('## HEAD (no branch)')) {
    return { branch: null, ahead: null, behind: null, changedFiles };
  }

  const body = header.slice('## '.length);
  const trackingStart = body.indexOf(' [');
  const refs = trackingStart === -1 ? body : body.slice(0, trackingStart);
  const tracking = trackingStart === -1 ? '' : body.slice(trackingStart);

  // `local...upstream`. Ref names cannot contain `..`, so the separator is
  // unambiguous. No separator means the branch has no upstream at all, and
  // "ahead/behind of nothing" is unknown rather than zero.
  const separator = refs.indexOf('...');
  const branch = separator === -1 ? refs : refs.slice(0, separator);
  const hasUpstream = separator !== -1;

  const ahead = hasUpstream ? Number(/ahead (\d+)/.exec(tracking)?.[1]) || 0 : null;
  const behind = hasUpstream ? Number(/behind (\d+)/.exec(tracking)?.[1]) || 0 : null;

  return { branch: branch.length > 0 ? branch : null, ahead, behind, changedFiles };
}

/**
 * Derive the repository a checkout shares history with, from its common git dir.
 *
 * `--git-common-dir` points at the ORIGINAL repo's `.git` for a worktree and at
 * the checkout's own `.git` for a clone, so stripping the trailing `.git` names
 * the repository in both cases.
 *
 * @param commonDir - Absolute path printed by `git rev-parse --git-common-dir`.
 * @internal Exported for testing only.
 */
export function repoPathFromCommonDir(commonDir: string): string | null {
  const trimmed = commonDir.trim();
  if (trimmed.length === 0) return null;
  return path.basename(trimmed) === '.git' ? path.dirname(trimmed) : trimmed;
}

/** Inspect one candidate directory. Never throws — failure becomes `readable: false`. */
async function inspectCheckout(checkoutPath: string, project: string): Promise<WorktreeScanEntry> {
  const stub: WorktreeScanEntry = {
    path: checkoutPath,
    name: path.basename(checkoutPath),
    project,
    repoPath: null,
    branch: null,
    changedFiles: null,
    ahead: null,
    behind: null,
    lastCommitAt: null,
    readable: false,
  };

  try {
    // `--no-optional-locks` is the whole reason this is safe to run against
    // another agent's live worktree: without it, `status` refreshes and rewrites
    // the index while that agent may be mid-command.
    const [status, lastCommit, commonDir] = await Promise.all([
      runGit(
        ['--no-optional-locks', 'status', '--porcelain=v1', '--branch'],
        checkoutPath,
        SCAN_GIT_TIMEOUT_MS
      ),
      // An unborn branch (a checkout with no commits) makes `log` exit non-zero;
      // that is a missing date, not an unreadable checkout.
      runGit(['log', '-1', '--format=%cI'], checkoutPath, SCAN_GIT_TIMEOUT_MS).catch(() => ''),
      runGit(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        checkoutPath,
        SCAN_GIT_TIMEOUT_MS
      ).catch(() => ''),
    ]);

    const summary = parseStatusSummary(status);
    return {
      ...stub,
      repoPath: repoPathFromCommonDir(commonDir),
      branch: summary.branch,
      changedFiles: summary.changedFiles,
      ahead: summary.ahead,
      behind: summary.behind,
      lastCommitAt: lastCommit.trim() || null,
      readable: true,
    };
  } catch {
    return stub;
  }
}

/** List the immediate subdirectories of `dir`, or nothing if it cannot be read. */
async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Run `task` over `items`, at most `limit` at a time, preserving input order. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Scan the workspace root for real checkouts.
 *
 * Walks two levels — `<root>/<project>/<checkout>` — because that is the layout
 * both the managed provider and the operator's `gtr` flow write. A directory
 * with no `.git` entry is not a checkout and is skipped silently (the root
 * accumulates scratch folders); anything with a `.git` is reported, readable or
 * not. Results are ordered by project, then newest commit first.
 *
 * @param root - The resolved workspace root (`workspace.rootPath ?? <dorkHome>/workspaces`).
 */
export async function scanWorktrees(root: string): Promise<WorktreeScanResult> {
  const projects = await listSubdirectories(root);

  const candidates: Array<{ path: string; project: string }> = [];
  for (const project of projects) {
    const projectDir = path.join(root, project);
    for (const name of await listSubdirectories(projectDir)) {
      const checkoutPath = path.join(projectDir, name);
      // A worktree carries a `.git` FILE (a pointer), a clone a `.git` DIRECTORY.
      // Either counts; neither means this is just a folder someone left here.
      const hasGit = await fs
        .stat(path.join(checkoutPath, '.git'))
        .then(() => true)
        .catch(() => false);
      if (hasGit) candidates.push({ path: checkoutPath, project });
    }
  }

  const worktrees = await mapBounded(candidates, SCAN_CONCURRENCY, (candidate) =>
    inspectCheckout(candidate.path, candidate.project)
  );

  worktrees.sort((a, b) => {
    if (a.project !== b.project) return a.project.localeCompare(b.project);
    // Newest work first; a checkout with no readable commit date sorts last
    // rather than jumping to the top of its project.
    if (a.lastCommitAt !== b.lastCommitAt) {
      if (!a.lastCommitAt) return 1;
      if (!b.lastCommitAt) return -1;
      return b.lastCommitAt.localeCompare(a.lastCommitAt);
    }
    return a.name.localeCompare(b.name);
  });

  return { root, worktrees };
}
