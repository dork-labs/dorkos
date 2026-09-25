/**
 * `git-tree` against real git (DOR-2248).
 *
 * Every case builds a bare repository on disk and fetches from it over
 * `file://`, so what is asserted is what git actually does: the files that land
 * in the checkout AND the commit reported for them. A mocked git could only
 * repeat this module's own assumptions back to it, and the defect this module
 * exists to fix was exactly an assumption about git (that a clone lands on the
 * ref, that `ls-remote`'s first line is the ref, that a tag's line is a commit).
 *
 * The one production seam replaced is `hardenedGitEnv`, and only to add the
 * `file` transport (production allows `https:ssh:git`) and to isolate git from
 * the developer's own config. `protocolVersion` lets a case play a protocol-v0
 * server that refuses to serve an unadvertised commit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Protocol version the fetching side asks for; `'0'` plays an old server. */
let protocolVersion = '2';

vi.mock('../../../../lib/git-safety.js', async (importOriginal) => ({
  // The real `-c` hardening; only the environment is swapped for a local remote.
  internalGitArgs: (await importOriginal<typeof import('../../../../lib/git-safety.js')>())
    .internalGitArgs,
  hardenedGitEnv: () => ({
    ...process.env,
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'protocol.version',
    GIT_CONFIG_VALUE_0: protocolVersion,
  }),
}));

import {
  fetchTree,
  GitCommitNotFoundError,
  GitFetchError,
  isFullCommitSha,
  lookupRemoteRef,
} from '../git-tree.js';

const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

/** Run git for fixture setup and return trimmed stdout. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: FIXTURE_ENV, encoding: 'utf-8' }).trim();
}

let root: string;
let work: string;
let bare: string;
let url: string;
/** Commit ids by role, filled in by `beforeAll`. */
const c: Record<string, string> = {};

/** Write `pkg/f` and `other/g` with the given marker and commit on the current branch. */
function commit(marker: string): string {
  mkdirSync(path.join(work, 'pkg'), { recursive: true });
  mkdirSync(path.join(work, 'other'), { recursive: true });
  writeFileSync(path.join(work, 'pkg', 'f'), marker);
  writeFileSync(path.join(work, 'other', 'g'), marker);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', marker);
  return git(work, 'rev-parse', 'HEAD');
}

/**
 * Commit on `branch` (created from `main` the first time), return to `main`,
 * and publish. Each race case owns its branch, so no other ref advertises the
 * commit it leaves behind.
 */
function advance(branch: string, marker: string): string {
  const exists = git(work, 'branch', '--list', branch) !== '';
  git(work, 'checkout', '-q', ...(exists ? [branch] : ['-b', branch, 'main']));
  const sha = commit(marker);
  git(work, 'checkout', '-q', 'main');
  publish();
  return sha;
}

/** Push every branch and tag from the work tree to the bare remote. */
function publish(): void {
  git(work, 'push', '-q', '--force', 'origin', '--all');
  git(work, 'push', '-q', '--force', 'origin', '--tags');
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'git-tree-'));
  work = path.join(root, 'work');
  bare = path.join(root, 'remote.git');
  url = `file://${bare}`;
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  // Serve filtered fetches, so a subpath fetch really is a partial clone and
  // its checkout really fetches blobs lazily (a server without this ignores
  // the filter and the partial-clone path would go unexercised).
  git(bare, 'config', 'uploadpack.allowFilter', 'true');
  git(root, 'init', '-q', '-b', 'main', work);
  git(work, 'remote', 'add', 'origin', bare);

  c.first = commit('first');
  git(work, 'tag', '-a', 'v1', '-m', 'annotated');
  git(work, 'tag', 'lw1');
  c.second = commit('second');
  // Sorts before `refs/heads/main`, so `ls-remote`'s first line for `main` is
  // this branch — the tail-match trap.
  git(work, 'checkout', '-qb', 'a/main');
  c.decoy = commit('decoy');
  git(work, 'checkout', '-qb', 'develop', 'main');
  c.develop = commit('develop');
  // A tag and a branch with one name: the branch must win.
  git(work, 'tag', 'develop-or-tag', c.first);
  git(work, 'branch', 'develop-or-tag', c.develop);
  git(work, 'checkout', '-q', 'main');
  publish();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  protocolVersion = '2';
});

/** A fresh, empty destination directory. */
function dest(): string {
  return mkdtempSync(path.join(root, 'dest-'));
}

/** The marker `pkg/f` holds in a checkout. */
function markerIn(dir: string): string {
  return readFileSync(path.join(dir, 'pkg', 'f'), 'utf-8');
}

describe('isFullCommitSha', () => {
  it.each([
    ['a'.repeat(40), true],
    ['0123456789abcdef'.repeat(4), true],
    ['A'.repeat(40), false],
    ['a'.repeat(39), false],
    ['tmp-1727100000000', false],
    ['local', false],
    ['', false],
  ])('%s → %s', (value, expected) => {
    // Purpose: this is the cache's key gate, so a placeholder must fail it.
    expect(isFullCommitSha(value)).toBe(expected);
  });
});

