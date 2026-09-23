/**
 * Install matrix — exercises all 5 source forms through the
 * dispatch-based `PackageFetcher.fetchPackage` entry point.
 *
 * This suite is the load-bearing proof that the marketplace-05 install
 * pipeline handles every source type coherently. Each resolver is
 * independently unit-tested alongside its source file; this suite is the
 * integration-level assertion that the dispatcher routes correctly and
 * that the expected scenarios produce the expected outcomes.
 *
 * All filesystem and git interactions are faked — this suite never touches
 * the real disk or network.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginSource } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { PackageFetcher } from '../package-fetcher.js';
import { NpmSourceNotSupportedError } from '../source-resolvers/npm.js';
import type { MarketplaceCache } from '../marketplace-cache.js';
import type { GitTreeSource, TreeRequest } from '../lib/git-tree.js';

const SHA = 'a'.repeat(40);

// Module-level mock for fs/promises.access — the relative-path resolver
// uses it to verify that a subdir exists inside the marketplace clone.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
  };
});

function createFakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function createFakeCache(): MarketplaceCache {
  return {
    getPackage: vi.fn().mockResolvedValue(null),
    // Run the fetch against a temp dir (so the dispatch assertions observe
    // it) and key the entry by the commit it reports, like the real cache.
    materializePackage: vi
      .fn()
      .mockImplementation(
        async (
          name: string,
          sha: string,
          _subpath: string,
          fetch: (tempDir: string) => Promise<string>
        ) => {
          const commitSha = await fetch(`/tmp/cache/.tmp-fetch-${name}-${sha}`);
          return { path: `/tmp/cache/${name}@${commitSha}`, commitSha };
        }
      ),
    readMarketplace: vi.fn().mockResolvedValue(null),
    writeMarketplace: vi.fn().mockResolvedValue(undefined),
  } as unknown as MarketplaceCache;
}

function createFakeGit(): GitTreeSource & {
  lookup: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
} {
  return {
    lookup: vi.fn().mockResolvedValue({ kind: 'found', commitSha: SHA, refName: 'HEAD' }),
    fetch: vi.fn(async (req: TreeRequest) => req.commitSha),
  };
}

describe('install source matrix — fetchPackage dispatch', () => {
  let cache: MarketplaceCache;
  let git: ReturnType<typeof createFakeGit>;
  let logger: Logger;
  let fetcher: PackageFetcher;

  beforeEach(() => {
    cache = createFakeCache();
    git = createFakeGit();
    logger = createFakeLogger();
    fetcher = new PackageFetcher(cache, git, logger);
  });

  it('relative-path source returns sentinel commit SHA with fromCache=true', async () => {
    const source: PluginSource = './code-reviewer';
    const result = await fetcher.fetchPackage({
      packageName: 'code-reviewer',
      source,
      marketplaceRoot: '/tmp/mp',
    });

    expect(result.commitSha).toBe('relative-path');
    expect(result.fromCache).toBe(true);
    expect(result.path).toBe('/tmp/mp/code-reviewer');
    expect(git.lookup).not.toHaveBeenCalled();
    expect(git.fetch).not.toHaveBeenCalled();
  });

  it('relative-path source with explicit ./ bypasses pluginRoot', async () => {
    const result = await fetcher.fetchPackage({
      packageName: 'code-reviewer',
      source: './code-reviewer',
      marketplaceRoot: '/tmp/mp',
      pluginRoot: './plugins',
    });

    // Explicit ./ on the source bypasses pluginRoot per the resolver rules.
    expect(result.path).toBe('/tmp/mp/code-reviewer');
  });

  it('github source fetches the canonical clone URL at the default branch', async () => {
    const source: PluginSource = { source: 'github', repo: 'foo/bar' };
    const result = await fetcher.fetchPackage({
      packageName: 'bar',
      source,
    });

    expect(git.lookup).toHaveBeenCalledWith('https://github.com/foo/bar.git', 'HEAD');
    expect(git.fetch).toHaveBeenCalledTimes(1);
    expect(git.fetch.mock.calls[0]?.[0]).toMatchObject({
      cloneUrl: 'https://github.com/foo/bar.git',
      commitSha: SHA,
      subpath: '',
    });
    expect(result).toEqual({ path: `/tmp/cache/bar@${SHA}`, commitSha: SHA, fromCache: false });
  });

  it('url source passes the URL and its ref through unchanged', async () => {
    const source: PluginSource = {
      source: 'url',
      url: 'https://gitlab.com/foo/bar.git',
      ref: 'release',
    };
    await fetcher.fetchPackage({ packageName: 'bar', source });

    expect(git.lookup).toHaveBeenCalledWith('https://gitlab.com/foo/bar.git', 'release');
    expect(git.fetch.mock.calls[0]?.[0]).toMatchObject({
      cloneUrl: 'https://gitlab.com/foo/bar.git',
    });
  });

  it('git-subdir source fetches sparse and returns the package directory', async () => {
    const source: PluginSource = {
      source: 'git-subdir',
      url: 'https://github.com/foo/monorepo.git',
      path: 'plugins/qa',
    };

    const result = await fetcher.fetchPackage({ packageName: 'qa', source });

    expect(git.fetch.mock.calls[0]?.[0]).toMatchObject({
      cloneUrl: 'https://github.com/foo/monorepo.git',
      subpath: 'plugins/qa',
    });
    expect(result.path).toBe(`/tmp/cache/qa@${SHA}/plugins/qa`);
  });

  it('npm source throws NpmSourceNotSupportedError without touching cache', async () => {
    const source: PluginSource = {
      source: 'npm',
      package: '@dorkos/example',
      version: '1.0.0',
    };

    await expect(fetcher.fetchPackage({ packageName: 'example', source })).rejects.toBeInstanceOf(
      NpmSourceNotSupportedError
    );

    // The npm stub must not touch cache or git.
    expect(cache.materializePackage).not.toHaveBeenCalled();
    expect(git.fetch).not.toHaveBeenCalled();
  });

  it('NpmSourceNotSupportedError carries structured package metadata', async () => {
    const source: PluginSource = {
      source: 'npm',
      package: '@dorkos/example',
      version: '1.0.0',
    };

    let caught: unknown = null;
    try {
      await fetcher.fetchPackage({ packageName: 'example', source });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NpmSourceNotSupportedError);
    if (caught instanceof NpmSourceNotSupportedError) {
      expect(caught.package).toBe('@dorkos/example');
      expect(caught.version).toBe('1.0.0');
      expect(caught.docs).toMatch(/npm/);
    }
  });

  it('fetchPackage without source or gitUrl throws a descriptive error', async () => {
    await expect(
      fetcher.fetchPackage({ packageName: 'orphan' } as {
        packageName: string;
        source?: PluginSource;
      })
    ).rejects.toThrow(/without source or gitUrl/);
  });
});
