/**
 * Commit a release plan through GitHub's Git Data API, so GitHub signs the
 * commit and no checkout of the release point ever runs a git hook or a tool
 * (design §3). Not wired yet: the CLI refuses `--commit` until go-live, and
 * ci-steward's `daily-release.yml` will call this with its App token.
 *
 * The caller is injected, so tests drive it with a fake and nothing here
 * reaches the network on its own. Every answer is checked before it is used,
 * and the branch ref is created, never moved: a branch that already exists is
 * an error, not something to overwrite.
 *
 * @module scripts/release/git-data
 */
import { ReleaseCommitError } from './errors.ts';
import { assertSelfCheck, releaseSubject, type ReleasePlan } from './plan.ts';

/** One GitHub REST call: method, path (`/repos/...`) and an optional JSON body. */
export type GhCaller = (
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
) => Promise<unknown>;

/** Where the release commit goes. */
export interface GitDataTarget {
  /** `owner/name`. */
  repo: string;
  /** The release point P, a full SHA; the commit's only parent. */
  parent: string;
  /** The branch to create; defaults to `release-commit/v<version>`. */
  branch?: string;
}

/** What was created. */
export interface GitDataResult {
  /** The new commit's SHA. */
  commit: string;
  /** Its tree's SHA. */
  tree: string;
  /** The ref created for it, `refs/heads/...`. */
  ref: string;
}

const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Create the blobs, the tree on top of P's tree, the commit with P as its
 * parent and no author (so GitHub signs it as the App), then the branch ref.
 */
export async function commitViaGitData(
  plan: Pick<ReleasePlan, 'version' | 'changes'>,
  gh: GhCaller,
  target: GitDataTarget
): Promise<GitDataResult> {
  if (!REPO.test(target.repo))
    throw new ReleaseCommitError(`Not an owner/name repo: ${target.repo}`);
  if (!SHA.test(target.parent))
    throw new ReleaseCommitError('The parent must be a full 40-character SHA.');
  // The same rule as the dry run, again, in case the plan was edited in between.
  assertSelfCheck(plan);
  const branch = target.branch ?? `release-commit/v${plan.version}`;
  const base = `/repos/${target.repo}/git`;

  const parent = await gh('GET', `${base}/commits/${target.parent}`);
  if (!isRecord(parent) || parent.sha !== target.parent || !isRecord(parent.tree))
    throw new ReleaseCommitError(`GitHub did not return the commit ${target.parent}.`);
  const baseTree = sha(parent.tree.sha, 'the parent tree');

  const entries: Record<string, unknown>[] = [];
  for (const change of plan.changes) {
    if (change.status === 'D') {
      entries.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    if (change.after === undefined)
      throw new ReleaseCommitError(`${change.path} is ${change.status} but has no contents.`);
    const blob = await gh('POST', `${base}/blobs`, {
      content: Buffer.from(change.after, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    entries.push({
      path: change.path,
      mode: '100644',
      type: 'blob',
      sha: sha(isRecord(blob) ? blob.sha : undefined, `the blob for ${change.path}`),
    });
  }

  const tree = await gh('POST', `${base}/trees`, { base_tree: baseTree, tree: entries });
  const treeSha = sha(isRecord(tree) ? tree.sha : undefined, 'the new tree');
  const commit = await gh('POST', `${base}/commits`, {
    message: `${releaseSubject(plan.version)}\n`,
    tree: treeSha,
    parents: [target.parent],
  });
  const commitSha = sha(isRecord(commit) ? commit.sha : undefined, 'the new commit');
  if (!isRecord(commit) || !isRecord(commit.tree) || commit.tree.sha !== treeSha)
    throw new ReleaseCommitError(`GitHub's commit ${commitSha} does not hold the tree ${treeSha}.`);
  const ref = `refs/heads/${branch}`;
  const created = await gh('POST', `/repos/${target.repo}/git/refs`, { ref, sha: commitSha });
  if (
    !isRecord(created) ||
    created.ref !== ref ||
    !isRecord(created.object) ||
    created.object.sha !== commitSha
  )
    throw new ReleaseCommitError(`GitHub did not create ${ref} at ${commitSha}.`);
  return { commit: commitSha, tree: treeSha, ref };
}

function sha(value: unknown, what: string): string {
  if (typeof value !== 'string' || !SHA.test(value))
    throw new ReleaseCommitError(`GitHub did not return a SHA for ${what}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
