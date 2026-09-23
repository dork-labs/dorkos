/**
 * `PackageFetcher` end to end against real git and a real cache (DOR-2248).
 *
 * The unit suites fake one side each. This one fakes neither: a bare
 * repository on disk, the real `gitTreeSource`, the real `MarketplaceCache`.
 * What it proves is the promise the cache key makes — an entry
 * `<name>@<sha>` holds exactly commit `<sha>`'s tree — including for a commit
 * that is no longer any branch's tip, which is what rebuilding an older
 * install's record needs (DOR-2245).
 *
 * Two seams are opened, and only for this suite's own repository: the
 * transport allowlist gains `file` (production allows `https:ssh:git`), and
 * the address policy lets the repository's absolute path through. Addressing
 * it by path rather than `file://` keeps it on the git path: a `file://`
 * address is served in place as a local folder.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';

let protocolVersion = '2';
const root = mkdtempSync(path.join(tmpdir(), 'pkg-fetcher-git-'));

vi.mock('../../../lib/git-safety.js', () => ({
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

vi.mock('../source-url-policy.js', async () => {
  const actual =
    await vi.importActual<typeof import('../source-url-policy.js')>('../source-url-policy.js');
  return {
    ...actual,
    // This suite's own repository, and nothing else, gets past the door.
    assertSafeGitRemote: (url: string) => {
      if (!url.startsWith(root)) actual.assertSafeGitRemote(url);
    },
  };
});

import { MarketplaceCache } from '../marketplace-cache.js';
import { PackageFetcher } from '../package-fetcher.js';
import { GitCommitNotFoundError, gitTreeSource } from '../lib/git-tree.js';

const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: FIXTURE_ENV, encoding: 'utf-8' }).trim();
}

const work = path.join(root, 'work');
const bare = path.join(root, 'remote.git');
let older: string;
let tip: string;
let develop: string;

/** Write the package and a sibling directory, commit, and return the commit. */
function commit(marker: string): string {
  mkdirSync(path.join(work, 'plugins', 'flow'), { recursive: true });
  mkdirSync(path.join(work, 'docs'), { recursive: true });
  writeFileSync(path.join(work, 'plugins', 'flow', 'version'), marker);
  writeFileSync(path.join(work, 'docs', 'readme'), marker);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', marker);
  return git(work, 'rev-parse', 'HEAD');
}

