/**
 * What a repo's settings are compared against (DOR-3298): the commit its
 * default branch points at, as DorkOS resolved and recorded it.
 *
 * ## Resolving it
 *
 * The repo top comes from `git rev-parse --show-toplevel` in the turn's folder.
 * The default branch is what `origin/HEAD` names, else `origin/main`, else a
 * local `main` or `master` (`repo-git.ts`).
 *
 * ## Pinning it
 *
 * An agent with a shell can move any ref in its repo (`git update-ref`), and
 * can point a worktree's `.git` at a repo it made, so neither the branch nor
 * the repo is trusted on its word. DorkOS records the commit it last compared
 * each repo against (`harness.repoBaselines`, operator-only, keyed by the real
 * path of the repo's shared git folder so every worktree shares one record):
 *
 * - **A repo with no record** gives no baseline: everything counts as changed,
 *   so its hooks pause and one card asks to trust it. The upgrade pins the
 *   repos DorkOS already knew (`pin-repo-baselines.ts`), so only repos first
 *   seen after it ask. **Residual:** anything planted in those before the
 *   upgrade was pinned with them.
 * - **A branch that moved forward** (the recorded commit is in its history) is
 *   taken without asking only when nothing its hooks would run changed between
 *   the two commits (`repo-baseline-move.ts`). Otherwise, as for a branch that
 *   moved anywhere else or does not resolve, there is no baseline and a card
 *   asks. A person's yes on that card records the new commit.
 *
 * **Residual:** config an unchanged hook reads, which DOR-3339's own copy of
 * the default branch does not close either.
 *
 * ## Older versions count too
 *
 * The worktree is unchanged when every file matches the default branch's
 * commit, OR every file matches the commit its branch started from
 * (`git merge-base HEAD <commit>`): one commit for all of them, never a mix no
 * single commit holds. The second counts only when it is in the pinned
 * commit's own history, so a commit an agent made on top and then "reverted"
 * on the way to the tip is never trusted as a fork point (DOR-3298 M2).
 * Without it, every worktree started before the last hook change on the
 * default branch would pause for nothing.
 *
 * ## Without git
 *
 * Not in a repo: no baseline, so any hook, script or `.mcp.json` counts as
 * changed. Git not installed at all: logged once, and only `settings.local.json`
 * is checked, since there is nothing to compare the rest against.
 *
 * @module services/runtimes/claude-code/repo-settings/repo-baseline
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../../../../lib/logger.js';
import { hooksChangedBetween } from './repo-baseline-move.js';
import { recordBaseline, recordedBaseline, type RecordedBaseline } from './repo-config-consent.js';
import {
  GitMissingError,
  isAncestor,
  locateRepo,
  mergeBase,
  readBlob,
  resolveDefaultBranch,
} from './repo-git.js';
import { listTreeThroughLinks } from './repo-tree-links.js';

/** Why there is no trusted commit to compare against. */
export type UntrustedReason =
  'not-a-repo' | 'no-default-branch' | 'first-seen' | 'moved' | 'hooks-moved';

/** One file as the baseline has it. */
export interface BaselineFile {
  /** Its blob id. */
  oid: string;
  /** Its git mode (`100644`, `100755`, `120000` for a symlink). */
  mode: string;
}

/** What a folder's repo settings are compared against. */
export interface RepoBaseline {
  /** `no-git` when git is not installed; the caller then checks only local settings. */
  status: 'compared' | 'no-git';
  /** The repo's working tree top, or the folder itself outside a repo. */
  root: string;
  /** The repo's shared git folder, by real path, when in a repo. */
  commonDir?: string;
  /** The trusted commits, newest first: the default branch's, then where HEAD started from it. */
  commits: string[];
  /** Why {@link commits} is empty, when it is. */
  untrusted?: UntrustedReason;
  /** The default branch as it resolved, untrusted or not: what a yes records. */
  candidate?: RecordedBaseline;
  /** The length of an object id in this repo (40, or 64 for sha256). */
  oidLength: number;
}

/** Logged once per process: git is not installed. */
let warnedNoGit = false;

/** A path by its real path, or resolved when it is not there. */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Resolve what `cwd`'s repo settings are compared against, and move the
 * recorded commit forward when the default branch did and its hooks did not.
 *
 * @param cwd - The folder the turn launches in.
 * @param dorkHome - DorkOS's data folder, whose `plugins/` scripts are not the repo's.
 */
