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
import type {
  WorktreeScanEntry,
  WorktreeScanResult,
  WorktreeScanWarning,
} from '@dorkos/shared/workspace';
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
  upstreamGone: boolean;
  changedFiles: number;
}

/**
 * Parse the porcelain v1 status of a checkout.
 *
 * The `--branch` header is the first line and has five shapes worth telling
 * apart. Every later line is one changed or untracked path.
 *
 * - `## HEAD (no branch)` — detached.
 * - `## No commits yet on main` — a real branch that has no commits.
 * - `## main` — a branch tracking nothing.
 * - `## main...origin/main [ahead 1, behind 2]` — tracking, with a divergence.
 * - `## main...origin/main [gone]` — tracking a branch that no longer exists,
 *   which is what git says once a merged pull request's remote branch is
 *   deleted. This one is the trap: it looks exactly like a tracking branch, so
 *   reading it as one reports `0 ahead, 0 behind` and the page renders "In sync"
 *   about a remote that is not there. On the machine this was built for, 19 of
 *   27 checkouts print `[gone]`, so getting it wrong would have made most of
 *   the page a confident lie.
 *
 * @param stdout - Raw output of `git status --porcelain=v1 --branch`.
 * @internal Exported for testing only.
 */
export function parseStatusSummary(stdout: string): StatusSummary {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  const header = lines.find((line) => line.startsWith('## ')) ?? '';
  const changedFiles = lines.filter((line) => !line.startsWith('## ')).length;
  const noComparison = { ahead: null, behind: null, upstreamGone: false, changedFiles };

  // A detached HEAD has no branch to name, and `HEAD (no branch)` is git's
  // literal wording for it — not a branch called "HEAD".
  if (header.startsWith('## HEAD (no branch)')) {
    return { branch: null, ...noComparison };
  }

  const body = header.slice('## '.length);

  // An unborn branch. The name is a real branch name and worth showing; what it
  // lacks is commits, which the empty last-commit column already says. Without
  // this the whole sentence lands in the branch column, beside a branch icon.
  const unborn = /^No commits yet on (.+)$/.exec(body);
  if (unborn) return { branch: unborn[1] ?? null, ...noComparison };

  const trackingStart = body.indexOf(' [');
  const refs = trackingStart === -1 ? body : body.slice(0, trackingStart);
  const tracking = trackingStart === -1 ? '' : body.slice(trackingStart);

  // `local...upstream`. Ref names cannot contain `..`, so the separator is
  // unambiguous. No separator means the branch has no upstream at all, and
  // "ahead/behind of nothing" is unknown rather than zero.
  const separator = refs.indexOf('...');
  const branch = separator === -1 ? refs : refs.slice(0, separator);
  const upstreamGone = /\[gone\]/.test(tracking);
  // A branch whose upstream was deleted has nothing to be in sync WITH, so it
  // counts as untracked for the numbers and is reported separately for a label.
  const hasUpstream = separator !== -1 && !upstreamGone;

  const ahead = hasUpstream ? Number(/ahead (\d+)/.exec(tracking)?.[1]) || 0 : null;
  const behind = hasUpstream ? Number(/behind (\d+)/.exec(tracking)?.[1]) || 0 : null;

  return { branch: branch.length > 0 ? branch : null, ahead, behind, upstreamGone, changedFiles };
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
    upstreamGone: false,
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
      upstreamGone: summary.upstreamGone,
      lastCommitAt: lastCommit.trim() || null,
      readable: true,
    };
  } catch {
    return stub;
  }
}

/** The immediate subdirectories of a directory, or the reason there are none. */
interface DirListing {
  names: string[];
  /** An errno code when the directory could not be opened at all. */
  error: string | null;
  /**
   * Symlinks whose target could not be resolved (dangling target, permission
   * denied, a symlink loop, …), each paired with the errno code that explains
   * why. `entry.isDirectory()` reports `false` for every symlink regardless of
   * its target, so a symlinked project or checkout folder — the shape `ln -s`
   * and some `gtr` layouts produce — needs its own resolution, and a resolution
   * that fails is reported here rather than silently dropped.
   */
  brokenSymlinks: Array<{ name: string; reason: string }>;
}

/**
 * List the immediate subdirectories of `dir`, treating a symlink to a
 * directory as a directory.
 *
 * A directory that cannot be OPENED is different in kind from one that is
 * empty: it hides however many checkouts were inside it, and returning `[]` for
 * both makes those checkouts vanish from the page with nothing to show for it
 * (an unreadable project folder silently dropped 7 real checkouts). `ENOENT` is
 * the one exception — a root nobody has created yet is the ordinary empty
 * state, not a fault worth reporting.
 */
async function listSubdirectories(dir: string): Promise<DirListing> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const names: string[] = [];
    const brokenSymlinks: Array<{ name: string; reason: string }> = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        names.push(entry.name);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;

      try {
        const target = await fs.stat(path.join(dir, entry.name));
        if (target.isDirectory()) names.push(entry.name);
        // A symlink to a file is not a checkout candidate; skip it silently,
        // same as any other non-directory entry.
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
        brokenSymlinks.push({ name: entry.name, reason: code });
      }
    }

    brokenSymlinks.sort((a, b) => a.name.localeCompare(b.name));
    return { names: names.sort(), error: null, brokenSymlinks };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return { names: [], error: code === 'ENOENT' ? null : code, brokenSymlinks: [] };
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
 * both the managed provider and the operator's `gtr` flow write. A symlink to a
 * directory counts as a directory at both levels, so a symlinked project or
 * checkout folder is walked rather than silently skipped. A directory with no
 * `.git` entry is not a checkout and is skipped silently (the root accumulates
 * scratch folders); anything with a `.git` is reported, readable or not. A
 * directory that could not be opened at all — or a symlink whose target could
 * not be resolved, such as a dangling one — is reported in `warnings`, because
 * whatever it held (or would have held) is missing from the list. Results are
 * ordered by project, then newest commit first.
 *
 * @param root - The resolved workspace root (`workspace.rootPath ?? <dorkHome>/workspaces`).
 */
export async function scanWorktrees(root: string): Promise<WorktreeScanResult> {
  const warnings: WorktreeScanWarning[] = [];
  const rootListing = await listSubdirectories(root);
  if (rootListing.error) warnings.push({ path: root, reason: rootListing.error });
  for (const broken of rootListing.brokenSymlinks) {
    warnings.push({ path: path.join(root, broken.name), reason: broken.reason });
  }

  const candidates: Array<{ path: string; project: string }> = [];
  for (const project of rootListing.names) {
    const projectDir = path.join(root, project);
    const listing = await listSubdirectories(projectDir);
    if (listing.error) warnings.push({ path: projectDir, reason: listing.error });
    for (const broken of listing.brokenSymlinks) {
      warnings.push({ path: path.join(projectDir, broken.name), reason: broken.reason });
    }
    for (const name of listing.names) {
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
    // rather than jumping to the top of its project. Compared as instants, not
    // as strings: `%cI` carries each committer's UTC offset, so two commits a
    // minute apart in different zones sort backwards under a text compare.
    const at = a.lastCommitAt ? Date.parse(a.lastCommitAt) : null;
    const bt = b.lastCommitAt ? Date.parse(b.lastCommitAt) : null;
    if (at !== bt) {
      if (at === null) return 1;
      if (bt === null) return -1;
      return bt - at;
    }
    return a.name.localeCompare(b.name);
  });

  return { root, worktrees, warnings };
}