beforeAll(() => {
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'init', '-q', '-b', 'main', work);
  git(work, 'remote', 'add', 'origin', bare);
  older = commit('0.5.0');
  tip = commit('0.7.2');
  git(work, 'checkout', '-qb', 'develop');
  develop = commit('0.8.0-dev');
  git(work, 'checkout', '-q', 'main');
  git(work, 'push', '-q', 'origin', '--all');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let dorkHome: string;
let cache: MarketplaceCache;
let fetcher: PackageFetcher;

beforeEach(() => {
  protocolVersion = '2';
  dorkHome = mkdtempSync(path.join(root, 'home-'));
  cache = new MarketplaceCache(dorkHome);
  fetcher = new PackageFetcher(cache, gitTreeSource, noopLogger);
});

const monorepoKey = () => ({ cloneUrl: bare, subpath: 'plugins/flow', ref: 'HEAD' });

describe('fetchAtCommit — an install recorded at a commit main has moved past', () => {
  it('caches exactly that commit for a git-subdir source', async () => {
    // Purpose: the DOR-2245 case — flow installed at an older marketplace
    // commit, rebuilt after main moved on. A clone of the tip was the old
    // behaviour; the tree must be the recorded commit's.
    expect(older).not.toBe(tip);
    const result = await fetcher.fetchAtCommit({
      packageName: 'flow',
      sourceKey: monorepoKey(),
      commitSha: older,
    });

    const entry = path.join(cache.cacheRoot, 'trees', `flow@${older}`);
    expect(result).toEqual({
      path: path.join(entry, 'plugins/flow'),
      commitSha: older,
      fromCache: false,
    });
    expect(readFileSync(path.join(result.path, 'version'), 'utf-8')).toBe('0.5.0');
    expect(existsSync(path.join(entry, 'docs'))).toBe(false);
    expect(existsSync(path.join(entry, '.git'))).toBe(false);
  });

  it('caches exactly that commit for a whole-repository source', async () => {
    const result = await fetcher.fetchAtCommit({
      packageName: 'whole',
      sourceKey: { cloneUrl: bare, subpath: '', ref: 'refs/heads/main' },
      commitSha: older,
    });
    expect(result.commitSha).toBe(older);
    expect(readFileSync(path.join(result.path, 'plugins', 'flow', 'version'), 'utf-8')).toBe(
      '0.5.0'
    );
    expect(readFileSync(path.join(result.path, 'docs', 'readme'), 'utf-8')).toBe('0.5.0');
  });

  it('serves the second request from the cache', async () => {
    await fetcher.fetchAtCommit({
      packageName: 'flow',
      sourceKey: monorepoKey(),
      commitSha: older,
    });
    const again = await fetcher.fetchAtCommit({
      packageName: 'flow',
      sourceKey: monorepoKey(),
      commitSha: older,
    });
    expect(again.fromCache).toBe(true);
    expect(again.commitSha).toBe(older);
  });

  it('still works on a server that refuses to serve a commit by id', async () => {
    // Purpose: the fallback for a pin — fetch branches and tags, then require
    // the commit — never a quiet install of the tip instead.
    git(bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'false');
    git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'false');
    protocolVersion = '0';
    try {
      const result = await fetcher.fetchAtCommit({
        packageName: 'flow',
        sourceKey: monorepoKey(),
        commitSha: older,
      });
      expect(result.commitSha).toBe(older);
      expect(readFileSync(path.join(result.path, 'version'), 'utf-8')).toBe('0.5.0');
    } finally {
      git(bare, 'config', '--unset', 'uploadpack.allowReachableSHA1InWant');
      git(bare, 'config', '--unset', 'uploadpack.allowAnySHA1InWant');
    }
  });

  it('fails plainly, caching nothing, for a commit the repository does not have', async () => {
    const missing = 'e'.repeat(40);
    await expect(
      fetcher.fetchAtCommit({ packageName: 'flow', sourceKey: monorepoKey(), commitSha: missing })
    ).rejects.toBeInstanceOf(GitCommitNotFoundError);
    expect(await cache.listPackages()).toEqual([]);
  });

  it('refuses anything but a full commit id', async () => {
    // Purpose: an abbreviated id could name a different commit tomorrow.
    await expect(
      fetcher.fetchAtCommit({
        packageName: 'flow',
        sourceKey: monorepoKey(),
        commitSha: older.slice(0, 12),
      })
    ).rejects.toThrow(/not a full commit id/);
  });
});

describe('fetchPackage — a named ref, end to end', () => {
  it('installs the branch the source names, keyed by its commit', async () => {
    // Purpose: whole-repo sources used to ignore the ref and cache the
    // default branch under the ref's commit.
    const result = await fetcher.fetchPackage({
      packageName: 'flow',
      source: { source: 'url', url: bare, ref: 'develop' },
    });
    expect(result.commitSha).toBe(develop);
    expect(result.path).toBe(path.join(cache.cacheRoot, 'trees', `flow@${develop}`));
    expect(readFileSync(path.join(result.path, 'plugins', 'flow', 'version'), 'utf-8')).toBe(
      '0.8.0-dev'
    );
  });

  it('installs the default branch when the source names no ref', async () => {
    const result = await fetcher.fetchPackage({
      packageName: 'flow',
      source: { source: 'git-subdir', url: bare, path: 'plugins/flow' },
    });
    expect(result.commitSha).toBe(tip);
    expect(readFileSync(path.join(result.path, 'version'), 'utf-8')).toBe('0.7.2');
  });
});
