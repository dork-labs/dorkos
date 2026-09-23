/**
 * Marketplace cache — manages `${dorkHome}/cache/marketplace/` with TTL
 * semantics for `marketplace.json` documents and content-addressable storage
 * for fetched package trees.
 *
 * Layout:
 * ```
 * ${dorkHome}/cache/marketplace/
 * ├── marketplaces/
 * │   └── ${name}/
 * │       ├── marketplace.json   # Last-fetched copy (TTL governed)
 * │       └── .last-fetched      # Timestamp stamp
 * └── trees/
 *     └── ${name}@${sha}/        # The tree of commit ${sha}, verified (DOR-2248)
 * ```
 *
 * An entry's key is the commit its checkout verifiably holds: the only way in
 * is {@link MarketplaceCache.materializePackage}, which takes the key from the
 * fetch (`lib/git-tree.ts` reads it from `HEAD`) and refuses anything that is
 * not a full commit id. Entries from before that rule lived under `packages/`;
 * they are never read, and {@link MarketplaceCache.removeLegacyPackages}
 * deletes them.
 *
 * TTL strategy:
 * - `marketplace.json`: 1h default. Past TTL the entry is still served but
 *   `stale: true` so callers can refresh in the background.
 * - Package trees: never expire. Garbage-collected only via {@link MarketplaceCache.prune}
 *   or {@link MarketplaceCache.clear}.
 *
 * @module services/marketplace/marketplace-cache
 */
import { mkdir, mkdtemp, readFile, rename, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarketplaceJsonLenient, type MarketplaceJson } from '@dorkos/marketplace';
import { assertContainedIn } from './lib/package-paths.js';
import { isFullCommitSha } from './lib/git-tree.js';

/** Default TTL for cached `marketplace.json` documents (1 hour). */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Filename for the cached marketplace document. */
const MARKETPLACE_FILENAME = 'marketplace.json';

/** Filename for the last-fetched timestamp stamp. */
const LAST_FETCHED_FILENAME = '.last-fetched';

/** Directory of verified package trees, under the cache root. */
const TREES_DIRNAME = 'trees';

/**
 * Where entries lived before their keys were verified (DOR-2248). Never read;
 * removed by {@link MarketplaceCache.removeLegacyPackages}.
 */
const LEGACY_PACKAGES_DIRNAME = 'packages';

/**
 * A cached marketplace.json document along with its freshness metadata.
 */
export interface CachedMarketplace {
  /** The parsed marketplace document. */
  json: MarketplaceJson;
  /** When the document was last successfully fetched and stored. */
  fetchedAt: Date;
  /** True when the document is past its TTL — caller may refresh in background. */
  stale: boolean;
}

/**
 * A descriptor for a package tree living in the content-addressable `trees/`
 * cache.
 */
export interface CachedPackage {
  /** Logical package name (may include a leading scope, e.g. `@scope/pkg`). */
  packageName: string;
  /** The commit whose tree the entry holds. */
  commitSha: string;
  /** Absolute path to the cached package directory. */
  path: string;
  /** Mtime of the cached package directory. */
  cachedAt: Date;
}

/** Where a materialized tree landed, and the commit it verifiably is. */
export interface MaterializedPackage {
  /** Absolute path to the entry. */
  path: string;
  /** The full commit id the fetch reported; the entry's key. */
  commitSha: string;
}

/**
 * Manages the on-disk marketplace cache. Pure file I/O — performs no
 * network requests of its own. Callers (source manager, package fetcher)
 * fetch upstream content and hand it to
 * {@link MarketplaceCache.writeMarketplace} /
 * {@link MarketplaceCache.materializePackage}.
 */
export class MarketplaceCache {
  private readonly ttlMs: number;

  /**
   * In-flight materialization promises keyed by `${name}@${expectedSha}`. Two
   * concurrent {@link MarketplaceCache.materializePackage} calls for the same
   * expected commit share a single fetch: the first call performs it, every
   * subsequent caller awaits the same promise and reuses the result. This is
   * the in-process de-dup that stops a UI preview + install double-fetch from
   * racing two git processes into the same directory.
   */
  private readonly inFlight = new Map<string, Promise<MaterializedPackage>>();

