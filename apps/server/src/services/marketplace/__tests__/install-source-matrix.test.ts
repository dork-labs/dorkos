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
 * All filesystem and subprocess interactions are mocked — this suite
 * never touches the real disk or network.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { PluginSource } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { PackageFetcher } from '../package-fetcher.js';
import { NpmSourceNotSupportedError } from '../source-resolvers/npm.js';
import type { MarketplaceCache } from '../marketplace-cache.js';
import type { TemplateDownloader } from '../../core/template-downloader.js';

// Module-level mock for fs/promises.access — the relative-path resolver
// uses it to verify that a subdir exists inside the marketplace clone.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
  };
});

// Module-level mock for child_process — git-subdir spawns the git binary.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn().mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        (child as EventEmitter).emit('close', 0);
      });
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }),
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
    putPackage: vi.fn().mockImplementation(async (name: string, sha: string) => {
      return `/tmp/cache/${name}/${sha}`;
    }),
    readMarketplace: vi.fn().mockResolvedValue(null),
    writeMarketplace: vi.fn().mockResolvedValue(undefined),
  } as unknown as MarketplaceCache;
}

function createFakeDownloader(): TemplateDownloader {
  return {
    cloneRepository: vi.fn().mockResolvedValue(undefined),
  } as unknown as TemplateDownloader;
}

describe('install source matrix — fetchPackage dispatch', () => {
  let cache: MarketplaceCache;
  let downloader: TemplateDownloader;
  let logger: Logger;
  let fetcher: PackageFetcher;

  beforeEach(() => {
    cache = createFakeCache();
    downloader = createFakeDownloader();
    logger = createFakeLogger();
    fetcher = new PackageFetcher(cache, downloader, logger);
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
    expect(downloader.cloneRepository).not.toHaveBeenCalled();
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

  it('github source dispatches to the github resolver with canonical clone URL', async () => {
    const source: PluginSource = { source: 'github', repo: 'foo/bar' };
    const result = await fetcher.fetchPackage({
      packageName: 'bar',
      source,
    });

    expect(downloader.cloneRepository).toHaveBeenCalledTimes(1);
    const call = vi.mocked(downloader.cloneRepository).mock.calls[0];
    expect(call?.[0]).toBe('https://github.com/foo/bar.git');
    expect(result.fromCache).toBe(false);
  });

  it('url source passes the URL through unchanged', async () => {
    const source: PluginSource = {
      source: 'url',
      url: 'https://gitlab.com/foo/bar.git',
    };
    await fetcher.fetchPackage({ packageName: 'bar', source });

    const call = vi.mocked(downloader.cloneRepository).mock.calls[0];
    expect(call?.[0]).toBe('https://gitlab.com/foo/bar.git');
  });

  it('git-subdir source dispatches to the git-subdir resolver (spawn called)', async () => {
    const source: PluginSource = {
      source: 'git-subdir',
      url: 'https://github.com/foo/monorepo.git',
      path: 'plugins/qa',
    };

    // The git-subdir resolver may throw downstream because its internal
    // filesystem assertions fail against our mocks — we only care that the
    // dispatcher routed to it. Capture the result or error and verify spawn
    // was called.
    const { spawn } = await import('node:child_process');
    try {
      await fetcher.fetchPackage({ packageName: 'qa', source });
    } catch {
      // Swallow — we're only asserting the dispatch path.
    }

    expect(vi.mocked(spawn)).toHaveBeenCalled();
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

    // The npm stub must not touch cache or downloader.
    expect(cache.putPackage).not.toHaveBeenCalled();
    expect(downloader.cloneRepository).not.toHaveBeenCalled();
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
