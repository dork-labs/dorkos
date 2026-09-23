import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, stat, access, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketplaceJson } from '@dorkos/marketplace';
import { MarketplaceCache } from '../marketplace-cache.js';
import { PathEscapeError } from '../lib/package-paths.js';

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

    it('reads back a document that self-declares a RESERVED marketplace name (DOR-261)', async () => {
      // The real Anthropic marketplace is literally named `claude-plugins-official`
      // — a name on the RESERVED_MARKETPLACE_NAMES publishing list. The cache is
      // a consumption surface: a strict read-back turned every successfully
      // fetched official document into a permanent cache miss, making all of its
      // packages uninstallable via `name@marketplace`.
      const doc = buildMarketplaceJson('claude-plugins-official');
      await cache.writeMarketplace('claude-plugins-official', doc);

      const result = await cache.readMarketplace('claude-plugins-official');
      expect(result).not.toBeNull();
      expect(result?.json.name).toBe('claude-plugins-official');
      expect(result?.json.plugins).toHaveLength(1);
      expect(result?.stale).toBe(false);
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

  /** A full commit id made of one repeated hex digit. */
  const sha = (digit: string): string => digit.repeat(40);

  /**
   * A fake fetch that writes a marker file into the temp dir after an optional
   * delay (so concurrent calls actually overlap) and reports `commit`.
   */
  function fakeFetch(commit: string, marker = '.dork-manifest', delayMs = 0) {
    return async (tempDir: string): Promise<string> => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      await writeFile(join(tempDir, marker), 'content\n');
      return commit;
    };
  }

  /** Materialize an entry for `name` at `commit` and return its path. */
  async function seed(name: string, commit: string): Promise<string> {
    return (await cache.materializePackage(name, commit, fakeFetch(commit))).path;
  }

  describe('getPackage', () => {
    it('returns null when the package SHA is not cached', async () => {
      const result = await cache.getPackage('code-review-suite', sha('a'));
      expect(result).toBeNull();
    });

    it('returns the cached package descriptor when present', async () => {
      const path = await seed('code-review-suite', sha('a'));

      const result = await cache.getPackage('code-review-suite', sha('a'));
      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('code-review-suite');
      expect(result!.commitSha).toBe(sha('a'));
      expect(result!.path).toBe(path);
      expect(result!.cachedAt).toBeInstanceOf(Date);
    });

    it('never reads an entry from the pre-verification packages/ root', async () => {
      // Purpose: entries written before DOR-2248 may hold a different tree than
      // their key names, and nothing can tell them apart from correct ones.
      const legacy = join(cache.cacheRoot, 'packages', `code-review-suite@${sha('a')}`);
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, 'README.md'), 'wrong tree\n');

      expect(await cache.getPackage('code-review-suite', sha('a'))).toBeNull();
      expect(await cache.listPackages()).toEqual([]);
    });
  });

  // The cache is the last thing standing between a package name and an
  // `rm -rf` + `rename` on disk, so it re-checks containment itself rather
  // than trusting whoever computed the key.
  describe('cache-key containment', () => {
    it.each([
      ['a/../../../../x', sha('d')],
      ['../escape', sha('d')],
      // The SHA half of the key is remote-supplied too, and it needs one more
      // `..` than the name does: `pkg@..` is itself a segment to climb out of.
      ['pkg', '../../../escape'],
    ])('refuses to derive a package directory from %j @ %j', async (name, commit) => {
      await expect(cache.getPackage(name, commit)).rejects.toThrow(PathEscapeError);
      await expect(cache.materializePackage(name, commit, async () => commit)).rejects.toThrow(
        PathEscapeError
      );
    });

    it('refuses to derive a marketplace directory that climbs out of the cache', async () => {
      await expect(cache.readMarketplace('../../escape')).rejects.toThrow(PathEscapeError);
      await expect(cache.writeMarketplace('../../escape', buildMarketplaceJson())).rejects.toThrow(
        PathEscapeError
      );
    });
  });

  describe('materializePackage', () => {
    it('fetches into a temp dir then atomically renames onto the final path', async () => {
      const result = await cache.materializePackage('flow', sha('d'), fakeFetch(sha('d')));

      expect(result).toEqual({
        path: join(cache.cacheRoot, 'trees', `flow@${sha('d')}`),
        commitSha: sha('d'),
      });
      await expect(access(join(result.path, '.dork-manifest'))).resolves.toBeUndefined();
    });

    it('keys the entry by the commit the fetch reports, not the one expected', async () => {
      // Purpose: the fetch reads the commit from the checkout; the caller's
      // expectation came from a lookup that may be stale (DOR-2248).
      const result = await cache.materializePackage('flow', sha('a'), fakeFetch(sha('b')));

      expect(result.commitSha).toBe(sha('b'));
      expect(result.path).toBe(join(cache.cacheRoot, 'trees', `flow@${sha('b')}`));
      expect(await cache.getPackage('flow', sha('a'))).toBeNull();
    });

    it.each(['tmp-1727100000000', 'local', 'relative-path', 'deadbeef', '../../../escape', ''])(
      'refuses to key an entry by %j and leaves nothing behind',
      async (reported) => {
        // Purpose: a placeholder or a partial id must never become a key.
        await expect(
          cache.materializePackage('flow', sha('a'), fakeFetch(reported))
        ).rejects.toThrow(/not a full commit id/);

        const packagesRoot = join(cache.cacheRoot, 'trees');
        expect(await readdir(packagesRoot)).toEqual([]);
      }
    );

    it('two concurrent fetches of the same package both succeed and fetch exactly once', async () => {
      // This is the regression for the failing `flow` install: a UI preview
      // and an install fire simultaneously. Both must succeed; only one fetch
      // may run (the other awaits and reuses the in-flight result), so two
      // git processes never collide on the same directory.
      const fetch = vi.fn(fakeFetch(sha('c'), '.dork-manifest', 25));

      const [a, b] = await Promise.all([
        cache.materializePackage('flow', sha('c'), fetch),
        cache.materializePackage('flow', sha('c'), fetch),
      ]);

      const expected = join(cache.cacheRoot, 'trees', `flow@${sha('c')}`);
      expect(a.path).toBe(expected);
      expect(b.path).toBe(expected);
      expect(fetch).toHaveBeenCalledTimes(1);
      await expect(access(join(expected, '.dork-manifest'))).resolves.toBeUndefined();
    });

    it('reuses an already-materialized valid package without re-fetching', async () => {
      await seed('flow', sha('b'));

      const fetch = vi.fn(fakeFetch(sha('b')));
      const result = await cache.materializePackage('flow', sha('b'), fetch);

      expect(result.path).toBe(join(cache.cacheRoot, 'trees', `flow@${sha('b')}`));
      expect(fetch).not.toHaveBeenCalled();
    });

    it('propagates the fetch error verbatim and leaves no final directory behind', async () => {
      // A real fetch failure (git's stderr) must surface to the caller, never
      // be swallowed into a partial empty dir that later reads as a
      // misleading "manifest missing".
      const fetchError = new Error("Couldn't fetch github.com/o/r: repository not found");
      const fetch = vi.fn().mockRejectedValue(fetchError);

      await expect(cache.materializePackage('flow', sha('e'), fetch)).rejects.toThrow(
        /repository not found/
      );

      // No valid package was left behind, and the in-flight lock cleared so a
      // retry can run.
      expect(await cache.getPackage('flow', sha('e'))).toBeNull();
      const retry = vi.fn(fakeFetch(sha('e')));
      await cache.materializePackage('flow', sha('e'), retry);
      expect(retry).toHaveBeenCalledTimes(1);
    });

    it('removes a partial (empty) directory left by a prior crashed fetch before renaming', async () => {
      // Simulate a crashed fetch that left an empty directory at the key.
      const finalPath = join(cache.cacheRoot, 'trees', `flow@${sha('f')}`);
      await mkdir(finalPath, { recursive: true });

      const result = await cache.materializePackage('flow', sha('f'), fakeFetch(sha('f')));

      expect(result.path).toBe(finalPath);
      // The fresh content landed, replacing the empty partial dir.
      await expect(access(join(finalPath, '.dork-manifest'))).resolves.toBeUndefined();
    });

    it('does not leak temp directories into listPackages', async () => {
      await seed('flow', sha('1'));

      const packages = await cache.listPackages();
      expect(packages).toHaveLength(1);
      expect(packages[0]?.packageName).toBe('flow');
      expect(packages[0]?.commitSha).toBe(sha('1'));
    });
  });

  describe('removeLegacyPackages', () => {
    it('removes the pre-verification packages/ root and nothing else', async () => {
      // Purpose: old entries are never read, so they are only disk; removing
      // them must not touch verified entries or cached marketplace lists.
      await mkdir(join(cache.cacheRoot, 'packages', `flow@${sha('a')}`), { recursive: true });
      await seed('flow', sha('b'));
      await cache.writeMarketplace('dorkos-community', buildMarketplaceJson());

      await cache.removeLegacyPackages();

      await expect(access(join(cache.cacheRoot, 'packages'))).rejects.toThrow();
      expect(await cache.getPackage('flow', sha('b'))).not.toBeNull();
      expect(await cache.readMarketplace('dorkos-community')).not.toBeNull();
    });

    it('is a no-op when there is no legacy root', async () => {
      await expect(cache.removeLegacyPackages()).resolves.toBeUndefined();
    });
  });

  describe('listPackages', () => {
    it('returns an empty array when no packages are cached', async () => {
      const packages = await cache.listPackages();
      expect(packages).toEqual([]);
    });

    it('enumerates every cached SHA across all package names', async () => {
      await seed('code-review-suite', sha('a'));
      await seed('code-review-suite', sha('b'));
      await seed('release-manager', sha('c'));

      const packages = await cache.listPackages();
      expect(packages).toHaveLength(3);
      const ids = packages.map((p) => `${p.packageName}@${p.commitSha}`).sort();
      expect(ids).toEqual([
        `code-review-suite@${sha('a')}`,
        `code-review-suite@${sha('b')}`,
        `release-manager@${sha('c')}`,
      ]);
    });

    it('parses package names containing inner @ via lastIndexOf', async () => {
      // A hypothetical name with an embedded @ — confirms lastIndexOf usage
      // so the SHA after the LAST @ is what gets parsed out.
      await seed('@scope-pkg', sha('d'));

      const packages = await cache.listPackages();
      const found = packages.find((p) => p.commitSha === sha('d'));
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
      const old = await seed('code-review-suite', sha('1'));
      const fresh = await seed('code-review-suite', sha('2'));
      const only = await seed('release-manager', sha('3'));

      await stampMtime(old, 1_000);
      await stampMtime(fresh, 2_000);
      await stampMtime(only, 3_000);

      const result = await cache.prune();

      expect(result.removed).toHaveLength(1);
      expect(result.removed[0]?.packageName).toBe('code-review-suite');
      expect(result.removed[0]?.commitSha).toBe(sha('1'));

      const remaining = await cache.listPackages();
      const remainingIds = remaining.map((p) => `${p.packageName}@${p.commitSha}`).sort();
      expect(remainingIds).toEqual([
        `code-review-suite@${sha('2')}`,
        `release-manager@${sha('3')}`,
      ]);
    });

    it('respects a custom keepLastN', async () => {
      const sha1 = await seed('code-review-suite', sha('1'));
      const sha2 = await seed('code-review-suite', sha('2'));
      const sha3 = await seed('code-review-suite', sha('3'));

      await stampMtime(sha1, 1_000);
      await stampMtime(sha2, 2_000);
      await stampMtime(sha3, 3_000);

      const result = await cache.prune({ keepLastN: 2 });
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0]?.commitSha).toBe(sha('1'));

      const remaining = await cache.listPackages();
      const remainingShas = remaining.map((p) => p.commitSha).sort();
      expect(remainingShas).toEqual([sha('2'), sha('3')]);
    });
  });

  describe('clear', () => {
    it('removes the entire cache/marketplace tree', async () => {
      await cache.writeMarketplace('dorkos-community', buildMarketplaceJson());
      await seed('code-review-suite', sha('a'));

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