  /**
   * Construct a cache rooted at `${dorkHome}/cache/marketplace`.
   *
   * @param dorkHome - Absolute path to the DorkOS data directory. Required —
   *   never falls back to `os.homedir()`.
   * @param ttlMs - Marketplace document TTL in milliseconds. Defaults to 1 hour.
   */
  constructor(
    private readonly dorkHome: string,
    ttlMs: number = DEFAULT_TTL_MS
  ) {
    this.ttlMs = ttlMs;
  }

  /** Compute the cache root path: `${dorkHome}/cache/marketplace`. */
  get cacheRoot(): string {
    return join(this.dorkHome, 'cache', 'marketplace');
  }

  /**
   * Read a cached marketplace.json document.
   *
   * Returns `null` when the entry is absent, when the JSON is missing
   * its `.last-fetched` stamp, or when the cached document fails schema
   * validation (treated as a cache miss so the caller refetches).
   *
   * Parses with the LENIENT consumption parser, matching the fetch path in
   * `package-fetcher.ts`. The strict authoring parser rejects reserved
   * marketplace names — but the real Anthropic marketplace legitimately
   * self-declares `claude-plugins-official`, so a strict read-back turned
   * every successfully cached official document into a permanent cache miss
   * and made all of its packages uninstallable via `name@marketplace`
   * (DOR-261). The reserved-name list is a publishing policy, enforced at
   * authoring surfaces; the cache is a consumption surface.
   *
   * Past TTL the entry is still returned with `stale: true` — the caller
   * decides whether to serve it or refresh.
   *
   * @param marketplaceName - The configured marketplace identifier (e.g. `dorkos-community`).
   */
  async readMarketplace(marketplaceName: string): Promise<CachedMarketplace | null> {
    const dir = this.marketplaceDir(marketplaceName);
    const jsonPath = join(dir, MARKETPLACE_FILENAME);
    const stampPath = join(dir, LAST_FETCHED_FILENAME);

    let raw: string;
    let stamp: string;
    try {
      [raw, stamp] = await Promise.all([readFile(jsonPath, 'utf-8'), readFile(stampPath, 'utf-8')]);
    } catch {
      return null;
    }

    const parsed = parseMarketplaceJsonLenient(raw);
    if (!parsed.ok) {
      return null;
    }

    const fetchedAt = new Date(stamp.trim());
    if (Number.isNaN(fetchedAt.getTime())) {
      return null;
    }

    return {
      json: parsed.marketplace,
      fetchedAt,
      stale: Date.now() - fetchedAt.getTime() > this.ttlMs,
    };
  }

  /**
   * Write a marketplace.json document to the cache and stamp `.last-fetched`.
   *
   * The stamp is written **after** `marketplace.json` so a torn write leaves
   * the cache in a "no stamp → cache miss" state rather than serving stale
   * data with a fresh timestamp.
   *
   * @param marketplaceName - The configured marketplace identifier.
   * @param json - The marketplace document to persist.
   */
  async writeMarketplace(marketplaceName: string, json: MarketplaceJson): Promise<void> {
    const dir = this.marketplaceDir(marketplaceName);
    await mkdir(dir, { recursive: true });

    await writeFile(join(dir, MARKETPLACE_FILENAME), `${JSON.stringify(json, null, 2)}\n`);
    await writeFile(join(dir, LAST_FETCHED_FILENAME), new Date().toISOString());
  }

  /**
   * Get a cached package by name and commit SHA.
   *
   * @param packageName - Logical package name.
   * @param commitSha - The commit whose tree is wanted.
   * @returns A descriptor when present, `null` otherwise.
   */
  async getPackage(packageName: string, commitSha: string): Promise<CachedPackage | null> {
    const path = this.packageDir(packageName, commitSha);
    try {
      const info = await stat(path);
      if (!info.isDirectory()) {
        return null;
      }
      return {
        packageName,
        commitSha,
        path,
        cachedAt: info.mtime,
      };
    } catch {
      return null;
    }
  }

