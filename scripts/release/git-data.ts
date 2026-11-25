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
 * The plan was built from a checkout, which can lag P. So before writing
 * anything, P's own tree is read through the same caller and every planned
 * file's `before` must hash to P's blob for that path (an added file must be
 * absent), every file the plan only read must too, and P's fragments must be
 * exactly the ones the plan compiled.
 *
 * @module scripts/release/git-data
 */
import { createHash } from 'node:crypto';
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
  plan: Pick<ReleasePlan, 'version' | 'changes' | 'fragments' | 'inputs'>,
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
  const blobs = await readTree(gh, `${base}/trees/${baseTree}?recursive=1`, baseTree);
  assertPlanMatchesTree(plan, blobs, target.parent);

  const entries: Record<string, unknown>[] = [];
  for (const change of plan.changes) {
    if (change.status === 'D') {
      entries.push({
        path: change.path,
        mode: blobs.get(change.path)?.mode,
        type: 'blob',
        sha: null,
      });
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
      // A modified file keeps its mode (an executable stays one); an added one is plain.
      mode: blobs.get(change.path)?.mode ?? '100644',
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

/** Git's blob id for `text`: sha1 over `blob <byte length>\0` and the bytes. */
export function gitBlobSha(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

interface TreeBlob {
  sha: string;
  mode: string;
}

async function readTree(
  gh: GhCaller,
  path: string,
  treeSha: string
): Promise<Map<string, TreeBlob>> {
  const tree = await gh('GET', path);
  if (!isRecord(tree) || tree.sha !== treeSha || !Array.isArray(tree.tree))
    throw new ReleaseCommitError(`GitHub did not return the tree ${treeSha}.`);
  // A truncated listing could hide a fragment or a file the plan changes.
  if (tree.truncated !== false)
    throw new ReleaseCommitError(`GitHub returned only part of the tree ${treeSha}.`);
  const blobs = new Map<string, TreeBlob>();
  for (const entry of tree.tree)
    if (
      isRecord(entry) &&
      entry.type === 'blob' &&
      typeof entry.path === 'string' &&
      typeof entry.mode === 'string'
    )
      blobs.set(entry.path, { sha: sha(entry.sha, entry.path), mode: entry.mode });
  return blobs;
}

function assertPlanMatchesTree(
  plan: Pick<ReleasePlan, 'changes' | 'fragments' | 'inputs'>,
  blobs: ReadonlyMap<string, TreeBlob>,
  parent: string
): void {
  const lagging = (why: string) =>
    new ReleaseCommitError(
      `The plan was not built from ${parent.slice(0, 12)}: ${why}. Plan again from that commit.`
    );
  for (const change of plan.changes) {
    const inP = blobs.get(change.path);
    if (change.status === 'A') {
      if (inP) throw lagging(`${change.path} already exists there`);
      continue;
    }
    if (!inP) throw lagging(`${change.path} is not there`);
    if (change.before === undefined || gitBlobSha(change.before) !== inP.sha)
      throw lagging(`${change.path} differs there`);
  }
  // A file the plan only read (the migrations table, which can raise the
  // version) must be P's too, or the version was decided from another tree.
  for (const input of plan.inputs) {
    const inP = blobs.get(input.path);
    if (!inP || gitBlobSha(input.before) !== inP.sha) throw lagging(`${input.path} differs there`);
  }
  const fragments = [...blobs.keys()]
    .filter((path) => /^changelog\/unreleased\/[^/]+\.md$/.test(path))
    .map((path) => path.slice('changelog/unreleased/'.length))
    .sort();
  if (fragments.join('\n') !== [...plan.fragments].sort().join('\n'))
    throw lagging(
      `its fragments are ${fragments.join(', ') || 'none'}, not the ${plan.fragments.length} the plan compiled`
    );
}

function sha(value: unknown, what: string): string {
  if (typeof value !== 'string' || !SHA.test(value))
    throw new ReleaseCommitError(`GitHub did not return a SHA for ${what}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
