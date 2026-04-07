/**
 * Package fetcher — thin wrapper that resolves marketplace package git URLs
 * to a cached on-disk path via the content-addressable `MarketplaceCache`
 * and an injected `TemplateDownloader`.
 *
 * Two surfaces:
 *
 * 1. {@link PackageFetcher.fetchFromGit} — resolves a commit SHA with
 *    `git ls-remote`, consults the cache, and delegates a cache miss to
 *    the template downloader's `cloneRepository` primitive.
 * 2. {@link PackageFetcher.fetchMarketplaceJson} — performs a plain HTTPS
 *    GET of the remote `marketplace.json`, parses it via
 *    `@dorkos/marketplace`, writes it to the cache on success, and serves
 *    the previously cached copy on network failure.
 *
 * This module is intentionally side-effect light — all disk I/O is
 * delegated to {@link MarketplaceCache} and all git I/O to the injected
 * downloader. The only system call made directly here is `git ls-remote`
 * via `execFile`, which is wrapped in a try/catch and degrades to a
 * deterministic placeholder SHA so the cache miss path always executes.
 *
 * @module services/marketplace/package-fetcher
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from '@dorkos/shared/logger';
import { parseMarketplaceJson, type MarketplaceJson } from '@dorkos/marketplace';
import type { MarketplaceCache } from './marketplace-cache.js';
import type { TemplateDownloader } from '../core/template-downloader.js';
import type { MarketplaceSource } from './types.js';

const execFileAsync = promisify(execFile);

/** Max time to wait for `git ls-remote` before falling back to a tmp SHA. */
const LS_REMOTE_TIMEOUT_MS = 15_000;

/** Options for {@link PackageFetcher.fetchFromGit}. */
export interface FetchPackageOptions {
  /** Package name (used for cache key). */
  packageName: string;
  /** Git URL to clone. */
  gitUrl: string;
  /** Optional ref/branch (defaults to the remote's default branch). */
  ref?: string;
  /** Force refetch even if the resolved SHA is already cached. */
  force?: boolean;
}

/** Result of {@link PackageFetcher.fetchFromGit}. */
export interface FetchedPackage {
  /** Filesystem path of the cached package. */
  path: string;
  /** Commit SHA the cache is keyed by. */
  commitSha: string;
  /** Whether the result came from the cache (no clone performed). */
  fromCache: boolean;
}

/**
 * Fetch marketplace packages and marketplace.json documents, caching
 * everything on disk via {@link MarketplaceCache}. Pure coordination —
 * delegates git clones to the injected {@link TemplateDownloader} and
 * HTTP fetches to the global `fetch` so both are trivially mockable.
 */
export class PackageFetcher {
  /**
   * Construct a fetcher bound to a specific cache, downloader, and logger.
   *
   * @param cache - Content-addressable cache for packages and marketplace.json.
   * @param templateDownloader - Abstraction over `git clone` — allows tests
   *   to replace the network boundary without touching disk.
   * @param logger - Logger for cache hits, stale fallbacks, and warnings.
   */
  constructor(
    private readonly cache: MarketplaceCache,
    private readonly templateDownloader: TemplateDownloader,
    private readonly logger: Logger
  ) {}

  /**
   * Fetch a package from a git URL. Caches by commit SHA so repeated fetches
   * for the same SHA are no-ops.
   *
   * Algorithm:
   *   1. Resolve commit SHA from gitUrl + ref via `git ls-remote` (with a
   *      deterministic fallback when git/network is unavailable).
   *   2. Consult `cache.getPackage(packageName, sha)`; return on hit unless
   *      `opts.force` is set.
   *   3. Reserve a cache directory via `cache.putPackage()`.
   *   4. Delegate the actual clone to `templateDownloader.cloneRepository`.
   *   5. Return the cached path, SHA, and `fromCache: false`.
   *
   * @param opts - Package identity and fetch options.
   */
  async fetchFromGit(opts: FetchPackageOptions): Promise<FetchedPackage> {
    if (isFileUrl(opts.gitUrl)) {
      const localPath = fileUrlToPath(opts.gitUrl);
      this.logger.debug('package-fetcher: serving local file:// package', {
        packageName: opts.packageName,
        path: localPath,
      });
      return { path: localPath, commitSha: 'local', fromCache: true };
    }

    const commitSha = await this.resolveCommitSha(opts.gitUrl, opts.ref);

    if (!opts.force) {
      const cached = await this.cache.getPackage(opts.packageName, commitSha);
      if (cached) {
        this.logger.debug('package-fetcher: cache hit', {
          packageName: opts.packageName,
          commitSha,
        });
        return { path: cached.path, commitSha, fromCache: true };
      }
    }

    const destDir = await this.cache.putPackage(opts.packageName, commitSha);
    await this.templateDownloader.cloneRepository(opts.gitUrl, destDir, opts.ref);
    this.logger.debug('package-fetcher: cloned package', {
      packageName: opts.packageName,
      commitSha,
      destDir,
    });
    return { path: destDir, commitSha, fromCache: false };
  }

