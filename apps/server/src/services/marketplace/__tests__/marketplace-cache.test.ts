import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, stat, access, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketplaceJson } from '@dorkos/marketplace';
import { IN_USE_GRACE_MS, MarketplaceCache, subpathDigest } from '../marketplace-cache.js';
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

  const HOUR_MS = 60 * 60 * 1000;

  /**
   * Set an entry's last-use stamp (its mtime) to `agoMs` before now. The
   * stamp is the real filesystem mtime, so it is set by hand, not by timers.
   */
  async function ageEntry(path: string, agoMs: number): Promise<void> {
    const then = new Date(Date.now() - agoMs);
    await utimes(path, then, then);
  }

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
    return (await cache.materializePackage(name, commit, '', fakeFetch(commit))).path;
  }

  describe('getPackage', () => {
    it('returns null when the package SHA is not cached', async () => {
      const result = await cache.getPackage('code-review-suite', sha('a'), '');
      expect(result).toBeNull();
    });

    it('returns the cached package descriptor when present', async () => {
      const path = await seed('code-review-suite', sha('a'));

      const result = await cache.getPackage('code-review-suite', sha('a'), '');
      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('code-review-suite');
      expect(result!.commitSha).toBe(sha('a'));
      expect(result!.path).toBe(path);
      expect(result!.lastUsedAt).toBeInstanceOf(Date);
    });

    it('stamps the entry as used when it hands the entry out', async () => {
      // Purpose: the stamp is what spares an entry a request is reading from
      // a sweep; a hit that does not stamp leaves the reader exposed.
      const path = await seed('code-review-suite', sha('a'));
      await ageEntry(path, HOUR_MS);

      await cache.getPackage('code-review-suite', sha('a'), '');

      expect(Date.now() - (await stat(path)).mtimeMs).toBeLessThan(IN_USE_GRACE_MS);
    });

    it('does not serve an empty entry directory', async () => {
      // Purpose: an empty directory is a crashed or colliding fetch; serving it
      // as a hit reads as "manifest missing" forever.
      await mkdir(join(cache.cacheRoot, 'trees', `code-review-suite@${sha('a')}`), {
        recursive: true,
      });
      expect(await cache.getPackage('code-review-suite', sha('a'), '')).toBeNull();
    });

    it('never reads an entry from the pre-verification packages/ root', async () => {
      // Purpose: entries written before DOR-2248 may hold a different tree than
      // their key names, and nothing can tell them apart from correct ones.
      const legacy = join(cache.cacheRoot, 'packages', `code-review-suite@${sha('a')}`);
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, 'README.md'), 'wrong tree\n');

      expect(await cache.getPackage('code-review-suite', sha('a'), '')).toBeNull();
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
      await expect(cache.getPackage(name, commit, '')).rejects.toThrow(PathEscapeError);
      await expect(cache.materializePackage(name, commit, '', async () => commit)).rejects.toThrow(
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

  describe('sparse entries', () => {
    it('keys a subfolder apart from the whole repository at the same commit', async () => {
      // Purpose: a sparse checkout is a different tree; served for a
      // whole-repository request it is missing everything else (DOR-2248).
      const whole = await cache.materializePackage('flow', sha('a'), '', fakeFetch(sha('a')));
      const sparse = await cache.materializePackage(
        'flow',
        sha('a'),
        'plugins/flow',
        fakeFetch(sha('a'), 'sparse-marker')
      );

      expect(sparse.path).not.toBe(whole.path);
      expect(sparse.path).toMatch(new RegExp(`flow@${sha('a')}~[0-9a-f]{12}$`));
      expect(await cache.getPackage('flow', sha('a'), 'plugins/flow')).toMatchObject({
        path: sparse.path,
      });
      expect(await cache.getPackage('flow', sha('a'), 'docs')).toBeNull();
    });

    it('lists a sparse entry under its package, commit and subfolder digest', async () => {
      await cache.materializePackage('flow', sha('a'), 'plugins/flow', fakeFetch(sha('a')));
      await cache.materializePackage('flow', sha('a'), '', fakeFetch(sha('a')));
      const entries = await cache.listPackages();
      expect(entries).toHaveLength(2);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            packageName: 'flow',
            commitSha: sha('a'),
            subpathDigest: subpathDigest('plugins/flow'),
          }),
          expect.objectContaining({ packageName: 'flow', commitSha: sha('a'), subpathDigest: '' }),
        ])
      );
      expect(subpathDigest('plugins/flow')).toMatch(/^[0-9a-f]{12}$/);
    });
  });

  describe('materializePackage', () => {
    it('fetches into a temp dir then atomically renames onto the final path', async () => {
      const result = await cache.materializePackage('flow', sha('d'), '', fakeFetch(sha('d')));

      expect(result).toEqual({
        path: join(cache.cacheRoot, 'trees', `flow@${sha('d')}`),
        commitSha: sha('d'),
      });
      await expect(access(join(result.path, '.dork-manifest'))).resolves.toBeUndefined();
    });

    it('keys the entry by the commit the fetch reports, not the one expected', async () => {
      // Purpose: the fetch reads the commit from the checkout; the caller's
      // expectation came from a lookup that may be stale (DOR-2248).
      const result = await cache.materializePackage('flow', sha('a'), '', fakeFetch(sha('b')));

      expect(result.commitSha).toBe(sha('b'));
      expect(result.path).toBe(join(cache.cacheRoot, 'trees', `flow@${sha('b')}`));
      expect(await cache.getPackage('flow', sha('a'), '')).toBeNull();
    });

    it.each(['tmp-1727100000000', 'local', 'relative-path', 'deadbeef', '../../../escape', ''])(
      'refuses to key an entry by %j and leaves nothing behind',
      async (reported) => {
        // Purpose: a placeholder or a partial id must never become a key.
        await expect(
          cache.materializePackage('flow', sha('a'), '', fakeFetch(reported))
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
        cache.materializePackage('flow', sha('c'), '', fetch),
        cache.materializePackage('flow', sha('c'), '', fetch),
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
      const result = await cache.materializePackage('flow', sha('b'), '', fetch);

      expect(result.path).toBe(join(cache.cacheRoot, 'trees', `flow@${sha('b')}`));
      expect(fetch).not.toHaveBeenCalled();
    });

    it('propagates the fetch error verbatim and leaves no final directory behind', async () => {
      // A real fetch failure (git's stderr) must surface to the caller, never
      // be swallowed into a partial empty dir that later reads as a
      // misleading "manifest missing".
      const fetchError = new Error("Couldn't fetch github.com/o/r: repository not found");
      const fetch = vi.fn().mockRejectedValue(fetchError);

      await expect(cache.materializePackage('flow', sha('e'), '', fetch)).rejects.toThrow(
        /repository not found/
      );

      // No valid package was left behind, and the in-flight lock cleared so a
      // retry can run.
      expect(await cache.getPackage('flow', sha('e'), '')).toBeNull();
      const retry = vi.fn(fakeFetch(sha('e')));
      await cache.materializePackage('flow', sha('e'), '', retry);
      expect(retry).toHaveBeenCalledTimes(1);
    });

    it('removes a partial (empty) directory left by a prior crashed fetch before renaming', async () => {
      // Simulate a crashed fetch that left an empty directory at the key.
      const finalPath = join(cache.cacheRoot, 'trees', `flow@${sha('f')}`);
      await mkdir(finalPath, { recursive: true });

      const result = await cache.materializePackage('flow', sha('f'), '', fakeFetch(sha('f')));

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

  describe('removeLeftovers', () => {
    it('removes the pre-verification packages/ root and nothing else', async () => {
      // Purpose: old entries are never read, so they are only disk; removing
      // them must not touch verified entries or cached marketplace lists.
      await mkdir(join(cache.cacheRoot, 'packages', `flow@${sha('a')}`), { recursive: true });
      await seed('flow', sha('b'));
      await cache.writeMarketplace('dorkos-community', buildMarketplaceJson());

      await cache.removeLeftovers();

      await expect(access(join(cache.cacheRoot, 'packages'))).rejects.toThrow();
      expect(await cache.getPackage('flow', sha('b'), '')).not.toBeNull();
      expect(await cache.readMarketplace('dorkos-community')).not.toBeNull();
    });

    it('removes temp fetch directories a crash left behind', async () => {
      // Purpose: a half-fetched `.git` can outlive a crash; nothing reads it.
      const leftover = join(cache.cacheRoot, 'trees', '.tmp-fetch-abc123');
      await mkdir(join(leftover, '.git'), { recursive: true });
      await seed('flow', sha('b'));

      await cache.removeLeftovers();

      await expect(access(leftover)).rejects.toThrow();
      expect(await cache.getPackage('flow', sha('b'), '')).not.toBeNull();
    });

    it('removes entries a crashed sweep renamed aside but never deleted', async () => {
      // Purpose: a sweep renames an entry to `.tmp-prune-*` before deleting
      // it; a crash in between must not leave that copy on disk for ever.
      const leftover = join(cache.cacheRoot, 'trees', '.tmp-prune-0f8e');
      await mkdir(leftover, { recursive: true });
      await writeFile(join(leftover, 'README.md'), 'x');

      await cache.removeLeftovers();

      await expect(access(leftover)).rejects.toThrow();
    });

    it('is a no-op when there is no legacy root', async () => {
      await expect(cache.removeLeftovers()).resolves.toBeUndefined();
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

  describe('removeUnused', () => {
    /** Keep nothing: every entry is up for removal unless it is in use. */
    const keepNone = (): ReadonlySet<string> => new Set();

    it('removes an entry the caller does not keep and reports the bytes it freed', async () => {
      // Purpose: the basic contract — an unkept, unused entry leaves disk, and
      // the report says how much space that gave back.
      const path = await seed('flow', sha('a'));
      await ageEntry(path, HOUR_MS);

      const result = await cache.removeUnused(keepNone);

      expect(result.removed.map((e) => e.commitSha)).toEqual([sha('a')]);
      expect(result.freedBytes).toBe('content\n'.length);
      expect(result.failed).toEqual([]);
      await expect(access(path)).rejects.toThrow();
    });

    it('keeps an entry whose path the caller keeps', async () => {
      // Purpose: the caller's rule decides; the cache never overrides a keep.
      const kept = await seed('flow', sha('a'));
      const dropped = await seed('flow', sha('b'));
      await ageEntry(kept, HOUR_MS);
      await ageEntry(dropped, HOUR_MS);

      const result = await cache.removeUnused((entries) => {
        // The rule sees the whole listing, so it can compare entries.
        expect(entries.map((e) => e.path).sort()).toEqual([kept, dropped].sort());
        return new Set([kept]);
      });

      expect(result.removed.map((e) => e.path)).toEqual([dropped]);
      await expect(access(kept)).resolves.toBeUndefined();
    });

    it('spares an entry used inside the grace window even when the caller drops it', async () => {
      // Purpose: a reader holds an entry's path for the seconds it takes to
      // copy it; the grace is what keeps a sweep from pulling it away.
      const recent = await seed('flow', sha('a'));
      await ageEntry(recent, IN_USE_GRACE_MS - 60_000);
      const stale = await seed('flow', sha('b'));
      await ageEntry(stale, IN_USE_GRACE_MS + 60_000);

      const result = await cache.removeUnused(keepNone);

      expect(result.removed.map((e) => e.path)).toEqual([stale]);
      await expect(access(recent)).resolves.toBeUndefined();
    });

    it('never touches an in-progress fetch', async () => {
      // Purpose: a `.tmp-fetch-*` directory is a fetch running right now.
      const inProgress = join(cache.cacheRoot, 'trees', '.tmp-fetch-abc123');
      await mkdir(inProgress, { recursive: true });
      await writeFile(join(inProgress, 'partial'), 'x');
      await ageEntry(inProgress, HOUR_MS);

      await cache.removeUnused(keepNone);

      await expect(access(join(inProgress, 'partial'))).resolves.toBeUndefined();
    });

    it('leaves nothing renamed aside behind', async () => {
      // Purpose: an entry is renamed out of the way before it is deleted; the
      // renamed copy must go too, or the sweep only moved the disk use.
      const path = await seed('flow', sha('a'));
      await ageEntry(path, HOUR_MS);

      await cache.removeUnused(keepNone);

      expect(await readdir(join(cache.cacheRoot, 'trees'))).toEqual([]);
    });

    it.each([
      ['hit first', true],
      ['sweep first', false],
    ])('never hands out a path a concurrent sweep removes (%s)', async (_label, hitFirst) => {
      // Purpose: the lock makes "check and stamp" and "re-check and remove"
      // exclusive, so a reader that got a path still has its tree.
      const path = await seed('flow', sha('a'));
      await ageEntry(path, HOUR_MS);

      const hit = cache.getPackage('flow', sha('a'), '');
      const sweep = cache.removeUnused(keepNone);
      const [found, swept] = hitFirst
        ? [await hit, await sweep]
        : await Promise.all([hit, sweep]).then(([f, s]) => [f, s] as const);

      if (found) {
        await expect(access(found.path)).resolves.toBeUndefined();
        expect(swept.removed).toEqual([]);
      } else {
        expect(swept.removed.map((e) => e.path)).toEqual([path]);
      }
    });

    it('spares the entry a concurrent fetch serves from its fast path', async () => {
      // Purpose: the same guarantee for materializePackage's cache hit, which
      // the update apply takes (force skips getPackage, not this).
      const path = await seed('flow', sha('a'));
      await ageEntry(path, HOUR_MS);
      const fetch = vi.fn(fakeFetch(sha('a')));

      const [served] = await Promise.all([
        cache.materializePackage('flow', sha('a'), '', fetch),
        cache.removeUnused(keepNone),
      ]);

      await expect(access(join(served.path, '.dork-manifest'))).resolves.toBeUndefined();
    });
  });

  describe('stamping when a fetch lands', () => {
    it('stamps a fetched entry even when the fetch took longer than the grace', async () => {
      // Purpose: a slow fetch leaves the temp directory's time from when it
      // started; unstamped, the entry would land already "unused" and a sweep
      // could take it from the request that is about to read it.
      const result = await cache.materializePackage('flow', sha('a'), '', async (dir) => {
        await writeFile(join(dir, 'README.md'), 'tree\n');
        await ageEntry(dir, HOUR_MS);
        return sha('a');
      });

      expect(Date.now() - (await stat(result.path)).mtimeMs).toBeLessThan(IN_USE_GRACE_MS);
    });

    it('stamps the entry another process landed first', async () => {
      // Purpose: when the fetch finds its commit already cached (the ref moved
      // onto an old entry), that old entry is what the caller reads now.
      const existing = await seed('flow', sha('b'));
      await ageEntry(existing, HOUR_MS);

      const result = await cache.materializePackage('flow', sha('a'), '', fakeFetch(sha('b')));

      expect(result.path).toBe(existing);
      expect(Date.now() - (await stat(existing)).mtimeMs).toBeLessThan(IN_USE_GRACE_MS);
    });
  });

  describe('onEntryWritten', () => {
    it('tells the listener when a fetch lands a new entry, and not on a hit', async () => {
      // Purpose: this is the one door the cache grows through, so it is the
      // one signal a sweep needs; a hit adds nothing and must not trigger one.
      const listener = vi.fn();
      const unsubscribe = cache.onEntryWritten(listener);

      await seed('flow', sha('a'));
      expect(listener).toHaveBeenCalledTimes(1);

      await cache.materializePackage('flow', sha('a'), '', fakeFetch(sha('a')));
      await cache.getPackage('flow', sha('a'), '');
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      await seed('flow', sha('b'));
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not tell the listener when the fetch fails', async () => {
      const listener = vi.fn();
      cache.onEntryWritten(listener);

      await expect(
        cache.materializePackage('flow', sha('a'), '', fakeFetch('not-a-commit'))
      ).rejects.toThrow();

      expect(listener).not.toHaveBeenCalled();
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