export async function resolveRepoBaseline(cwd: string, dorkHome: string): Promise<RepoBaseline> {
  let repo;
  try {
    repo = await locateRepo(cwd);
  } catch (err) {
    if (!(err instanceof GitMissingError)) throw err;
    if (!warnedNoGit) {
      warnedNoGit = true;
      logger.warn('[RepoConfig] git is not installed; only local settings are checked');
    }
    return { status: 'no-git', root: cwd, commits: [], oidLength: 40 };
  }
  if (!repo) {
    return { status: 'compared', root: cwd, commits: [], untrusted: 'not-a-repo', oidLength: 40 };
  }
  const commonDir = real(repo.commonDir);
  const base = { status: 'compared' as const, root: repo.root, commonDir };
  const branch = await resolveDefaultBranch(repo.root);
  if (!branch) return { ...base, commits: [], untrusted: 'no-default-branch', oidLength: 40 };
  const oidLength = branch.sha.length;
  const recorded = recordedBaseline(commonDir);
  const untrusted = (reason: UntrustedReason, message: string): RepoBaseline => {
    logger.warn(message, { repo: repo.root, branch: branch.branch });
    return { ...base, commits: [], untrusted: reason, candidate: branch, oidLength };
  };
  if (!recorded) {
    return untrusted('first-seen', '[RepoConfig] A repo DorkOS has not pinned; its hooks wait');
  }
  if (recorded.sha !== branch.sha) {
    if (!(await isAncestor(repo.root, recorded.sha, branch.sha))) {
      return untrusted('moved', "[RepoConfig] A repo's default branch moved off its pinned commit");
    }
    let hooksMoved = true;
    try {
      hooksMoved = await hooksChangedBetween(repo.root, recorded.sha, branch.sha, dorkHome);
    } catch {
      // A comparison git couldn't make counts as a change.
    }
    if (hooksMoved) {
      return untrusted('hooks-moved', "[RepoConfig] A repo's default branch changed its hooks");
    }
    try {
      recordBaseline(commonDir, branch);
    } catch (err) {
      logger.warn('[RepoConfig] Could not record the commit a repo was compared against', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const fork = await mergeBase(repo.root, 'HEAD', branch.sha);
  const reviewedFork =
    fork !== null &&
    fork !== branch.sha &&
    (fork === recorded.sha || (await isAncestor(repo.root, fork, recorded.sha)));
  const commits = reviewedFork ? [branch.sha, fork] : [branch.sha];
  return { ...base, commits, candidate: branch, oidLength };
}

/**
 * Pin a folder's repo to the commit its default branch points at now, when
 * DorkOS has no record for that repo yet. A repo pinned here is trusted as it
 * stands, so only the upgrade calls this, for repos DorkOS already knew.
 *
 * @param folder - Any folder inside the repo.
 * @returns Whether a new record was written.
 * @throws {GitMissingError} When git is not installed.
 */
export async function pinRepoBaseline(folder: string): Promise<boolean> {
  const repo = await locateRepo(folder);
  if (!repo) return false;
  const commonDir = real(repo.commonDir);
  if (recordedBaseline(commonDir)) return false;
  const branch = await resolveDefaultBranch(repo.root);
  if (!branch) return false;
  recordBaseline(commonDir, branch);
  return true;
}

/** The files a baseline has at some paths, per trusted commit. */
export interface BaselineTrees {
  /** One map per trusted commit, in {@link RepoBaseline.commits} order. */
  trees: Map<string, BaselineFile>[];
  /** Read one blob's text. */
  read: (oid: string) => Promise<string>;
}

/**
 * List `paths` (repo-relative files or folders) in every trusted commit.
 *
 * @param baseline - What the repo is compared against.
 * @param paths - What to list.
 */
export async function baselineTrees(
  baseline: RepoBaseline,
  paths: readonly string[]
): Promise<BaselineTrees> {
  // Through the links in each commit, as the worktree reads them: a skill
  // Harness Sync links in from `.agents/skills` is otherwise never found.
  const trees = await Promise.all(
    baseline.commits.map((commit) => listTreeThroughLinks(baseline.root, commit, paths))
  );
  return {
    trees,
    read: async (oid) => (await readBlob(baseline.root, oid)).toString('utf8'),
  };
}
