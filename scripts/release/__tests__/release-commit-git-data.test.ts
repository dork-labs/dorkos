/**
 * `commitViaGitData` against a fake GitHub: the calls it makes, in order, and
 * every answer it refuses to build on, including a plan built from a checkout
 * that lags P. Nothing here reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitViaGitData, gitBlobSha, type GhCaller } from '../git-data.ts';
import type { ReleasePlan } from '../plan.ts';
import { fixtureRepo, type FixtureRepo } from './fixture-repo.ts';

const P = '1'.repeat(40);
const BASE_TREE = '2'.repeat(40);
const TREE = '3'.repeat(40);
const COMMIT = '4'.repeat(40);

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

/** P's tree as the plan saw it: every file it modifies or deletes, plus one it leaves alone. */
function treeOfP(): TreeEntry[] {
  return [
    { path: 'README.md', mode: '100644', type: 'blob', sha: gitBlobSha('hello\n') },
    { path: 'changelog', mode: '040000', type: 'tree', sha: '5'.repeat(40) },
    ...plan.changes.flatMap((change) =>
      change.before === undefined
        ? []
        : [{ path: change.path, mode: '100644', type: 'blob', sha: gitBlobSha(change.before) }]
    ),
  ];
}

/**
 * A fake GitHub that answers the Git Data API from {@link treeOfP} (or `tree`),
 * with `override` to break one answer.
 */
function fakeGh(
  override: (call: Call) => unknown = () => undefined,
  tree: TreeEntry[] = treeOfP()
): {
  gh: GhCaller;
  calls: Call[];
} {
  const calls: Call[] = [];
  let blobs = 0;
  const gh: GhCaller = async (method, path, body) => {
    const call: Call = { method, path, ...(body ? { body } : {}) };
    calls.push(call);
    const forced = override(call);
    if (forced !== undefined) return forced;
    if (path.endsWith(`/git/commits/${P}`)) return { sha: P, tree: { sha: BASE_TREE } };
    if (path.endsWith(`/git/trees/${BASE_TREE}?recursive=1`))
      return { sha: BASE_TREE, tree, truncated: false };
    if (path.endsWith('/git/blobs')) return { sha: (++blobs).toString(16).padStart(40, 'a') };
    if (path.endsWith('/git/trees')) return { sha: TREE };
    if (path.endsWith('/git/commits')) return { sha: COMMIT, tree: { sha: TREE } };
    if (path.endsWith('/git/refs')) return { ref: body?.ref, object: { sha: body?.sha } };
    throw new Error(`unexpected call ${method} ${path}`);
  };
  return { gh, calls };
}

let repo: FixtureRepo;
let plan: ReleasePlan;
beforeEach(() => {
  repo = fixtureRepo();
  plan = repo.plan();
});
afterEach(() => repo.cleanup());