describe('lookupRemoteRef', () => {
  it('reads HEAD as the remote default branch', async () => {
    // Purpose: a source with no ref resolves to whatever the remote's HEAD is.
    expect(await lookupRemoteRef(url, 'HEAD')).toEqual({
      kind: 'found',
      commitSha: c.second,
      refName: 'HEAD',
    });
  });

  it('follows a default branch that is not main', async () => {
    // Purpose: a ref-less source used to resolve to `main`; a repository whose
    // default branch is anything else must still install its default branch.
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/develop');
    try {
      const found = await lookupRemoteRef(url, 'HEAD');
      expect(found).toEqual({ kind: 'found', commitSha: c.develop, refName: 'HEAD' });
      const dir = dest();
      const sha = await fetchTree({
        cloneUrl: url,
        commitSha: c.develop,
        refName: 'HEAD',
        subpath: '',
        destDir: dir,
      });
      expect(sha).toBe(c.develop);
      expect(markerIn(dir)).toBe('develop');
    } finally {
      git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    }
  });

  it('matches the branch named exactly, not one ending in the same name', async () => {
    // Purpose: `ls-remote main` also returns `refs/heads/a/main`, which sorts
    // first; taking the first line recorded the decoy's commit.
    expect(await lookupRemoteRef(url, 'main')).toEqual({
      kind: 'found',
      commitSha: c.second,
      refName: 'refs/heads/main',
    });
  });

  it('resolves an annotated tag to its commit, never the tag object', async () => {
    // Purpose: the first `ls-remote` line for an annotated tag is the tag
    // object; the pin must be the commit the tree comes from.
    expect(await lookupRemoteRef(url, 'v1')).toEqual({
      kind: 'found',
      commitSha: c.first,
      refName: 'refs/tags/v1',
    });
  });

  it('resolves a lightweight tag and a full refname', async () => {
    // Purpose: a tag with no peeled line is its own commit; a `refs/…` name is
    // taken as written.
    expect(await lookupRemoteRef(url, 'lw1')).toMatchObject({ commitSha: c.first });
    expect(await lookupRemoteRef(url, 'refs/tags/v1')).toEqual({
      kind: 'found',
      commitSha: c.first,
      refName: 'refs/tags/v1',
    });
  });

  it('prefers a branch over a tag of the same name', async () => {
    // Purpose: the order `git clone --branch` uses; git fetch's own DWIM would
    // pick the tag, so the lookup must name the refname it chose.
    expect(await lookupRemoteRef(url, 'develop-or-tag')).toEqual({
      kind: 'found',
      commitSha: c.develop,
      refName: 'refs/heads/develop-or-tag',
    });
  });

  it('returns a full commit id as itself without asking the remote', async () => {
    // Purpose: a pinned `sha` matches no ref name; asking ls-remote for it is
    // what degraded pins to a `tmp-` placeholder.
    expect(await lookupRemoteRef(`file://${root}/nowhere.git`, c.first)).toEqual({
      kind: 'found',
      commitSha: c.first,
    });
  });

  it('says missing when the remote answers without the ref', async () => {
    // Purpose: a typo'd ref is a plain "no such ref", not a network failure.
    expect(await lookupRemoteRef(url, 'nope')).toEqual({ kind: 'missing' });
    // Tail-matching must not rescue a name that only ends another ref.
    expect(await lookupRemoteRef(url, 'a')).toEqual({ kind: 'missing' });
  });

  it('says unreachable when git cannot read the remote', async () => {
    // Purpose: distinguishes "no such ref" from "couldn't ask".
    const result = await lookupRemoteRef(`file://${root}/nowhere.git`, 'main');
    expect(result.kind).toBe('unreachable');
  });
});