  /**
   * The one way an entry is written. Fetches into a unique temp directory,
   * takes the entry's key from the commit the fetch REPORTS, refuses anything
   * that is not a full commit id, and atomically renames the tree onto
   * `${name}@${commit}` (DOR-2248). The caller's `expectedSha` never names an
   * entry: it only short-circuits a tree already cached under it and
   * de-duplicates concurrent fetches of it. The two differ when a ref moved
   * between the caller's lookup and the fetch, and the entry then holds the
   * commit that actually arrived.
   *
   * Concurrency: two fetches of one `${name}@${expectedSha}` in this process
   * share one fetch (a UI preview and an install fire together, and two git
   * processes must never collide in one directory). A valid tree another
   * process landed first wins, and ours is discarded. A partial (empty)
   * directory left by a crash is replaced.
   *
   * The fetch's error (git's stderr, via `GitFetchError`) propagates
   * verbatim, so a caller sees the real failure rather than a later
   * "manifest missing".
   *
   * @param packageName - Logical package name.
   * @param expectedSha - The commit the caller asked for.
   * @param fetch - Populates the temp directory it is given and resolves to
   *   the full commit id of what it put there.
   * @returns Where the tree is, and the commit it is.
   * @throws {Error} When the fetch reports anything but a full commit id.
   */
  async materializePackage(
    packageName: string,
    expectedSha: string,
    fetch: (tempDir: string) => Promise<string>
  ): Promise<MaterializedPackage> {
    const expectedPath = this.packageDir(packageName, expectedSha);

    // Fast path: an already-materialized valid package needs no fetch.
    if (await isNonEmptyDir(expectedPath)) {
      return { path: expectedPath, commitSha: expectedSha };
    }

    const key = `${packageName}@${expectedSha}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const work = this.fetchAndPromote(packageName, fetch).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, work);
    return work;
  }

  /**
   * Delete the `packages/` root entries lived in before their keys were
   * verified (DOR-2248). None of them is ever read, and a tree there may not
   * be the commit its name says, so this is disk, not cache. Idempotent.
   */
  async removeLegacyPackages(): Promise<void> {
    await rm(join(this.cacheRoot, LEGACY_PACKAGES_DIRNAME), { recursive: true, force: true });
  }

  /**
   * Fetch into a unique temp directory, key it by the reported commit, and
   * atomically promote it onto that entry. Cleans up the temp directory on
   * any failure.
   *
   * @internal
   */
  private async fetchAndPromote(
    packageName: string,
    fetch: (tempDir: string) => Promise<string>
  ): Promise<MaterializedPackage> {
    const treesRoot = join(this.cacheRoot, TREES_DIRNAME);
    await mkdir(treesRoot, { recursive: true });
    // The temp dir is a sibling of the final path so `rename` stays on the
    // same filesystem (cross-device renames throw EXDEV).
    const tempDir = await mkdtemp(join(treesRoot, '.tmp-fetch-'));

    let commitSha: string;
    let finalPath: string;
    try {
      commitSha = await fetch(tempDir);
      if (!isFullCommitSha(commitSha)) {
        throw new Error(
          `Refused to cache ${packageName}: the fetch reported "${commitSha}", which is not a full commit id`
        );
      }
      finalPath = this.packageDir(packageName, commitSha);
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true });
      throw err;
    }

    // Another process (not this Node process) may have landed a valid tree
    // since the fast-path check. Prefer it and discard ours: same commit,
    // same tree.
    if (await isNonEmptyDir(finalPath)) {
      await rm(tempDir, { recursive: true, force: true });
      return { path: finalPath, commitSha };
    }

    // Remove any partial/empty directory left by a prior crashed fetch so the
    // rename lands cleanly (rename onto a non-empty dir throws ENOTEMPTY).
    await rm(finalPath, { recursive: true, force: true });
    await rename(tempDir, finalPath);
    return { path: finalPath, commitSha };
  }

  /**
   * Enumerate every cached package across all names and SHAs. Entries whose
   * directory name does not match the `${name}@${sha}` convention are
   * silently skipped.
   */
  async listPackages(): Promise<CachedPackage[]> {
    const root = join(this.cacheRoot, TREES_DIRNAME);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }

    const results: CachedPackage[] = [];
    for (const entry of entries) {
      const parsed = parsePackageDirName(entry);
      if (!parsed) {
        continue;
      }
      const path = join(root, entry);
      try {
        const info = await stat(path);
        if (!info.isDirectory()) {
          continue;
        }
        results.push({
          packageName: parsed.packageName,
          commitSha: parsed.commitSha,
          path,
          cachedAt: info.mtime,
        });
      } catch {
        // Stat failed (race with prune?) — skip silently.
      }
    }
    return results;
  }

  /**
   * Garbage-collect cached packages. Groups every cached package by name,
   * sorts each group by `cachedAt` descending, and removes everything past
   * the `keepLastN`-th entry.
   *
   * @param opts - Pruning options. `keepLastN` defaults to `1` (keep only
   *   the most recently cached SHA per package name).
   * @returns The list of removed package descriptors.
   */
  async prune(opts?: { keepLastN?: number }): Promise<{ removed: CachedPackage[] }> {
    const keepLastN = opts?.keepLastN ?? 1;
    const grouped = groupByPackageName(await this.listPackages());
    const removed: CachedPackage[] = [];

    for (const group of grouped.values()) {
      group.sort((a, b) => b.cachedAt.getTime() - a.cachedAt.getTime());
      const toRemove = group.slice(keepLastN);
      for (const pkg of toRemove) {
        await rm(pkg.path, { recursive: true, force: true });
        removed.push(pkg);
      }
    }

    return { removed };
  }

  /** Wipe the entire cache directory. No-op when the directory does not exist. */
  async clear(): Promise<void> {
    await rm(this.cacheRoot, { recursive: true, force: true });
  }

  /**
   * Compute the directory path for a marketplace's cached document.
   *
   * @throws {PathEscapeError} When the name would place the directory outside
   *   the cache.
   */
  private marketplaceDir(marketplaceName: string): string {
    const root = join(this.cacheRoot, 'marketplaces');
    return assertContainedIn(root, join(root, marketplaceName));
  }

  /**
   * Compute the directory path for a content-addressable package tree.
   *
   * The containment assertion is the belt to the resolver's braces. Both halves
   * of this key are caller-influenced — the package name comes from the install
   * identifier, the SHA from a remote git server — and the directory it names
   * is one an `rm(recursive)` and a `rename` land on, so escaping the cache
   * plants (or deletes) a tree anywhere on disk. Callers upstream validate the
   * name; this is the check that still holds when a new one does not.
   *
   * @throws {PathEscapeError} When the key would place the directory outside
   *   the cache.
   */
  private packageDir(packageName: string, commitSha: string): string {
    const root = join(this.cacheRoot, TREES_DIRNAME);
    return assertContainedIn(root, join(root, `${packageName}@${commitSha}`));
  }
}

/**
 * Parse a `${name}@${sha}` directory name back into its components. Uses
 * `lastIndexOf('@')` so scoped names like `@scope/pkg@deadbeef` resolve
 * correctly. Returns `null` when the entry has no `@` separator or when
 * either side is empty.
 */
function parsePackageDirName(entry: string): { packageName: string; commitSha: string } | null {
  const at = entry.lastIndexOf('@');
  if (at <= 0 || at === entry.length - 1) {
    return null;
  }
  return {
    packageName: entry.slice(0, at),
    commitSha: entry.slice(at + 1),
  };
}

/**
 * True when `dir` exists, is a directory, and contains at least one entry.
 * An empty directory is treated as absent so a partial fetch (an empty
 * dir left by a crashed or colliding fetch) never masquerades as a
 * valid cached package.
 */
async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      return false;
    }
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/** Group cached packages by their logical name. */
function groupByPackageName(packages: CachedPackage[]): Map<string, CachedPackage[]> {
  const grouped = new Map<string, CachedPackage[]>();
  for (const pkg of packages) {
    const list = grouped.get(pkg.packageName) ?? [];
    list.push(pkg);
    grouped.set(pkg.packageName, list);
  }
  return grouped;
}
