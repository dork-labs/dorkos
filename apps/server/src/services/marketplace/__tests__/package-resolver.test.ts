/**
 * Tests for `package-resolver.ts`. Covers all five resolution paths
 * (local path, git shorthand, explicit git URL, explicit marketplace,
 * bare name) and the three typed errors.
 *
 * `MarketplaceSourceManager` and `MarketplaceCache` are stubbed with
 * minimal `vi.fn()` implementations — these tests do not touch the real
 * filesystem except to create a single fixture directory used by the
 * "local path" path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MarketplaceJson } from '@dorkos/marketplace';
import type { CachedMarketplace, MarketplaceCache } from '../cache/marketplace-cache.js';
import type { MarketplaceSourceManager } from '../sources/marketplace-source-manager.js';
import type { MarketplaceSource } from '../types.js';
import {
  AmbiguousPackageError,
  MarketplaceNotFoundError,
  PackageResolver,
} from '../package-resolver.js';
import { InvalidPackageNameError } from '../lib/package-paths.js';
import { BoundaryError, initBoundary } from '../../../lib/boundary.js';

/** Build a stub `MarketplaceSourceManager` whose methods can be configured per-test. */
function buildSourceManagerStub(opts?: {
  list?: MarketplaceSource[];
  get?: Map<string, MarketplaceSource | null>;
}): MarketplaceSourceManager {
  return {
    list: vi.fn().mockResolvedValue(opts?.list ?? []),
    get: vi.fn().mockImplementation(async (name: string) => opts?.get?.get(name) ?? null),
  } as unknown as MarketplaceSourceManager;
}

/** Build a stub `MarketplaceCache` whose `readMarketplace` returns from a Map. */
function buildCacheStub(
  entries: Map<string, CachedMarketplace | null> = new Map()
): MarketplaceCache {
  return {
    readMarketplace: vi.fn().mockImplementation(async (name: string) => entries.get(name) ?? null),
  } as unknown as MarketplaceCache;
}

/** Build a `CachedMarketplace` containing the named plugins. */
function buildCachedMarketplace(marketplaceName: string, pluginNames: string[]): CachedMarketplace {
  const json: MarketplaceJson = {
    name: marketplaceName,
    owner: { name: 'example' },
    plugins: pluginNames.map((name) => ({
      name,
      source: { source: 'url', url: `https://github.com/example/${name}` },
    })),
  };
  return { json, fetchedAt: new Date(), stale: false };
}

/** Build a configured `MarketplaceSource` with sensible defaults. */
function buildSource(name: string, enabled = true): MarketplaceSource {
  return {
    name,
    source: `https://github.com/example/${name}`,
    enabled,
    addedAt: new Date().toISOString(),
  };
}

