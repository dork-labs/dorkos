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
 *     ├── ${name}@${sha}/            # The tree of commit ${sha}, verified (DOR-2248)
 *     └── ${name}@${sha}~${digest}/  # One subfolder of it, sparse
 * ```
 *
 * An entry's key is the commit its checkout verifiably holds: the only way in
 * is {@link MarketplaceCache.materializePackage}, which takes the key from the
 * fetch (`lib/git-tree.ts` reads it from `HEAD`) and refuses anything that is
 * not a full commit id. A sparse (`git-subdir`) entry holds a different tree
 * from the whole repository at the same commit, so its key carries a digest of
 * the subfolder: `${name}@${sha}~${digest}`. Entries from before that rule
 * lived under `packages/`; they are never read, and
 * {@link MarketplaceCache.removeLeftovers} deletes them.
 *
 * TTL strategy:
 * - `marketplace.json`: 1h default. Past TTL the entry is still served but
 *   `stale: true` so callers can refresh in the background.
 * - Package trees: an entry's mtime is its last use. Every call that hands out
 *   an entry's path stamps it, and {@link MarketplaceCache.removeUnused} never
 *   removes an entry used in the last {@link IN_USE_GRACE_MS}, whatever its
 *   caller's rule says. Which unused entries to keep is decided by
 *   `package-cache-retention.ts`, which sweeps after every new entry
 *   ({@link MarketplaceCache.onEntryWritten}), at startup, and on
 *   `dorkos cache prune` (DOR-2249). {@link MarketplaceCache.clear} empties it.
 *
 * @module services/marketplace/marketplace-cache
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
  readdir,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarketplaceJsonLenient, type MarketplaceJson } from '@dorkos/marketplace';
import { assertContainedIn } from './lib/package-paths.js';
import { isFullCommitSha } from './lib/git-tree.js';
import { directorySize } from './lib/directory-size.js';

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
 * removed by {@link MarketplaceCache.removeLeftovers}.
 */
const LEGACY_PACKAGES_DIRNAME = 'packages';

/** Name prefix of the temp directory a fetch runs in, beside its entry. */
const TEMP_FETCH_PREFIX = '.tmp-fetch-';

/**
 * Name prefix of an entry a sweep has renamed aside and is deleting. Never
 * read; a crash can leave one, and {@link MarketplaceCache.removeLeftovers}
 * deletes it.
 */
const TEMP_PRUNE_PREFIX = '.tmp-prune-';

/**
 * How long after its last use an entry is off-limits to a sweep: 15 minutes.
 *
 * A reader (an install, a preview, the update check) holds an entry's path
 * only for the seconds it takes to validate the tree or copy it into staging,
 * and nothing keeps a path into the cache after its request. Stamping on use
 * and sparing anything stamped recently is git gc's grace period in miniature.
 * Every reader is in this server process (one server holds a data directory,
 * `lib/instance-lock.ts`), so the lock plus this grace covers all of them.
 */
export const IN_USE_GRACE_MS = 15 * 60 * 1000;

/** Separates an entry's commit from its subfolder digest: `${name}@${sha}~${digest}`. */
const SUBPATH_SEPARATOR = '~';

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
  /**
   * {@link subpathDigest} of the subfolder a sparse entry holds; `''` for an
   * entry holding the whole repository.
   */
  subpathDigest: string;
  /** Absolute path to the cached package directory. */
  path: string;
  /** When the entry was last handed out (its directory's mtime). */
  lastUsedAt: Date;
}

/** What one {@link MarketplaceCache.removeUnused} call removed. */
export interface RemovedEntries {
  /** The entries that left disk, as they were listed before removal. */
  removed: CachedPackage[];
  /** Bytes the removed entries occupied. */
  freedBytes: number;
  /** Entries that could not be removed, with why; the rest still were. */
  failed: { entry: CachedPackage; error: string }[];
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
   * Tail of the in-process lock ({@link MarketplaceCache.exclusive}). It
   * serialises only short critical sections: a reader's "exists? stamp it",
   * a fetch's landing, and a sweep's "still unused? rename it aside".
   */
  private lockTail: Promise<void> = Promise.resolve();

  /** Listeners told when a fetch lands a new entry ({@link onEntryWritten}). */
  private readonly entryWrittenListeners = new Set<() => void>();

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
   * Forget one marketplace's cached `marketplace.json`. No-op when nothing is
   * cached under that name.
   *
   * A listing is keyed by the source's NAME, not its address, so a listing
   * that outlives its source is inherited by the next source given that name:
   * its old packages would be listed, resolved and installed from a source
   * that never published them (DOR-2304). Removing a source calls this, and
   * adding one calls it again before the first fetch, to clear what removals
   * made before this method existed left on disk.
   *
   * @param marketplaceName - The configured marketplace identifier.
   * @throws {PathEscapeError} When the name would place the directory outside
   *   the cache.
   */
  async removeMarketplace(marketplaceName: string): Promise<void> {
    await rm(this.marketplaceDir(marketplaceName), { recursive: true, force: true });
  }

  /**
   * Get a cached package tree by name, commit and subfolder, and stamp it as
   * used so a sweep leaves it alone while the caller reads it.
   *
   * @param packageName - Logical package name.
   * @param commitSha - The commit whose tree is wanted.
   * @param subpath - The subfolder a sparse entry holds; `''` for the whole
   *   repository. Part of the key: a sparse checkout is a different tree.
   * @returns A descriptor when a non-empty entry is present, `null` otherwise.
   */
  async getPackage(
    packageName: string,
    commitSha: string,
    subpath: string
  ): Promise<CachedPackage | null> {
    const path = this.packageDir(packageName, commitSha, subpath);
    const usedAt = await this.stampIfPresent(path);
    if (usedAt === null) return null;
    return {
      packageName,
      commitSha,
      subpathDigest: subpathDigest(subpath),
      path,
      lastUsedAt: usedAt,
    };
  }

  /**
   * The one way an entry is written. Fetches into a unique temp directory,
   * takes the entry's key from the commit the fetch REPORTS, refuses anything
   * that is not a full commit id, and atomically renames the tree onto
   * `${name}@${commit}` — `${name}@${commit}~${digest}` for a sparse entry,
   * where the digest is of the subfolder (DOR-2248). The caller's
   * `expectedSha` never names an
   * entry: it only short-circuits a tree already cached under it and
   * de-duplicates concurrent fetches of it. The two differ when a ref moved
   * between the caller's lookup and the fetch, and the entry then holds the
   * commit that actually arrived.
   *
   * Every entry it hands out is stamped as used, and a fetch that lands a new
   * entry tells the {@link onEntryWritten} listeners.
   *
   * Concurrency: two fetches of one entry key in this process
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
   * @param subpath - The subfolder the fetch checks out; `''` for the whole
   *   repository.
   * @param fetch - Populates the temp directory it is given and resolves to
   *   the full commit id of what it put there.
   * @returns Where the tree is, and the commit it is.
   * @throws {Error} When the fetch reports anything but a full commit id.
   */
  async materializePackage(
    packageName: string,
    expectedSha: string,
    subpath: string,
    fetch: (tempDir: string) => Promise<string>
  ): Promise<MaterializedPackage> {
    const expectedPath = this.packageDir(packageName, expectedSha, subpath);

    // Fast path: an already-materialized valid package needs no fetch. It is
    // stamped as used, like a `getPackage` hit.
    if ((await this.stampIfPresent(expectedPath)) !== null) {
      return { path: expectedPath, commitSha: expectedSha };
    }

    const key = expectedPath;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const work = this.fetchAndPromote(packageName, subpath, fetch).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, work);
    return work;
  }

  /**
   * Delete what no entry is ever read from, once, before any fetch runs (the
   * server calls it at startup):
   *
   * - the `packages/` root entries lived in before their keys were verified
   *   (DOR-2248): a tree there may not be the commit its name says;
   * - temp fetch directories a crash left in `trees/`, whose `.git` may still
   *   hold a half-fetched repository;
   * - entries a sweep renamed aside and a crash stopped it deleting.
   *
   * Idempotent. Not safe while a fetch is running in this cache.
   */
  async removeLeftovers(): Promise<void> {
    await rm(join(this.cacheRoot, LEGACY_PACKAGES_DIRNAME), { recursive: true, force: true });
    const treesRoot = join(this.cacheRoot, TREES_DIRNAME);
    let entries: string[];
    try {
      entries = await readdir(treesRoot);
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter(
          (entry) => entry.startsWith(TEMP_FETCH_PREFIX) || entry.startsWith(TEMP_PRUNE_PREFIX)
        )
        .map((entry) => rm(join(treesRoot, entry), { recursive: true, force: true }))
    );
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
    subpath: string,
    fetch: (tempDir: string) => Promise<string>
  ): Promise<MaterializedPackage> {
    const treesRoot = join(this.cacheRoot, TREES_DIRNAME);
    await mkdir(treesRoot, { recursive: true });
    // The temp dir is a sibling of the final path so `rename` stays on the
    // same filesystem (cross-device renames throw EXDEV).
    const tempDir = await mkdtemp(join(treesRoot, TEMP_FETCH_PREFIX));

    let commitSha: string;
    let finalPath: string;
    try {
      commitSha = await fetch(tempDir);
      if (!isFullCommitSha(commitSha)) {
        throw new Error(
          `Refused to cache ${packageName}: the fetch reported "${commitSha}", which is not a full commit id`
        );
      }
      finalPath = this.packageDir(packageName, commitSha, subpath);
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true });
      throw err;
    }

    // Landing runs under the lock, so a sweep cannot remove the entry between
    // the check and the stamp.
    const landedOurs = await this.exclusive(async () => {
      // Another process (not this Node process) may have landed a valid tree
      // since the fast-path check. Prefer it and discard ours: same commit,
      // same tree.
      if (await isNonEmptyDir(finalPath)) {
        await stampUsed(finalPath);
        return false;
      }
      // Remove any partial/empty directory left by a prior crashed fetch so the
      // rename lands cleanly (rename onto a non-empty dir throws ENOTEMPTY).
      await rm(finalPath, { recursive: true, force: true });
      await rename(tempDir, finalPath);
      await stampUsed(finalPath);
      return true;
    });

    if (landedOurs) {
      for (const listener of this.entryWrittenListeners) listener();
    } else {
      await rm(tempDir, { recursive: true, force: true });
    }
    return { path: finalPath, commitSha };
  }

  /**
   * Be told each time a fetch lands a new entry: the one way the cache grows,
   * so the one signal its retention owner needs. Not called for a cache hit,
   * a failed fetch, or a tree that was already there when the fetch landed.
   *
   * @param listener - Called synchronously after the entry is in place. It
   *   must not throw; start any work it triggers in the background.
   * @returns A function that stops the notifications.
   */
  onEntryWritten(listener: () => void): () => void {
    this.entryWrittenListeners.add(listener);
    return () => {
      this.entryWrittenListeners.delete(listener);
    };
  }

  /**
   * Remove every entry the caller's rule does not keep and that nobody has
   * used in the last {@link IN_USE_GRACE_MS}. The grace is not the caller's to
   * waive: it is this cache's promise to everyone it handed a path.
   *
   * Each removal re-checks the stamp and renames the entry aside to
   * `.tmp-prune-*` under the lock, then measures and deletes the renamed copy
   * outside it. A reader that stamps first keeps its entry; one that comes
   * after the rename sees a miss and fetches. In-progress fetches
   * (`.tmp-fetch-*`) are never entries, so never candidates.
   *
   * @param keep - Given every entry, returns the paths to keep. Called once,
   *   with the listing this call works from.
   * @returns What was removed, the bytes freed, and any entry that could not be
   *   removed (the others still are).
   */
  async removeUnused(
    keep: (entries: readonly CachedPackage[]) => ReadonlySet<string>
  ): Promise<RemovedEntries> {
    const treesRoot = join(this.cacheRoot, TREES_DIRNAME);
    const entries = await this.listPackages();
    const kept = keep(entries);
    const result: RemovedEntries = { removed: [], freedBytes: 0, failed: [] };

    for (const entry of entries) {
      if (kept.has(entry.path)) continue;
      try {
        const aside = await this.exclusive(async () => {
          let lastUsedMs: number;
          try {
            lastUsedMs = (await stat(entry.path)).mtimeMs;
          } catch {
            return null; // Already gone.
          }
          if (Date.now() - lastUsedMs < IN_USE_GRACE_MS) return null;
          const target = join(treesRoot, `${TEMP_PRUNE_PREFIX}${randomUUID()}`);
          await rename(entry.path, target);
          return target;
        });
        if (aside === null) continue;
        const bytes = await directorySize(aside);
        await rm(aside, { recursive: true, force: true });
        result.removed.push(entry);
        result.freedBytes += bytes;
      } catch (err) {
        result.failed.push({ entry, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  /**
   * Stamp `path` as used now if it holds a valid entry, as one step under the
   * lock.
   *
   * @returns When it was stamped, or `null` when there is no valid entry.
   * @internal
   */
  private stampIfPresent(path: string): Promise<Date | null> {
    return this.exclusive(async () => {
      // An empty directory is a crashed or colliding fetch, never an entry.
      if (!(await isNonEmptyDir(path))) return null;
      return stampUsed(path);
    });
  }

  /**
   * Run `fn` with no other critical section of this cache running. Sections
   * are a few system calls each, so a promise chain is all the lock needs.
   *
   * @internal
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockTail.then(fn);
    this.lockTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Enumerate every cached package across all names and SHAs. Entries whose
   * directory name does not match the `${name}@${sha}` convention (including
   * in-progress fetches and entries being removed) are silently skipped.
   * Listing is not use: it stamps nothing.
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
      if (entry.startsWith(TEMP_FETCH_PREFIX) || entry.startsWith(TEMP_PRUNE_PREFIX)) continue;
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
          subpathDigest: parsed.subpathDigest,
          path,
          lastUsedAt: info.mtime,
        });
      } catch {
        // Stat failed (removed by a concurrent sweep or clear) — skip silently.
      }
    }
    return results;
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
   * Compute the directory path for a content-addressable package tree:
   * `${name}@${sha}` for a whole repository, `${name}@${sha}~${digest}` for a
   * sparse checkout of `subpath`, the digest being the first 12 hex digits of
   * the subfolder's SHA-256 (a path may hold characters a directory name
   * cannot, and its length is unbounded).
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
  private packageDir(packageName: string, commitSha: string, subpath: string): string {
    const root = join(this.cacheRoot, TREES_DIRNAME);
    const digest = subpathDigest(subpath);
    const tree = digest === '' ? '' : `${SUBPATH_SEPARATOR}${digest}`;
    return assertContainedIn(root, join(root, `${packageName}@${commitSha}${tree}`));
  }
}

/**
 * The sparse-entry suffix for `subpath`: the first 12 hex digits of its
 * SHA-256, or `''` for the whole repository (which has no suffix).
 *
 * @param subpath - The subfolder an entry holds; `''` for the whole repository.
 */
export function subpathDigest(subpath: string): string {
  if (subpath === '') return '';
  return createHash('sha256').update(subpath).digest('hex').slice(0, 12);
}

/**
 * Stamp an entry as used now (its directory's mtime). Best-effort: a tree
 * DorkOS can read but not stamp (root-owned, or on a read-only disk) is still
 * served, and keeps its old time. Such a tree loses only the grace period's
 * protection, and a sweep cannot move a folder it may not modify either.
 *
 * @returns When the entry was last used: now, or its unchanged time.
 */
async function stampUsed(path: string): Promise<Date> {
  const now = new Date();
  try {
    await utimes(path, now, now);
    return now;
  } catch {
    return (await stat(path)).mtime;
  }
}

/**
 * Parse a `${name}@${sha}` or `${name}@${sha}~${digest}` directory name back
 * into its package, commit and subfolder digest. Uses `lastIndexOf('@')` so scoped names like
 * `@scope/pkg@deadbeef` resolve correctly. Returns `null` when the entry has
 * no `@` separator or when either side is empty.
 */
function parsePackageDirName(
  entry: string
): { packageName: string; commitSha: string; subpathDigest: string } | null {
  const at = entry.lastIndexOf('@');
  if (at <= 0 || at === entry.length - 1) {
    return null;
  }
  const [commitSha = '', digest = ''] = entry.slice(at + 1).split(SUBPATH_SEPARATOR);
  if (commitSha === '') return null;
  return { packageName: entry.slice(0, at), commitSha, subpathDigest: digest };
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
