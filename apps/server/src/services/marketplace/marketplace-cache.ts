/**
 * Marketplace cache — manages `${dorkHome}/cache/marketplace/` with TTL
 * semantics for `marketplace.json` documents and content-addressable storage
 * for cloned packages.
 *
 * Layout:
 * ```
 * ${dorkHome}/cache/marketplace/
 * ├── marketplaces/
 * │   └── ${name}/
 * │       ├── marketplace.json   # Last-fetched copy (TTL governed)
 * │       └── .last-fetched      # Timestamp stamp
 * └── packages/
 *     └── ${name}@${sha}/        # Content-addressable cloned package
 * ```
 *
 * TTL strategy:
 * - `marketplace.json`: 1h default. Past TTL the entry is still served but
 *   `stale: true` so callers can refresh in the background.
 * - Cloned packages: never expire. Garbage-collected only via {@link MarketplaceCache.prune}
 *   or {@link MarketplaceCache.clear}.
 *
 * @module services/marketplace/marketplace-cache
 */
import { mkdir, mkdtemp, readFile, rename, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarketplaceJson, type MarketplaceJson } from '@dorkos/marketplace';

/** Default TTL for cached `marketplace.json` documents (1 hour). */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Filename for the cached marketplace document. */
const MARKETPLACE_FILENAME = 'marketplace.json';

/** Filename for the last-fetched timestamp stamp. */
const LAST_FETCHED_FILENAME = '.last-fetched';

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
 * A descriptor for a cloned package living in the content-addressable
 * `packages/` cache.
 */
export interface CachedPackage {
  /** Logical package name (may include a leading scope, e.g. `@scope/pkg`). */
  packageName: string;
  /** Commit SHA the package was cloned at. */
  commitSha: string;
  /** Absolute path to the cached package directory. */
  path: string;
  /** Mtime of the cached package directory. */
  cachedAt: Date;
}

/**
 * Manages the on-disk marketplace cache. Pure file I/O — performs no
 * network requests of its own. Callers (source manager, package resolver)
 * are responsible for fetching upstream content and handing it to
 * {@link MarketplaceCache.writeMarketplace} / {@link MarketplaceCache.putPackage}.
 */
export class MarketplaceCache {
  private readonly ttlMs: number;

  /**
   * In-flight materialization promises keyed by `${name}@${sha}`. Two
   * concurrent {@link MarketplaceCache.materializePackage} calls for the same
   * cache key share a single clone: the first call performs the clone, every
   * subsequent caller awaits the same promise and reuses the result. This is
   * the in-process de-dup that stops a UI preview + install double-fetch from
   * racing two `git clone` processes into the same directory.
   */
  private readonly inFlight = new Map<string, Promise<string>>();

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

    const parsed = parseMarketplaceJson(raw);
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
   * @param commitSha - Commit SHA the package was cloned at.
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
   * Reserve a package directory in the cache and return its absolute path.
   *
   * The caller is responsible for writing the package contents into the
   * returned directory. The directory is created (idempotently) but left
   * empty — `putPackage` does no other I/O.
   *
   * @param packageName - Logical package name.
   * @param commitSha - Commit SHA the package will be cloned at.
   * @returns Absolute path to the reserved directory.
   */
  async putPackage(packageName: string, commitSha: string): Promise<string> {
    const path = this.packageDir(packageName, commitSha);
    await mkdir(path, { recursive: true });
    return path;
  }

  /**
   * Concurrency-safe, atomic package materialization. Guarantees that two
   * concurrent fetches of the same `${name}@${sha}` never both clone into (and
   * corrupt) the same directory. This is the bug behind the failing `flow`
   * github-subdir install: a UI preview and install fire simultaneously and
   * two `git clone` processes collide on git's template copy step.
   *
   * Algorithm:
   *   1. If the final cache path already holds a valid (non-empty) package,
   *      reuse it immediately (no clone).
   *   2. If a materialization for this key is already in flight, await it and
   *      reuse its result (in-process de-dup).
   *   3. Otherwise clone into a unique sibling temp directory, then atomically
   *      `rename` it onto the final cache path. A partial/empty directory left
   *      by a prior crashed clone is removed before the rename so it can never
   *      shadow a clean result.
   *
   * The injected `clone` callback receives the temp directory to populate; any
   * error it throws (e.g. a `GitSpawnError` carrying git stderr + exit code)
   * propagates verbatim so callers surface the real fetch failure rather than
   * a downstream "manifest missing" validation error.
   *
   * @param packageName - Logical package name.
   * @param commitSha - Commit SHA the package is cloned at (the cache key).
   * @param clone - Callback that clones/populates the given temp directory.
   * @returns Absolute path to the final cache directory holding the package.
   */
  async materializePackage(
    packageName: string,
    commitSha: string,
    clone: (tempDir: string) => Promise<void>
  ): Promise<string> {
    const finalPath = this.packageDir(packageName, commitSha);

    // Fast path: an already-materialized valid package needs no clone.
    if (await isNonEmptyDir(finalPath)) {
      return finalPath;
    }

    const key = `${packageName}@${commitSha}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const work = this.cloneAndPromote(finalPath, clone).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, work);
    return work;
  }

  /**
   * Clone into a unique temp directory and atomically promote it onto the
   * final cache path. Cleans up the temp directory on clone failure and
   * removes any partial directory occupying the final path before promoting.
   *
   * @internal
   */
  private async cloneAndPromote(
    finalPath: string,
    clone: (tempDir: string) => Promise<void>
  ): Promise<string> {
    const packagesRoot = join(this.cacheRoot, 'packages');
    await mkdir(packagesRoot, { recursive: true });
    // The temp dir is a sibling of the final path so `rename` stays on the
    // same filesystem (cross-device renames throw EXDEV).
    const tempDir = await mkdtemp(join(packagesRoot, '.tmp-clone-'));

    try {
      await clone(tempDir);
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true });
      throw err;
    }

    // Re-check the final path under the in-flight lock: another process (not
    // this Node process) may have landed a valid clone since the fast-path
    // check. Prefer the existing valid package and discard our temp clone.
    if (await isNonEmptyDir(finalPath)) {
      await rm(tempDir, { recursive: true, force: true });
      return finalPath;
    }

    // Remove any partial/empty directory left by a prior crashed clone so the
    // rename lands cleanly (rename onto a non-empty dir throws ENOTEMPTY).
    await rm(finalPath, { recursive: true, force: true });
    await rename(tempDir, finalPath);
    return finalPath;
  }

  /**
   * Enumerate every cached package across all names and SHAs. Entries whose
   * directory name does not match the `${name}@${sha}` convention are
   * silently skipped.
   */
  async listPackages(): Promise<CachedPackage[]> {
    const root = join(this.cacheRoot, 'packages');
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

  /** Compute the directory path for a marketplace's cached document. */
  private marketplaceDir(marketplaceName: string): string {
    return join(this.cacheRoot, 'marketplaces', marketplaceName);
  }

  /** Compute the directory path for a content-addressable package clone. */
  private packageDir(packageName: string, commitSha: string): string {
    return join(this.cacheRoot, 'packages', `${packageName}@${commitSha}`);
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
 * An empty directory is treated as absent so a partial clone (an empty
 * reserved dir left by a crashed or colliding clone) never masquerades as a
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