describe('PackageResolver', () => {
  let scratchDir: string;

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'package-resolver-'));
    // The resolver confines local-path installs to the directory boundary, so
    // the fixture directory has to BE the boundary for these tests.
    await initBoundary(scratchDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(scratchDir, { recursive: true, force: true });
  });

  describe('isConfiguredMarketplace (DOR-4988)', () => {
    it('is true only for a marketplace this install has configured', async () => {
      const resolver = new PackageResolver(
        buildSourceManagerStub({
          get: new Map([['dorkos-community', buildSource('dorkos-community')]]),
        }),
        buildCacheStub()
      );
      expect(await resolver.isConfiguredMarketplace('dorkos-community')).toBe(true);
      expect(await resolver.isConfiguredMarketplace('kais-private-marketplace')).toBe(false);
    });
  });

  describe('local path resolution', () => {
    it('resolves a relative path to an absolute local source', async () => {
      const fixtureDir = join(scratchDir, 'fixture-pkg');
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(join(fixtureDir, 'marker.txt'), 'present');

      const resolver = new PackageResolver(buildSourceManagerStub(), buildCacheStub());
      const result = await resolver.resolve(fixtureDir);

      expect(result.kind).toBe('local');
      expect(result.localPath).toBe(resolve(fixtureDir));
      expect(result.packageName).toBe('fixture-pkg');
    });

    // Without this, a remote caller learns whether any absolute path on the
    // server exists (the `stat` answers differently), and any directory that
    // happens to carry a package manifest gets its whole file listing returned
    // by the install preview — before anyone consents to anything.
    it('refuses a local path outside the directory boundary', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'package-resolver-outside-'));
      try {
        const resolver = new PackageResolver(buildSourceManagerStub(), buildCacheStub());

        await expect(resolver.resolve(outside)).rejects.toThrow(BoundaryError);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('refuses an out-of-boundary path BEFORE asking whether it exists', async () => {
      const resolver = new PackageResolver(buildSourceManagerStub(), buildCacheStub());

      // A path that does not exist and is out of bounds must answer the same
      // way as one that does exist, or the refusal is itself the oracle.
      await expect(resolver.resolve('/definitely/not/here-12345')).rejects.toThrow(BoundaryError);
    });
  });

  describe('git shorthand resolution', () => {
    it('expands `github:user/repo` to https://github.com/user/repo', async () => {
      const resolver = new PackageResolver(buildSourceManagerStub(), buildCacheStub());

      const result = await resolver.resolve('github:dorkos/code-review-suite');

      expect(result.kind).toBe('git');
      expect(result.gitUrl).toBe('https://github.com/dorkos/code-review-suite');
      expect(result.packageName).toBe('code-review-suite');
    });
  });

  describe('explicit git URL after `@`', () => {
    it('parses `pkg@https://github.com/x/y` as a git source', async () => {
      const resolver = new PackageResolver(buildSourceManagerStub(), buildCacheStub());

      const result = await resolver.resolve('pkg@https://github.com/x/y');

      expect(result.kind).toBe('git');
      expect(result.packageName).toBe('pkg');
      expect(result.gitUrl).toBe('https://github.com/x/y');
    });

    // The resolved name becomes the cache key `${name}@${sha}` under
    // `<cacheRoot>/packages/`, where the cache does an `rm -rf` and a `rename`.
    // A name with a separator in it therefore plants a cloned, attacker-authored
    // git tree anywhere on disk, so the resolver refuses it at the parse.
    it.each([
      ['a/../../../../x@https://host/repo', 'the cache-key escape'],
      ['nested/name@https://host/repo', 'forward slash'],
      ['..@https://host/repo', 'bare parent'],
      ['nested\\name@https://host/repo', 'backslash'],
    ])('refuses %s (%s)', async (input) => {
      const resolver = new PackageResolver(buildSourceManagerStub(), buildCacheStub());

      await expect(resolver.resolve(input)).rejects.toThrow(InvalidPackageNameError);
    });

    it('refuses a traversal name arriving through the `github:` shorthand', async () => {
      const resolver = new PackageResolver(buildSourceManagerStub(), buildCacheStub());

      await expect(resolver.resolve('github:dorkos/..')).rejects.toThrow(InvalidPackageNameError);
    });
  });

  describe('explicit marketplace after `@`', () => {
    it('resolves `pkg@my-marketplace` against a cached marketplace document', async () => {
      const sources = buildSourceManagerStub({
        get: new Map([['my-marketplace', buildSource('my-marketplace')]]),
      });
      const cache = buildCacheStub(
        new Map([['my-marketplace', buildCachedMarketplace('my-marketplace', ['pkg'])]])
      );
      const resolver = new PackageResolver(sources, cache);

      const result = await resolver.resolve('pkg@my-marketplace');

      expect(result.kind).toBe('marketplace');
      expect(result.packageName).toBe('pkg');
      expect(result.marketplaceName).toBe('my-marketplace');
      expect(result.gitUrl).toBe('https://github.com/example/pkg');
    });

    it('throws MarketplaceNotFoundError when the named marketplace is not configured', async () => {
      const sources = buildSourceManagerStub();
      const cache = buildCacheStub();
      const resolver = new PackageResolver(sources, cache);

      await expect(resolver.resolve('pkg@unknown-marketplace')).rejects.toBeInstanceOf(
        MarketplaceNotFoundError
      );
    });
  });

  describe("the entry's own version (entryVersion)", () => {
    /** A cached marketplace listing `pkg`, with `version` on its entry when given. */
    function cachedWithVersion(name: string, version?: string): CachedMarketplace {
      const cached = buildCachedMarketplace(name, ['pkg']);
      if (version !== undefined) cached.json.plugins[0] = { ...cached.json.plugins[0], version };
      return cached;
    }

    it('carries the entry version on a bare-name resolution', async () => {
      // Purpose: bare-name installs go through a different branch; it must
      // carry the field too.
      const resolver = new PackageResolver(
        buildSourceManagerStub({ list: [buildSource('mp')] }),
        buildCacheStub(new Map([['mp', cachedWithVersion('mp', '3.1.0')]]))
      );
      expect((await resolver.resolve('pkg')).entryVersion).toBe('3.1.0');
    });
  });

  describe('bare name resolution', () => {
    it('returns the single hit when only one enabled marketplace contains the package', async () => {
      const sources = buildSourceManagerStub({
        list: [buildSource('my-marketplace'), buildSource('other-marketplace')],
      });
      const cache = buildCacheStub(
        new Map([
          ['my-marketplace', buildCachedMarketplace('my-marketplace', ['pkg'])],
          ['other-marketplace', buildCachedMarketplace('other-marketplace', ['something-else'])],
        ])
      );
      const resolver = new PackageResolver(sources, cache);

      const result = await resolver.resolve('pkg');

      expect(result.kind).toBe('marketplace');
      expect(result.packageName).toBe('pkg');
      expect(result.marketplaceName).toBe('my-marketplace');
    });

    it('throws AmbiguousPackageError when two marketplaces both contain the package', async () => {
      const sources = buildSourceManagerStub({
        list: [buildSource('alpha'), buildSource('beta')],
      });
      const cache = buildCacheStub(
        new Map([
          ['alpha', buildCachedMarketplace('alpha', ['pkg'])],
          ['beta', buildCachedMarketplace('beta', ['pkg'])],
        ])
      );
      const resolver = new PackageResolver(sources, cache);

      const err = await resolver.resolve('pkg').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AmbiguousPackageError);
      const ambiguous = err as AmbiguousPackageError;
      expect(ambiguous.packageName).toBe('pkg');
      expect(ambiguous.marketplaces.sort()).toEqual(['alpha', 'beta']);
      expect(ambiguous.message).toMatch(/alpha/);
      expect(ambiguous.message).toMatch(/beta/);
    });
  });
});