describe('fetchTree', () => {
  it('checks out the default branch and removes .git', async () => {
    // Purpose: the entry holds the tree and nothing else.
    const dir = dest();
    const sha = await fetchTree({
      cloneUrl: url,
      commitSha: c.second,
      refName: 'HEAD',
      subpath: '',
      destDir: dir,
    });
    expect(sha).toBe(c.second);
    expect(markerIn(dir)).toBe('second');
    expect(existsSync(path.join(dir, 'other', 'g'))).toBe(true);
    expect(existsSync(path.join(dir, '.git'))).toBe(false);
  });

  it('checks out a non-default branch', async () => {
    // Purpose: whole-repo sources used to drop the ref and install the
    // default branch under the branch's commit.
    const dir = dest();
    const sha = await fetchTree({
      cloneUrl: url,
      commitSha: c.develop,
      refName: 'refs/heads/develop',
      subpath: '',
      destDir: dir,
    });
    expect(sha).toBe(c.develop);
    expect(markerIn(dir)).toBe('develop');
  });

  it('checks out a pinned commit that is no branch tip, sparse to its subpath', async () => {
    // Purpose: git-subdir cloned the default branch at depth 1 and could not
    // check out an older commit; and only the package's directory is kept.
    const dir = dest();
    const sha = await fetchTree({
      cloneUrl: url,
      commitSha: c.first,
      subpath: 'pkg',
      destDir: dir,
    });
    expect(sha).toBe(c.first);
    expect(markerIn(dir)).toBe('first');
    expect(existsSync(path.join(dir, 'other'))).toBe(false);
    expect(existsSync(path.join(dir, '.git'))).toBe(false);
  });

  it('fetches the looked-up commit even after the branch moves', async () => {
    // Purpose: the lookup→fetch race. Fetching by commit means a push in
    // between cannot change what lands.
    const looked = advance('race-v2', 'race-v2-looked');
    const before = (await lookupRemoteRef(url, 'race-v2')) as {
      commitSha: string;
      refName: string;
    };
    expect(before.commitSha).toBe(looked);
    const moved = advance('race-v2', 'race-v2-moved');

    const dir = dest();
    const sha = await fetchTree({ cloneUrl: url, ...before, subpath: '', destDir: dir });
    expect(sha).toBe(looked);
    expect(sha).not.toBe(moved);
    expect(markerIn(dir)).toBe('race-v2-looked');
  });

  describe('on a server that refuses unadvertised commits (protocol v0)', () => {
    beforeAll(() => {
      git(bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'false');
      git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'false');
    });

    beforeEach(() => {
      protocolVersion = '0';
    });

    it('falls back to the refname and reports the commit that arrived', async () => {
      // Purpose: once the looked-up commit is no longer a tip, this server will
      // not serve it; the fallback fetches the ref and keys by what arrived,
      // which is the tree on disk — never the stale looked-up commit.
      const looked = advance('race-v0', 'race-v0-looked');
      const before = (await lookupRemoteRef(url, 'race-v0')) as {
        commitSha: string;
        refName: string;
      };
      const moved = advance('race-v0', 'race-v0-moved');

      const dir = dest();
      const sha = await fetchTree({ cloneUrl: url, ...before, subpath: '', destDir: dir });
      expect(before.commitSha).toBe(looked);
      expect(sha).toBe(moved);
      expect(markerIn(dir)).toBe('race-v0-moved');
    });

    it('fetches an annotated tag by its refname and checks out its commit', async () => {
      // Purpose: the refname fallback must peel the tag, not stop at it.
      const dir = dest();
      const sha = await fetchTree({
        cloneUrl: url,
        commitSha: 'f'.repeat(40),
        refName: 'refs/tags/v1',
        subpath: 'pkg',
        destDir: dir,
      });
      expect(sha).toBe(c.first);
      expect(markerIn(dir)).toBe('first');
    });

    it('falls back to the exact refname, so a branch beats a tag of the same name', async () => {
      // Purpose: a bare name would let git's own lookup pick the tag (tags
      // come first there); the fallback must fetch the branch the lookup chose.
      const dir = dest();
      const sha = await fetchTree({
        cloneUrl: url,
        commitSha: 'f'.repeat(40),
        refName: 'refs/heads/develop-or-tag',
        subpath: 'pkg',
        destDir: dir,
      });
      expect(sha).toBe(c.develop);
      expect(markerIn(dir)).toBe('develop');
    });

    it('finds a pinned commit through the branches and tags, sparse to its subpath', async () => {
      // Purpose: the pin fallback fetches every blob it needs; a filtered one
      // would leave the checkout asking this same server for blobs it refuses.
      const dir = dest();
      const sha = await fetchTree({
        cloneUrl: url,
        commitSha: c.first,
        subpath: 'pkg',
        destDir: dir,
      });
      expect(sha).toBe(c.first);
      expect(markerIn(dir)).toBe('first');
      expect(existsSync(path.join(dir, 'other'))).toBe(false);
    });

    it('finds a pinned commit through the branches and tags', async () => {
      // Purpose: a pin has no refname to fall back to; it must still install
      // the exact commit it names.
      const dir = dest();
      const sha = await fetchTree({ cloneUrl: url, commitSha: c.first, subpath: '', destDir: dir });
      expect(sha).toBe(c.first);
      expect(markerIn(dir)).toBe('first');
    });

    it('refuses a pinned commit the repository does not have', async () => {
      // Purpose: never a silent downgrade to some other commit.
      await expect(
        fetchTree({ cloneUrl: url, commitSha: 'e'.repeat(40), subpath: '', destDir: dest() })
      ).rejects.toBeInstanceOf(GitCommitNotFoundError);
    });
  });

  it('fails plainly when the remote cannot be read', async () => {
    // Purpose: a failed fetch is an error, never an empty or partial tree.
    await expect(
      fetchTree({
        cloneUrl: `file://${root}/nowhere.git`,
        commitSha: c.first,
        subpath: '',
        destDir: dest(),
      })
    ).rejects.toBeInstanceOf(GitFetchError);
  });
});
