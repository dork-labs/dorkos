import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, stat, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketplaceJson } from '@dorkos/marketplace';
import { MarketplaceCache } from '../marketplace-cache.js';

/** Build a minimal valid MarketplaceJson document for round-trip tests. */
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

describe('MarketplaceCache', () => {
  let dorkHome: string;
  let cache: MarketplaceCache;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'marketplace-cache-'));
    cache = new MarketplaceCache(dorkHome);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dorkHome, { recursive: true, force: true });
  });

  describe('cacheRoot', () => {
    it('points at ${dorkHome}/cache/marketplace', () => {
      expect(cache.cacheRoot).toBe(join(dorkHome, 'cache', 'marketplace'));
    });
  });

  describe('readMarketplace', () => {
    it('returns null when the marketplace has never been cached', async () => {
      const result = await cache.readMarketplace('dorkos-community');
      expect(result).toBeNull();
    });

    it('returns null when cached marketplace.json is malformed', async () => {
      const dir = join(cache.cacheRoot, 'marketplaces', 'dorkos-community');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'marketplace.json'), '{not json');
      await writeFile(join(dir, '.last-fetched'), new Date().toISOString());

      const result = await cache.readMarketplace('dorkos-community');
      expect(result).toBeNull();
    });
  });

  describe('writeMarketplace + readMarketplace round-trip', () => {
    it('round-trips a freshly written marketplace with stale=false', async () => {
      const json = buildMarketplaceJson();
      await cache.writeMarketplace('dorkos-community', json);

      const result = await cache.readMarketplace('dorkos-community');
      expect(result).not.toBeNull();
      expect(result!.json.name).toBe('dorkos-community');
      expect(result!.json.plugins[0]?.name).toBe('code-review-suite');
      expect(result!.stale).toBe(false);
      expect(result!.fetchedAt).toBeInstanceOf(Date);
    });

    it('writes .last-fetched after marketplace.json (atomic ordering)', async () => {
      const json = buildMarketplaceJson();
      await cache.writeMarketplace('dorkos-community', json);

      const dir = join(cache.cacheRoot, 'marketplaces', 'dorkos-community');
      const jsonStat = await stat(join(dir, 'marketplace.json'));
      const stampStat = await stat(join(dir, '.last-fetched'));
      expect(stampStat.mtimeMs).toBeGreaterThanOrEqual(jsonStat.mtimeMs);
    });
  });

  describe('TTL', () => {
    it('returns stale=true once Date.now() advances beyond ttlMs', async () => {
      vi.useFakeTimers();
      const start = new Date('2026-04-06T00:00:00.000Z');
      vi.setSystemTime(start);

      await cache.writeMarketplace('dorkos-community', buildMarketplaceJson());

      // Advance one hour and one second past the default 1h TTL.
      vi.setSystemTime(new Date(start.getTime() + 60 * 60 * 1000 + 1000));

      const result = await cache.readMarketplace('dorkos-community');
      expect(result).not.toBeNull();
      expect(result!.stale).toBe(true);
      // The JSON is still served — stale flag is set, not erased.
      expect(result!.json.name).toBe('dorkos-community');
    });

    it('respects a custom ttlMs from the constructor', async () => {
      vi.useFakeTimers();
      const start = new Date('2026-04-06T00:00:00.000Z');
      vi.setSystemTime(start);

      const shortCache = new MarketplaceCache(dorkHome, 1000);
      await shortCache.writeMarketplace('dorkos-community', buildMarketplaceJson());

      vi.setSystemTime(new Date(start.getTime() + 500));
      const fresh = await shortCache.readMarketplace('dorkos-community');
      expect(fresh!.stale).toBe(false);

      vi.setSystemTime(new Date(start.getTime() + 2000));
      const stale = await shortCache.readMarketplace('dorkos-community');
      expect(stale!.stale).toBe(true);
    });
  });

  describe('getPackage', () => {
    it('returns null when the package SHA is not cached', async () => {
      const result = await cache.getPackage('code-review-suite', 'a3f4b21');
      expect(result).toBeNull();
    });

    it('returns the cached package descriptor when present', async () => {
      const path = await cache.putPackage('code-review-suite', 'a3f4b21');
      // Caller writes contents — touch a file to simulate that.
      await writeFile(join(path, 'README.md'), '# code-review-suite\n');

      const result = await cache.getPackage('code-review-suite', 'a3f4b21');
      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('code-review-suite');
      expect(result!.commitSha).toBe('a3f4b21');
      expect(result!.path).toBe(path);
      expect(result!.cachedAt).toBeInstanceOf(Date);
    });
  });

  describe('putPackage', () => {
    it('reserves an empty directory at ${cacheRoot}/packages/${name}@${sha}', async () => {
      const path = await cache.putPackage('code-review-suite', 'a3f4b21');

      expect(path).toBe(join(cache.cacheRoot, 'packages', 'code-review-suite@a3f4b21'));
      await expect(access(path)).resolves.toBeUndefined();
    });
  });

  describe('listPackages', () => {
    it('returns an empty array when no packages are cached', async () => {
      const packages = await cache.listPackages();
      expect(packages).toEqual([]);
    });

    it('enumerates every cached SHA across all package names', async () => {
      await cache.putPackage('code-review-suite', 'a3f4b21');
      await cache.putPackage('code-review-suite', 'b8c1d99');
      await cache.putPackage('release-manager', 'c0ffee0');

      const packages = await cache.listPackages();
      expect(packages).toHaveLength(3);
      const ids = packages.map((p) => `${p.packageName}@${p.commitSha}`).sort();
      expect(ids).toEqual([
        'code-review-suite@a3f4b21',
        'code-review-suite@b8c1d99',
        'release-manager@c0ffee0',
      ]);
    });

    it('parses package names containing inner @ via lastIndexOf', async () => {
      // A hypothetical name with an embedded @ — confirms lastIndexOf usage
      // so the SHA after the LAST @ is what gets parsed out.
      await cache.putPackage('@scope-pkg', 'deadbeef');

      const packages = await cache.listPackages();
      const found = packages.find((p) => p.commitSha === 'deadbeef');
      expect(found).toBeDefined();
      expect(found!.packageName).toBe('@scope-pkg');
    });
  });

  describe('prune', () => {
    /**
     * Stamp every package's mtime explicitly. `cachedAt` comes from the real
     * filesystem mtime, so fake timers do not influence it — we have to set
     * mtime by hand to get deterministic ordering across the matrix.
     */
    async function stampMtime(path: string, secondsFromEpoch: number): Promise<void> {
      await utimes(path, secondsFromEpoch, secondsFromEpoch);
    }

    it('keeps the most recent SHA per package and removes the rest by default', async () => {
      const old = await cache.putPackage('code-review-suite', 'old-sha');
      const fresh = await cache.putPackage('code-review-suite', 'new-sha');
      const only = await cache.putPackage('release-manager', 'only-sha');

      await stampMtime(old, 1_000);
      await stampMtime(fresh, 2_000);
      await stampMtime(only, 3_000);

      const result = await cache.prune();

      expect(result.removed).toHaveLength(1);
      expect(result.removed[0]?.packageName).toBe('code-review-suite');
      expect(result.removed[0]?.commitSha).toBe('old-sha');

      const remaining = await cache.listPackages();
      const remainingIds = remaining.map((p) => `${p.packageName}@${p.commitSha}`).sort();
      expect(remainingIds).toEqual(['code-review-suite@new-sha', 'release-manager@only-sha']);
    });

    it('respects a custom keepLastN', async () => {
      const sha1 = await cache.putPackage('code-review-suite', 'sha-1');
      const sha2 = await cache.putPackage('code-review-suite', 'sha-2');
      const sha3 = await cache.putPackage('code-review-suite', 'sha-3');

      await stampMtime(sha1, 1_000);
      await stampMtime(sha2, 2_000);
      await stampMtime(sha3, 3_000);

      const result = await cache.prune({ keepLastN: 2 });
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0]?.commitSha).toBe('sha-1');

      const remaining = await cache.listPackages();
      const remainingShas = remaining.map((p) => p.commitSha).sort();
      expect(remainingShas).toEqual(['sha-2', 'sha-3']);
    });
  });

  describe('clear', () => {
    it('removes the entire cache/marketplace tree', async () => {
      await cache.writeMarketplace('dorkos-community', buildMarketplaceJson());
      await cache.putPackage('code-review-suite', 'a3f4b21');

      await cache.clear();

      await expect(access(cache.cacheRoot)).rejects.toThrow();
      // Sanity: it can be reused after a clear.
      await cache.writeMarketplace('dorkos-community', buildMarketplaceJson());
      const result = await cache.readMarketplace('dorkos-community');
      expect(result).not.toBeNull();
    });

    it('is a no-op when the cache root does not exist', async () => {
      await expect(cache.clear()).resolves.toBeUndefined();
    });
  });
});