describe('commitViaGitData', () => {
  it('builds blobs, a tree on P, an unsigned-by-us commit with P as parent, then the branch', async () => {
    const { gh, calls } = fakeGh();
    const result = await commitViaGitData(plan, gh, { repo: 'dork-labs/dorkos', parent: P });
    expect(result).toEqual({
      commit: COMMIT,
      tree: TREE,
      ref: 'refs/heads/release-commit/v0.20.1',
    });

    const written = plan.changes.filter((change) => change.status !== 'D');
    expect(
      calls.map((call) => `${call.method} ${call.path.replace('/repos/dork-labs/dorkos', '')}`)
    ).toEqual([
      `GET /git/commits/${P}`,
      `GET /git/trees/${BASE_TREE}?recursive=1`,
      ...written.map(() => 'POST /git/blobs'),
      'POST /git/trees',
      'POST /git/commits',
      'POST /git/refs',
    ]);
    const firstBlob = calls[2]?.body;
    expect(Buffer.from(String(firstBlob?.content), 'base64').toString('utf8')).toBe(
      written[0]?.after
    );

    const tree = calls.find((call) => call.path.endsWith('/git/trees'))?.body;
    expect(tree?.base_tree).toBe(BASE_TREE);
    const entries = tree?.tree as { path: string; sha: string | null }[];
    expect(entries.map((entry) => entry.path)).toEqual(plan.changes.map((change) => change.path));
    for (const change of plan.changes.filter((entry) => entry.status === 'D'))
      expect(entries.find((entry) => entry.path === change.path)?.sha).toBeNull();

    const commit = calls.find((call) => call.path.endsWith('/git/commits'))?.body;
    // No author or committer: GitHub signs a commit the App makes this way.
    expect(commit).toEqual({ message: 'chore(release): v0.20.1\n', tree: TREE, parents: [P] });
  });

  it('refuses a plan the release-branch rule would reject, before any call', async () => {
    const { gh, calls } = fakeGh();
    const tampered = {
      ...plan,
      changes: [...plan.changes, { path: 'README.md', status: 'A' as const, after: 'x' }],
    };
    await expect(
      commitViaGitData(tampered, gh, { repo: 'dork-labs/dorkos', parent: P })
    ).rejects.toThrow(/release-branch-contents/);
    expect(calls).toEqual([]);
  });

  it('refuses a short parent SHA or a malformed repo', async () => {
    const { gh } = fakeGh();
    await expect(
      commitViaGitData(plan, gh, { repo: 'dork-labs/dorkos', parent: 'abc' })
    ).rejects.toThrow(/full 40-character SHA/);
    await expect(commitViaGitData(plan, gh, { repo: 'not a repo', parent: P })).rejects.toThrow(
      /owner\/name/
    );
  });

  it('stops when GitHub answers with the wrong parent, a bad SHA or the wrong tree', async () => {
    const wrongParent = fakeGh((call) =>
      call.method === 'GET' ? { sha: COMMIT, tree: { sha: BASE_TREE } } : undefined
    );
    await expect(
      commitViaGitData(plan, wrongParent.gh, { repo: 'a/b', parent: P })
    ).rejects.toThrow(/did not return the commit/);

    const badBlob = fakeGh((call) => (call.path.endsWith('/blobs') ? { sha: 'nope' } : undefined));
    await expect(commitViaGitData(plan, badBlob.gh, { repo: 'a/b', parent: P })).rejects.toThrow(
      /SHA for the blob/
    );

    const wrongTree = fakeGh((call) =>
      call.path.endsWith('/git/commits') ? { sha: COMMIT, tree: { sha: BASE_TREE } } : undefined
    );
    await expect(commitViaGitData(plan, wrongTree.gh, { repo: 'a/b', parent: P })).rejects.toThrow(
      /does not hold the tree/
    );
    expect(wrongTree.calls.some((call) => call.path.endsWith('/git/refs'))).toBe(false);
  });

  it('refuses when the branch ref comes back different', async () => {
    const { gh } = fakeGh((call) =>
      call.path.endsWith('/git/refs')
        ? { ref: 'refs/heads/other', object: { sha: COMMIT } }
        : undefined
    );
    await expect(commitViaGitData(plan, gh, { repo: 'a/b', parent: P })).rejects.toThrow(
      /did not create/
    );
  });

  it('names a blob the way git does', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('refuses a plan from a checkout that lags P, before writing anything', async () => {
    const lagging = treeOfP().map((entry) =>
      entry.path === 'CHANGELOG.md' ? { ...entry, sha: gitBlobSha('a newer changelog\n') } : entry
    );
    const { gh, calls } = fakeGh(undefined, lagging);
    await expect(commitViaGitData(plan, gh, { repo: 'a/b', parent: P })).rejects.toThrow(
      /not built from 111111111111: CHANGELOG.md differs there/
    );
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('refuses when P already has a file the plan adds, or lacks one it changes', async () => {
    const added = plan.changes.find((change) => change.status === 'A')?.path ?? '';
    const withAdd = [...treeOfP(), { path: added, mode: '100644', type: 'blob', sha: TREE }];
    await expect(
      commitViaGitData(plan, fakeGh(undefined, withAdd).gh, { repo: 'a/b', parent: P })
    ).rejects.toThrow(/already exists there/);
    const withoutVersion = treeOfP().filter((entry) => entry.path !== 'VERSION');
    await expect(
      commitViaGitData(plan, fakeGh(undefined, withoutVersion).gh, { repo: 'a/b', parent: P })
    ).rejects.toThrow(/VERSION is not there/);
  });

  it('refuses when P holds a fragment the plan did not compile', async () => {
    const extra = [
      ...treeOfP(),
      {
        path: 'changelog/unreleased/261102-000000-late.md',
        mode: '100644',
        type: 'blob',
        sha: gitBlobSha('### Fixed\n\n- Late.\n'),
      },
    ];
    await expect(
      commitViaGitData(plan, fakeGh(undefined, extra).gh, { repo: 'a/b', parent: P })
    ).rejects.toThrow(/its fragments are .*261102-000000-late.md/);
  });

  it('refuses a truncated tree listing', async () => {
    const { gh } = fakeGh((call) =>
      call.path.includes('recursive=1')
        ? { sha: BASE_TREE, tree: treeOfP(), truncated: true }
        : undefined
    );
    await expect(commitViaGitData(plan, gh, { repo: 'a/b', parent: P })).rejects.toThrow(
      /only part of the tree/
    );
  });

  it("keeps a modified file's mode from P", async () => {
    const executable = treeOfP().map((entry) =>
      entry.path === 'VERSION' ? { ...entry, mode: '100755' } : entry
    );
    const { gh, calls } = fakeGh(undefined, executable);
    await commitViaGitData(plan, gh, { repo: 'a/b', parent: P });
    const entries = calls.find((call) => call.path.endsWith('/git/trees'))?.body?.tree as {
      path: string;
      mode: string;
    }[];
    expect(entries.find((entry) => entry.path === 'VERSION')?.mode).toBe('100755');
  });
});
