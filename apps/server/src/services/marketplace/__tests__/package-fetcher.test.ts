import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Logger } from '@dorkos/shared/logger';
import type { MarketplaceJson } from '@dorkos/marketplace';
import { PackageFetcher } from '../package-fetcher.js';
import type { MarketplaceCache, CachedPackage, CachedMarketplace } from '../marketplace-cache.js';
import type { TemplateDownloader } from '../../core/template-downloader.js';
import type { MarketplaceSource } from '../types.js';

/** Construct a fake logger that records calls for later assertion. */
function buildLogger(): Logger & { calls: { level: string; args: unknown[] }[] } {
  const calls: { level: string; args: unknown[] }[] = [];
  return {
    info: (...args: unknown[]) => calls.push({ level: 'info', args }),
    warn: (...args: unknown[]) => calls.push({ level: 'warn', args }),
    error: (...args: unknown[]) => calls.push({ level: 'error', args }),
    debug: (...args: unknown[]) => calls.push({ level: 'debug', args }),
    calls,
  };
}

/** Construct a MarketplaceCache mock with overridable method spies. */
function buildCacheMock(overrides?: {
  getPackage?: ReturnType<typeof vi.fn>;
  putPackage?: ReturnType<typeof vi.fn>;
  readMarketplace?: ReturnType<typeof vi.fn>;
  writeMarketplace?: ReturnType<typeof vi.fn>;
}): MarketplaceCache {
  return {
    getPackage: overrides?.getPackage ?? vi.fn().mockResolvedValue(null),
    putPackage:
      overrides?.putPackage ??
      vi.fn().mockImplementation(async (name: string, sha: string) => `/tmp/cache/${name}@${sha}`),
    readMarketplace: overrides?.readMarketplace ?? vi.fn().mockResolvedValue(null),
    writeMarketplace: overrides?.writeMarketplace ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as MarketplaceCache;
}

/** Construct a TemplateDownloader mock exposing a cloneRepository spy. */
function buildDownloaderMock(
  cloneImpl?: (url: string, dest: string, ref?: string) => Promise<void>
): TemplateDownloader {
  return {
    cloneRepository:
      cloneImpl !== undefined ? vi.fn(cloneImpl) : vi.fn().mockResolvedValue(undefined),
  } as unknown as TemplateDownloader;
}

/** Minimal valid MarketplaceJson document for fetchMarketplaceJson tests. */
function buildMarketplaceJson(name = 'dorkos-community'): MarketplaceJson {
  return {
    name,
    owner: { name: 'dorkos' },
    plugins: [
      {
        name: 'code-review-suite',
        source: { source: 'github', repo: 'dorkos/code-review-suite' },
      },
    ],
  };
}

/** Construct a MarketplaceSource fixture. */
function buildSource(overrides?: Partial<MarketplaceSource>): MarketplaceSource {
  return {
    name: 'dorkos-community',
    source: 'https://github.com/dorkos/marketplace.git',
    enabled: true,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PackageFetcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('fetchFromGit', () => {
    it('returns cached path without cloning when cache hit', async () => {
      const cachedPackage: CachedPackage = {
        packageName: 'my-plugin',
        commitSha: 'tmp-cached',
        path: '/tmp/cache/my-plugin@tmp-cached',
        cachedAt: new Date(),
      };
      const cache = buildCacheMock({
        getPackage: vi.fn().mockResolvedValue(cachedPackage),
      });
      const downloader = buildDownloaderMock();
      const fetcher = new PackageFetcher(cache, downloader, buildLogger());

      const result = await fetcher.fetchFromGit({
        packageName: 'my-plugin',
        gitUrl: 'https://github.com/example/my-plugin.git',
      });

      expect(result.fromCache).toBe(true);
      expect(result.path).toBe(cachedPackage.path);
      expect(downloader.cloneRepository).not.toHaveBeenCalled();
      expect(cache.putPackage).not.toHaveBeenCalled();
    });

    it('clones into reserved cache path on cache miss', async () => {
      const reservedPath = '/tmp/cache/my-plugin@tmp-abc';
      const cache = buildCacheMock({
        getPackage: vi.fn().mockResolvedValue(null),
        putPackage: vi.fn().mockResolvedValue(reservedPath),
      });
      const downloader = buildDownloaderMock();
      const fetcher = new PackageFetcher(cache, downloader, buildLogger());

      const result = await fetcher.fetchFromGit({
        packageName: 'my-plugin',
        gitUrl: 'https://github.com/example/my-plugin.git',
        ref: 'main',
      });

      expect(result.fromCache).toBe(false);
      expect(result.path).toBe(reservedPath);
      expect(cache.putPackage).toHaveBeenCalledWith('my-plugin', expect.any(String));
      expect(downloader.cloneRepository).toHaveBeenCalledWith(
        'https://github.com/example/my-plugin.git',
        reservedPath,
        'main'
      );
    });

    it('bypasses the cache hit when force: true is supplied', async () => {
      const cachedPackage: CachedPackage = {
        packageName: 'my-plugin',
        commitSha: 'tmp-cached',
        path: '/tmp/cache/my-plugin@tmp-cached',
        cachedAt: new Date(),
      };
      const reservedPath = '/tmp/cache/my-plugin@tmp-forced';
      const cache = buildCacheMock({
        getPackage: vi.fn().mockResolvedValue(cachedPackage),
        putPackage: vi.fn().mockResolvedValue(reservedPath),
      });
      const downloader = buildDownloaderMock();
      const fetcher = new PackageFetcher(cache, downloader, buildLogger());

      const result = await fetcher.fetchFromGit({
        packageName: 'my-plugin',
        gitUrl: 'https://github.com/example/my-plugin.git',
        force: true,
      });

      expect(result.fromCache).toBe(false);
      expect(result.path).toBe(reservedPath);
      expect(downloader.cloneRepository).toHaveBeenCalled();
    });
  });

  describe('fetchMarketplaceJson', () => {
    it('fetches, parses, and caches a marketplace.json document', async () => {
      const json = buildMarketplaceJson();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(json)),
      });
      vi.stubGlobal('fetch', fetchMock);

      const cache = buildCacheMock();
      const downloader = buildDownloaderMock();
      const fetcher = new PackageFetcher(cache, downloader, buildLogger());

      const result = await fetcher.fetchMarketplaceJson(buildSource());

      expect(result.name).toBe('dorkos-community');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall?.[0]).toContain('marketplace.json');
      expect(cache.writeMarketplace).toHaveBeenCalledWith('dorkos-community', expect.any(Object));
    });

    it('serves stale cache when the network fetch fails', async () => {
      const staleJson = buildMarketplaceJson('dorkos-community');
      const cached: CachedMarketplace = {
        json: staleJson,
        fetchedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        stale: true,
      };
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);

      const cache = buildCacheMock({
        readMarketplace: vi.fn().mockResolvedValue(cached),
      });
      const downloader = buildDownloaderMock();
      const logger = buildLogger();
      const fetcher = new PackageFetcher(cache, downloader, logger);

      const result = await fetcher.fetchMarketplaceJson(buildSource());

      expect(result).toBe(staleJson);
      expect(cache.readMarketplace).toHaveBeenCalledWith('dorkos-community');
      expect(cache.writeMarketplace).not.toHaveBeenCalled();
      expect(logger.calls.some((c) => c.level === 'warn')).toBe(true);
    });

    it('rethrows when both network fetch and stale cache fail', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);

      const cache = buildCacheMock({
        readMarketplace: vi.fn().mockResolvedValue(null),
      });
      const downloader = buildDownloaderMock();
      const fetcher = new PackageFetcher(cache, downloader, buildLogger());

      await expect(fetcher.fetchMarketplaceJson(buildSource())).rejects.toThrow(/network down/);
    });
  });

  describe('file:// source support', () => {
    let workDir: string;

    afterEach(async () => {
      if (workDir) {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('fetchMarketplaceJson reads a local marketplace.json from a file:// URL', async () => {
      workDir = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-file-'));
      const json = buildMarketplaceJson('personal');
      await writeFile(path.join(workDir, 'marketplace.json'), JSON.stringify(json), 'utf-8');

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const cache = buildCacheMock();
      const downloader = buildDownloaderMock();
      const fetcher = new PackageFetcher(cache, downloader, buildLogger());

      const result = await fetcher.fetchMarketplaceJson(
        buildSource({ name: 'personal', source: pathToFileURL(workDir).href })
      );

      expect(result.name).toBe('personal');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(cache.writeMarketplace).toHaveBeenCalledWith('personal', expect.any(Object));
    });

    it('fetchMarketplaceJson throws a clear error when the local marketplace.json is missing', async () => {
      workDir = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-file-'));
      // Note: do not seed marketplace.json on purpose.

      const cache = buildCacheMock();
      const downloader = buildDownloaderMock();
      const fetcher = new PackageFetcher(cache, downloader, buildLogger());

      const sourceUrl = pathToFileURL(workDir).href;
      await expect(
        fetcher.fetchMarketplaceJson(buildSource({ name: 'personal', source: sourceUrl }))
      ).rejects.toThrow(/Failed to read local marketplace at .*marketplace\.json:/);
      expect(cache.writeMarketplace).not.toHaveBeenCalled();
    });

    it('fetchMarketplaceJson throws when the local marketplace.json is invalid JSON', async () => {
      workDir = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-file-'));
      await writeFile(path.join(workDir, 'marketplace.json'), '{ not valid json', 'utf-8');

      const cache = buildCacheMock();
      const downloader = buildDownloaderMock();
      const fetcher = new PackageFetcher(cache, downloader, buildLogger());

      await expect(
        fetcher.fetchMarketplaceJson(
          buildSource({ name: 'personal', source: pathToFileURL(workDir).href })
        )
      ).rejects.toThrow();
      expect(cache.writeMarketplace).not.toHaveBeenCalled();
    });

    it('fetchFromGit returns the local directory immediately when gitUrl is file://', async () => {
      workDir = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-file-'));
      const pkgDir = path.join(workDir, 'packages', 'my-plugin');
      await mkdir(pkgDir, { recursive: true });

      const cache = buildCacheMock();
      const downloader = buildDownloaderMock();
      const fetcher = new PackageFetcher(cache, downloader, buildLogger());

      const result = await fetcher.fetchFromGit({
        packageName: 'my-plugin',
        gitUrl: pathToFileURL(pkgDir).href,
      });

      expect(result.fromCache).toBe(true);
      expect(result.commitSha).toBe('local');
      expect(result.path).toBe(pkgDir);
      expect(cache.getPackage).not.toHaveBeenCalled();
      expect(cache.putPackage).not.toHaveBeenCalled();
      expect(downloader.cloneRepository).not.toHaveBeenCalled();
    });
  });
});