  /**
   * Fetch and cache a marketplace.json from a marketplace source.
   *
   * On network failure, falls back to the previously cached copy (if any)
   * and logs a warning. If neither the fetch nor the cache returns a
   * document, the original fetch error is rethrown.
   *
   * @param source - Marketplace source descriptor.
   */
  async fetchMarketplaceJson(source: MarketplaceSource): Promise<MarketplaceJson> {
    if (isFileUrl(source.source)) {
      return this.readLocalMarketplaceJson(source);
    }
    const url = resolveMarketplaceJsonUrl(source.source);
    try {
      const json = await this.fetchAndParseMarketplaceJson(url);
      await this.cache.writeMarketplace(source.name, json);
      return json;
    } catch (err) {
      return this.serveStaleMarketplace(source.name, err);
    }
  }

  /**
   * Read and parse a `marketplace.json` document from a `file://` source on
   * disk. Used by the personal marketplace and any other locally-resolved
   * source. Caches the parsed document so resolver and search tools can read
   * it back through the same code paths as remote marketplaces.
   *
   * @param source - Marketplace source whose `source` field is a `file://` URL.
   */
  private async readLocalMarketplaceJson(source: MarketplaceSource): Promise<MarketplaceJson> {
    const root = fileUrlToPath(source.source);
    const manifestPath = path.join(root, 'marketplace.json');
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read local marketplace at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const parsed = parseMarketplaceJson(raw);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    await this.cache.writeMarketplace(source.name, parsed.marketplace);
    return parsed.marketplace;
  }

  /** GET the marketplace.json URL and parse it. Throws on any failure. */
  private async fetchAndParseMarketplaceJson(url: string): Promise<MarketplaceJson> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`marketplace.json fetch failed: ${response.status} ${response.statusText}`);
    }
    const raw = await response.text();
    const parsed = parseMarketplaceJson(raw);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return parsed.marketplace;
  }

  /** Serve the stale cached marketplace.json, or rethrow the fetch error. */
  private async serveStaleMarketplace(
    marketplaceName: string,
    fetchError: unknown
  ): Promise<MarketplaceJson> {
    const cached = await this.cache.readMarketplace(marketplaceName);
    if (cached) {
      this.logger.warn('package-fetcher: serving stale marketplace.json', {
        marketplaceName,
        error: fetchError instanceof Error ? fetchError.message : String(fetchError),
      });
      return cached.json;
    }
    throw fetchError;
  }

  /**
   * Resolve a commit SHA for `${gitUrl}#${ref}` via `git ls-remote`. Falls
   * back to a deterministic `tmp-${Date.now()}` placeholder on any failure
   * (missing git binary, no network, malformed output). The actual clone
   * downstream may still fail — that's fine, the cache miss path always
   * executes regardless of this return value.
   */
  private async resolveCommitSha(gitUrl: string, ref?: string): Promise<string> {
    const target = ref ?? 'HEAD';
    try {
      const { stdout } = await execFileAsync('git', ['ls-remote', gitUrl, target], {
        timeout: LS_REMOTE_TIMEOUT_MS,
      });
      const firstLine = stdout.split('\n').find((line) => line.trim().length > 0);
      if (firstLine) {
        const sha = firstLine.split('\t')[0]?.trim();
        if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) {
          return sha;
        }
      }
      this.logger.warn('package-fetcher: git ls-remote returned no usable SHA', { gitUrl, target });
    } catch (err) {
      this.logger.warn('package-fetcher: git ls-remote failed, using tmp SHA', {
        gitUrl,
        target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return `tmp-${Date.now()}`;
  }
}

/**
 * True when `source` is a `file://` URL pointing at a local directory. Used
 * to switch the fetcher between its remote (HTTP/git) and local (filesystem)
 * code paths.
 *
 * @param source - Raw marketplace source string from a `MarketplaceSource`.
 */
function isFileUrl(source: string): boolean {
  return source.startsWith('file://');
}

/**
 * Convert a `file://` URL into an absolute filesystem path. Caller is
 * responsible for ensuring the input is a `file://` URL — see {@link isFileUrl}.
 *
 * @param source - A `file://` URL produced by `pathToFileURL` or hand-built.
 */
function fileUrlToPath(source: string): string {
  return new URL(source).pathname;
}

/**
 * Derive the raw `marketplace.json` URL from a marketplace source string.
 *
 * - If the source already ends in `marketplace.json`, return it as-is.
 * - Otherwise, strip any `.git` suffix and append `/raw/main/marketplace.json`.
 *   This matches the GitHub/GitLab raw-file convention used by spec 01's
 *   marketplace.json discovery.
 */
function resolveMarketplaceJsonUrl(source: string): string {
  if (source.endsWith('marketplace.json')) {
    return source;
  }
  const base = source.replace(/\.git$/, '').replace(/\/$/, '');
  return `${base}/raw/main/marketplace.json`;
}
