/**
 * Package fetcher — resolves marketplace package sources to a cached on-disk
 * tree via the content-addressable `MarketplaceCache` and an injected
 * {@link GitTreeSource}.
 *
 * Two surfaces:
 *
 * 1. {@link PackageFetcher.fetchPackage} (and the legacy
 *    {@link PackageFetcher.fetchFromGit}) — every git source form goes through
 *    one path: look the ref up, serve a cached tree for that commit, or fetch
 *    exactly that commit and cache it under the commit the checkout verifiably
 *    holds (DOR-2248). A ref that does not exist or a remote that cannot be
 *    reached fails with a plain error, and nothing is fetched.
 * 2. {@link PackageFetcher.fetchMarketplaceJson} — performs a plain HTTPS
 *    GET of the remote `marketplace.json`, parses it via
 *    `@dorkos/marketplace`, writes it to the cache on success, and serves
 *    the previously cached copy on network failure.
 *
 * This module is intentionally side-effect light — disk I/O is delegated to
 * {@link MarketplaceCache} and all git I/O to the injected source. An address
 * this module will not hand to `git` throws `UnsupportedSourceUrlError` before
 * any git process starts (DOR-1799).
 *
 * A `file://` address never reaches `git`, so it answers the other question
 * instead: the directory boundary, which is what `PackageResolver` already
 * asks of the `./some/path` spelling of the same install (DOR-1825). Two local
 * spellings, one answer.
 *
 * @module services/marketplace/package-fetcher
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_MAX_BYTES,
  TooLargeError,
  readResponseTextWithin,
  readTextFileWithin,
} from '@dorkos/shared/bounded-read';
import type { Logger } from '@dorkos/shared/logger';
import {
  parseDorkosSidecar,
  parseMarketplaceJson,
  parseMarketplaceJsonLenient,
  resolvePluginSource,
  type DorkosSidecar,
  type MarketplaceJson,
  type PluginSource,
  type ResolvedSourceDescriptor,
  type SourceKey,
} from '@dorkos/marketplace';
import type { MarketplaceCache } from './marketplace-cache.js';
import type { MarketplaceSource } from './types.js';
import { relativePathResolver } from './source-resolvers/relative-path.js';
import { gitResolver } from './source-resolvers/git.js';
import { npmResolver } from './source-resolvers/npm.js';
import { assertSafeGitRemote } from './source-url-policy.js';
import { validateBoundary } from '../../lib/boundary.js';
import {
  GitRefNotFoundError,
  GitRemoteUnreachableError,
  isFullCommitSha,
  type GitTreeSource,
} from './lib/git-tree.js';

/**
 * Options for {@link PackageFetcher.fetchPackage} (and the legacy
 * `fetchFromGit` wrapper).
 *
 * The new dispatch-based fetcher accepts a discriminated-union `source`
 * field that the underlying source resolvers branch on. The legacy
 * `gitUrl` field is kept for backward compatibility with the
 * pre-superset install pipeline; it will be removed once
 * `marketplace-installer.ts` migrates entirely to the new shape.
 */
export interface FetchPackageOptions {
  /** Package name (used for cache key). */
  packageName: string;
  /**
   * Discriminated-union plugin source. Required by the new dispatch
   * fetcher; optional only because the legacy `fetchFromGit` shim still
   * accepts callers that pass a bare `gitUrl`.
   */
  source?: PluginSource;
  /**
   * Marketplace clone root on disk for relative-path source resolution.
   * Required when `source` is a relative-path string; ignored otherwise.
   */
  marketplaceRoot?: string;
  /** Optional `metadata.pluginRoot` from the source marketplace.json. */
  pluginRoot?: string;
  /**
   * Legacy git URL — only consulted by the deprecated `fetchFromGit`
   * code path. Prefer `source: { source: 'url', url }` instead.
   *
   * @deprecated Use `source` instead.
   */
  gitUrl?: string;
  /** Legacy `fetchFromGit` only: the ref to fetch (default `HEAD`, the remote's default branch). */
  ref?: string;
  /** Skip the cache lookup; a tree already cached for the commit is still reused. */
  force?: boolean;
}

/** Result of {@link PackageFetcher.fetchPackage}. */
export interface FetchedPackage {
  /** Filesystem path of the cached package. */
  path: string;
  /**
   * The commit the tree is: a full commit id for a git source, read from the
   * checkout. `local` for a `file://` address and `relative-path` for a path
   * inside a local marketplace, which `isRealCommitSha` rejects.
   */
  commitSha: string;
  /** Whether the result came from the cache (no clone performed). */
  fromCache: boolean;
}

/** One git tree to fetch, as the source resolvers describe it. */
export interface GitTreeFetch {
  /** Package name (the cache key's first half). */
  packageName: string;
  /** The URL git is given. */
  cloneUrl: string;
  /** `HEAD`, a branch or tag, a `refs/…` name, or a full commit id. */
  ref: string;
  /** The package's directory in the repository; `''` for the whole tree. */
  subpath: string;
  /** Skip the cache lookup. */
  force?: boolean;
}

/**
 * Dependencies that source resolvers need to perform their work.
 *
 * Built once by {@link PackageFetcher} and threaded through every
 * resolver call so the resolvers themselves stay easy to unit-test
 * (each one accepts a mock `FetcherDeps` and asserts on the spies).
 */
export interface FetcherDeps {
  /**
   * Fetch one git tree through the cache: the entry's path (the repository
   * root, sparse to `subpath` when one is given) and its verified commit. A
   * whole-repo `file://` address is served in place instead, with the commit
   * `local`. Throws `UnsupportedSourceUrlError` for an address the fetcher
   * will not hand to `git` (DOR-1799).
   */
  fetchGitTree(opts: GitTreeFetch): Promise<FetchedPackage>;
}

/**
 * How long a marketplace server gets to answer a `marketplace.json` request.
 * A bare `fetch` has no deadline, so one slow server could hold an update-check
 * slot (and a CLI waiting on it) for minutes; this matches `git ls-remote`'s
 * 15-second limit, and a stale cached copy still answers when it runs out.
 */
export const MARKETPLACE_JSON_TIMEOUT_MS = 15_000;

/**
 * Fetch marketplace packages and marketplace.json documents, caching
 * everything on disk via {@link MarketplaceCache}. Pure coordination —
 * delegates git to the injected {@link GitTreeSource} and HTTP fetches to the
 * global `fetch` so both are trivially mockable.
 */
export class PackageFetcher {
  /**
   * Construct a fetcher bound to a specific cache, git source, and logger.
   *
   * @param cache - Content-addressable cache for packages and marketplace.json.
   * @param git - Ref lookup and verified tree fetch (`gitTreeSource` in
   *   production) — lets tests replace the network in one place.
   * @param logger - Logger for cache hits, stale fallbacks, and warnings.
   */
  constructor(
    private readonly cache: MarketplaceCache,
    private readonly git: GitTreeSource,
    private readonly logger: Logger
  ) {}

  /**
   * Fetch a package from a bare git URL (the legacy, pre-`source` install
   * input) at `opts.ref`, default `HEAD`.
   *
   * A `file://` address is served in place once the directory boundary allows
   * it (DOR-1825), with the commit `local`. Anything else goes through
   * {@link fetchGitTree}, the path every git source form shares.
   *
   * @param opts - Package identity and fetch options.
   * @throws {UnsupportedSourceUrlError} When `opts.gitUrl` is a remote address
   *   {@link assertSafeGitRemote} refuses. Nothing is fetched, and no git
   *   subprocess starts.
   * @throws {BoundaryError} When `opts.gitUrl` is a `file://` address outside
   *   the configured directory boundary (DOR-1825).
   * @throws {GitRefNotFoundError | GitRemoteUnreachableError | GitFetchError}
   *   When the ref cannot be resolved or its tree cannot be fetched.
   */
  async fetchFromGit(opts: FetchPackageOptions): Promise<FetchedPackage> {
    const gitUrl = opts.gitUrl;
    if (gitUrl === undefined) {
      throw new Error(
        `[package-fetcher] fetchFromGit called without gitUrl for package '${opts.packageName}' — use fetchPackage with a discriminated source instead`
      );
    }
    return this.fetchGitSource({
      packageName: opts.packageName,
      cloneUrl: gitUrl,
      ref: opts.ref ?? 'HEAD',
      subpath: '',
      force: opts.force,
    });
  }

  /**
   * Fetch a package's tree at one exact commit, whatever ref its source
   * names: the commit an install recorded, even after the branch it came from
   * has moved on (DOR-2248). Every git source form is covered, because a
   * {@link SourceKey} is what all three reduce to.
   *
   * The entry is cached as `<name>@<commitSha>` and holds exactly that
   * commit's tree (the checkout's `HEAD` is verified against it). A server
   * that will not serve a commit by id is asked for its branches and tags
   * instead; a commit reachable from none of them fails with
   * `GitCommitNotFoundError`, never with some other commit.
   *
   * @param opts.packageName - The package (the cache key's first half).
   * @param opts.sourceKey - Where it was fetched from: `install-metadata.json`'s
   *   `sourceKey`. Its `ref` is ignored; the commit is the ref.
   * @param opts.commitSha - The full commit id to fetch.
   * @returns The package's directory in the entry (below `sourceKey.subpath`)
   *   and the commit, which always equals `opts.commitSha`.
   * @throws {Error} When `opts.commitSha` is not a full commit id.
   * @throws {UnsupportedSourceUrlError} When the address is one this fetcher
   *   will not hand to `git`.
   * @throws {GitCommitNotFoundError | GitFetchError} When the commit cannot be
   *   fetched.
   */
  async fetchAtCommit(opts: {
    packageName: string;
    sourceKey: SourceKey;
    commitSha: string;
  }): Promise<FetchedPackage> {
    const { packageName, sourceKey, commitSha } = opts;
    if (!isFullCommitSha(commitSha)) {
      throw new Error(`Can't fetch ${packageName} at "${commitSha}": that is not a full commit id`);
    }
    const fetched = await this.fetchGitTree({
      packageName,
      cloneUrl: sourceKey.cloneUrl,
      ref: commitSha,
      subpath: sourceKey.subpath,
    });
    return sourceKey.subpath === ''
      ? fetched
      : { ...fetched, path: path.join(fetched.path, sourceKey.subpath) };
  }

  /**
   * Route a git-shaped address: a whole-repo `file://` address is a folder on
   * this machine, served in place once the directory boundary allows it
   * (DOR-1825), with the commit `local`; everything else is
   * {@link fetchGitTree}. A `file://` address with a subpath is not a shape
   * any source produces, and `fetchGitTree` refuses it with the rest of the
   * unsupported transports.
   *
   * @internal
   */
  private async fetchGitSource(opts: GitTreeFetch): Promise<FetchedPackage> {
    if (isFileUrl(opts.cloneUrl) && opts.subpath === '') {
      const localPath = fileUrlToPath(opts.cloneUrl);
      await this.assertLocalPathAllowed(localPath, opts.cloneUrl);
      this.logger.debug('package-fetcher: serving local file:// package', {
        packageName: opts.packageName,
        path: localPath,
      });
      return { path: localPath, commitSha: 'local', fromCache: true };
    }
    return this.fetchGitTree(opts);
  }

  /**
   * The one path every git tree takes (DOR-2248):
   *
   *   1. Refuse an address this fetcher will not hand to `git` (DOR-1799).
   *      The address arrives checked when a package author wrote it (the
   *      `marketplace.json` schema) and unchecked when an operator typed
   *      `name@<url>` — so both provenances answer the same question here.
   *   2. Resolve the ref to an exact commit. A ref the remote does not have,
   *      or a remote that cannot be asked, fails now, before any fetch.
   *   3. Serve a tree already cached for that commit, unless `force`.
   *   4. Otherwise fetch it into the cache, which keys the entry by the
   *      commit the fetch REPORTS — the checkout's `HEAD`, not the lookup.
   *
   * @internal
   */
  private async fetchGitTree(opts: GitTreeFetch): Promise<FetchedPackage> {
    const { packageName, cloneUrl, ref, subpath } = opts;
    this.assertRemoteAllowed(cloneUrl);

    const found = await this.git.lookup(cloneUrl, ref);
    if (found.kind === 'missing') throw new GitRefNotFoundError(ref, cloneUrl);
    if (found.kind === 'unreachable') throw new GitRemoteUnreachableError(cloneUrl, found.reason);

    if (!opts.force) {
      const cached = await this.cache.getPackage(packageName, found.commitSha, subpath);
      if (cached) {
        this.logger.debug('package-fetcher: cache hit', {
          packageName,
          commitSha: found.commitSha,
        });
        return { path: cached.path, commitSha: found.commitSha, fromCache: true };
      }
    }

    const { path: destDir, commitSha } = await this.cache.materializePackage(
      packageName,
      found.commitSha,
      subpath,
      (tempDir) =>
        this.git.fetch({
          cloneUrl,
          commitSha: found.commitSha,
          refName: found.refName,
          subpath,
          destDir: tempDir,
        })
    );
    if (commitSha !== found.commitSha) {
      // Only on a server that would not serve the looked-up commit by id: the
      // ref moved in between, and the entry holds the commit that arrived.
      this.logger.info(
        'package-fetcher: ref moved while fetching; cached the commit that arrived',
        {
          packageName,
          ref,
          lookedUp: found.commitSha,
          fetched: commitSha,
        }
      );
    }
    this.logger.debug('package-fetcher: fetched package', { packageName, commitSha, destDir });
    return { path: destDir, commitSha, fromCache: false };
  }

  /**
   * Dispatch-based package fetcher. Routes to the appropriate
   * source-resolver based on the discriminated `PluginSource` in
   * {@link FetchPackageOptions.source}. This is the preferred entry point
   * for marketplace-05-era install flows; `fetchFromGit` remains as a
   * thin shim for callers that still pass a bare `gitUrl`.
   *
   * @param opts - Package identity, discriminated source, and context.
   * @throws Error when `opts.source` is missing.
   */
  async fetchPackage(opts: FetchPackageOptions): Promise<FetchedPackage> {
    if (opts.source === undefined) {
      // Back-compat: delegate to the legacy path when a bare gitUrl is passed.
      if (opts.gitUrl !== undefined) {
        return this.fetchFromGit(opts);
      }
      throw new Error(
        `[package-fetcher] fetchPackage called without source or gitUrl for package '${opts.packageName}'`
      );
    }

    const resolved: ResolvedSourceDescriptor = resolvePluginSource(opts.source, {
      marketplaceRoot: opts.marketplaceRoot,
      pluginRoot: opts.pluginRoot,
    });

    const deps = this.buildFetcherDeps();

    switch (resolved.type) {
      case 'relative-path':
        return relativePathResolver(resolved, opts);
      case 'github':
      case 'url':
      case 'git-subdir':
        return gitResolver(resolved, opts, deps);
      case 'npm':
        return npmResolver(resolved, opts);
    }
  }

  /**
   * Build the {@link FetcherDeps} bag that source resolvers consume. The
   * deps expose only the primitives the resolvers need, keeping each
   * resolver testable in isolation with a fake deps object.
   */
  private buildFetcherDeps(): FetcherDeps {
    return { fetchGitTree: (opts) => this.fetchGitSource(opts) };
  }

  /**
   * Fetch and cache a marketplace.json from a marketplace source.
   *
   * On network failure, falls back to the previously cached copy (if any)
   * and logs a warning. If neither the fetch nor the cache returns a
   * document, the original fetch error is rethrown. A failure's message is
   * written for a person: "there's no marketplace listing at that address",
   * not a status line.
   *
   * @param source - Marketplace source descriptor.
   * @param options - `staleFallback: false` rethrows the fetch error instead
   *   of serving the cached copy, for a caller that must know the document
   *   was fetched just now (adding a source, DOR-2304). Defaults to `true`.
   */
  async fetchMarketplaceJson(
    source: MarketplaceSource,
    options: { staleFallback?: boolean } = {}
  ): Promise<MarketplaceJson> {
    if (isFileUrl(source.source)) {
      try {
        const json = await this.readLocalMarketplaceJson(source);
        await this.recordFetch(source.name, null);
        return json;
      } catch (err) {
        await this.recordFetch(source.name, err);
        throw err;
      }
    }
    const url = resolveMarketplaceJsonUrl(source.source);
    try {
      const json = await this.fetchAndParseMarketplaceJson(url, source.name);
      await this.cache.writeMarketplace(source.name, json);
      await this.recordFetch(source.name, null);
      return json;
    } catch (err) {
      // Recorded as a failure even when an old copy is served below: the
      // record is about THIS attempt, and GET /sources pairs it with the
      // cached copy's own date to say "still showing the copy from …".
      await this.recordFetch(source.name, err);
      // Surface the attempted URL alongside the marketplace name so it's
      // obvious from the log whether the failure is a wrong URL (404 on a
      // typo'd org) or a genuine upstream outage.
      this.logger.warn('package-fetcher: marketplace.json fetch failed', {
        marketplaceName: source.name,
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      if (options.staleFallback === false) throw err;
      return this.serveStaleMarketplace(source.name, err);
    }
  }

  /**
   * Write down how an attempt to fetch a listing went (DOR-2324), for
   * `GET /sources` to report. Best effort: a record that cannot be written is
   * logged and never costs the caller its listing.
   *
   * @param marketplaceName - The source's name.
   * @param failure - The error the attempt failed with, or `null` on success.
   */
  private async recordFetch(marketplaceName: string, failure: unknown): Promise<void> {
    try {
      await this.cache.writeFetchStatus(
        marketplaceName,
        failure === null
          ? { checkedAt: new Date().toISOString(), ok: true }
          : {
              checkedAt: new Date().toISOString(),
              ok: false,
              reason: failure instanceof Error ? failure.message : String(failure),
            }
      );
    } catch (err) {
      this.logger.debug('package-fetcher: could not record the fetch outcome', {
        marketplaceName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Fetch the optional `dorkos.json` sidecar for a marketplace source.
   * The sidecar lives alongside `marketplace.json` at
   * `.claude-plugin/dorkos.json`. A 404 or network failure is non-fatal
   * and surfaces as `null` — marketplaces without a sidecar are valid.
   *
   * Consumers that need merged marketplace + sidecar entries should call
   * both `fetchMarketplaceJson` and `fetchDorkosSidecar` in parallel and
   * combine the results via `mergeMarketplace` from `@dorkos/marketplace`.
   *
   * @param source - Marketplace source descriptor.
   * @returns Parsed sidecar, or `null` if absent/unreachable.
   */
  async fetchDorkosSidecar(source: MarketplaceSource): Promise<DorkosSidecar | null> {
    if (isFileUrl(source.source)) {
      return this.readLocalDorkosSidecar(source);
    }
    const url = resolveDorkosSidecarUrl(source.source);
    try {
      // The same deadline as marketplace.json; it also bounds reading the body.
      const response = await fetch(url, {
        signal: AbortSignal.timeout(MARKETPLACE_JSON_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const raw = await readResponseTextWithin(
        response,
        CATALOG_MAX_BYTES,
        "The marketplace's dorkos.json"
      );
      const parsed = parseDorkosSidecar(raw);
      if (!parsed.ok) {
        this.logger.warn('package-fetcher: dorkos.json parse failed', {
          marketplaceName: source.name,
          error: parsed.error,
        });
        return null;
      }
      return parsed.sidecar;
    } catch (err) {
      // Too large is the marketplace's doing and worth seeing; a network
      // failure is routine for an optional file.
      this.logger[err instanceof TooLargeError ? 'warn' : 'debug'](
        'package-fetcher: dorkos.json fetch failed (non-fatal)',
        {
          marketplaceName: source.name,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      return null;
    }
  }

  /**
   * Read a `dorkos.json` sidecar from a `file://` marketplace source.
   * Returns `null` if the file is missing or invalid — sidecars are
   * always optional.
   */
  private async readLocalDorkosSidecar(source: MarketplaceSource): Promise<DorkosSidecar | null> {
    const root = fileUrlToPath(source.source);
    const sidecarPath = path.join(root, '.claude-plugin', 'dorkos.json');
    let raw: string;
    try {
      raw = await readTextFileWithin(
        sidecarPath,
        CATALOG_MAX_BYTES,
        "The marketplace's dorkos.json"
      );
    } catch (err) {
      if (err instanceof TooLargeError) {
        this.logger.warn('package-fetcher: local dorkos.json skipped', {
          marketplaceName: source.name,
          error: err.message,
        });
      }
      return null;
    }
    const parsed = parseDorkosSidecar(raw);
    if (!parsed.ok) {
      this.logger.warn('package-fetcher: local dorkos.json parse failed', {
        marketplaceName: source.name,
        error: parsed.error,
      });
      return null;
    }
    return parsed.sidecar;
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
    const raw = await this.readLocalMarketplaceJsonRaw(root);
    const parsed = parseMarketplaceJson(raw);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    await this.cache.writeMarketplace(source.name, parsed.marketplace);
    return parsed.marketplace;
  }

  /**
   * Read the raw `marketplace.json` text for a local marketplace root,
   * trying the repo-root layout first and falling back to the Claude Code
   * standard `.claude-plugin/marketplace.json` layout used by registries
   * like `dork-labs/marketplace`. The root file wins when both exist, so
   * this mirrors {@link resolveMarketplaceJsonUrl}'s remote precedent —
   * `.claude-plugin/marketplace.json` is the canonical location, root
   * `marketplace.json` is the legacy/override path.
   *
   * @param root - Absolute filesystem path of the marketplace source root.
   * @throws Error naming both attempted paths when neither is readable.
   */
  private async readLocalMarketplaceJsonRaw(root: string): Promise<string> {
    const rootPath = path.join(root, 'marketplace.json');
    const claudePluginPath = path.join(root, '.claude-plugin', 'marketplace.json');
    const what = "The marketplace's marketplace.json";
    try {
      return await readTextFileWithin(rootPath, CATALOG_MAX_BYTES, what);
    } catch (rootErr) {
      // A root file that is there but too large is the answer, not a reason to
      // look elsewhere.
      if (rootErr instanceof TooLargeError) throw rootErr;
      try {
        return await readTextFileWithin(claudePluginPath, CATALOG_MAX_BYTES, what);
      } catch (pluginErr) {
        if (pluginErr instanceof TooLargeError) throw pluginErr;
        // Neither file is there: say so in words a person reads on the add
        // note or a refresh (DOR-2304), and keep both paths in the log.
        if (isMissingFile(rootErr) && isMissingFile(pluginErr)) {
          this.logger.warn('package-fetcher: no local marketplace.json', {
            tried: [rootPath, claudePluginPath],
          });
          throw new Error("there's no marketplace listing in that folder", { cause: pluginErr });
        }
        // Two failures, and both survive: the root attempt as prose in the
        // message, the `.claude-plugin` attempt as the cause. Chaining the
        // second one is the deliberate half — it is the layout registries
        // actually use, so it is the failure worth the stack trace.
        throw new Error(
          `Failed to read local marketplace at ${rootPath} or ${claudePluginPath}: ${
            rootErr instanceof Error ? rootErr.message : String(rootErr)
          }`,
          { cause: pluginErr }
        );
      }
    }
  }

  /**
   * GET the marketplace.json URL and parse it via the lenient consumption
   * parser. Throws on network failure or a broken top-level envelope.
   * Individual plugin entries that fail validation are SKIPPED (not
   * fatal) and logged with the marketplace name, attempted URL, and
   * the offending entry identity so future debugging is self-serve.
   */
  private async fetchAndParseMarketplaceJson(
    url: string,
    marketplaceName: string
  ): Promise<MarketplaceJson> {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(MARKETPLACE_JSON_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(
          `the marketplace server didn't answer within ${MARKETPLACE_JSON_TIMEOUT_MS / 1000} seconds`,
          { cause: err }
        );
      }
      throw describeNetworkFailure(err);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 404
          ? "there's no marketplace listing at that address"
          : `the marketplace server answered with an error (${response.status} ${response.statusText})`
      );
    }
    const raw = await readResponseTextWithin(
      response,
      CATALOG_MAX_BYTES,
      "The marketplace's marketplace.json"
    );
    const parsed = parseMarketplaceJsonLenient(raw);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    if (parsed.skippedPlugins.length > 0) {
      this.logger.warn('package-fetcher: skipped invalid plugin entries', {
        marketplaceName,
        url,
        skippedCount: parsed.skippedPlugins.length,
        validCount: parsed.marketplace.plugins.length,
        skippedPlugins: parsed.skippedPlugins.map((p) => ({
          index: p.index,
          name: p.name ?? '<unknown>',
          error: p.error,
        })),
      });
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
   * Refuse an address this fetcher will not hand to `git`, logging the address
   * on the way out.
   *
   * The decision itself lives in {@link assertSafeGitRemote} so the several
   * doors that ask it cannot drift; the logging lives here because the
   * operator-facing message deliberately omits the address, and this warning is
   * what answers "which one did it refuse?".
   *
   * @throws {UnsupportedSourceUrlError} When the address is not a safe git remote.
   * @internal
   */
  private assertRemoteAllowed(gitUrl: string): void {
    try {
      assertSafeGitRemote(gitUrl);
    } catch (err) {
      this.logger.warn('package-fetcher: refused an unsupported git address', { gitUrl });
      throw err;
    }
  }

  /**
   * Confine a `file://` install address to the configured directory boundary.
   *
   * The local counterpart of {@link assertRemoteAllowed}, and the reason it
   * exists is symmetry rather than a new policy: an install address has two
   * local spellings, `./some/path` and `file:///some/path`, and only the first
   * one was bounded. `PackageResolver`'s `resolveLocal` runs `validateBoundary`
   * on the relative form; the `file://` form skipped it because it takes the
   * git-shaped branch through the resolver — `new URL()` parses it, so it
   * arrives here as a `gitUrl` — and then never reaches `git` at all
   * (DOR-1825). Same route, same directory, two different answers.
   *
   * The boundary is what the rest of the server enforces on every raw-path
   * surface, and `resolveLocal`'s own comment states the stakes: a directory
   * that happens to carry a package manifest gets a full recursive file listing
   * returned by the install preview, before anyone has consented to an install.
   *
   * The validated path is deliberately discarded rather than returned in place
   * of `localPath`: `resolveLocal` hands the pre-canonical path downstream too,
   * and a `file://` install that resolved to a *different* directory than the
   * one the person named would be a surprise this change has no business
   * introducing. What the boundary refuses is unchanged either way — it
   * canonicalizes before judging, so a symlink out of the boundary is refused
   * even though the symlink's own path is what gets returned.
   *
   * @param localPath - The filesystem path the `file://` address converts to.
   * @param gitUrl - The original address, logged on refusal because the
   *   operator-facing `BoundaryError` deliberately omits it.
   * @throws {BoundaryError} When the path falls outside the boundary.
   * @internal
   */
  private async assertLocalPathAllowed(localPath: string, gitUrl: string): Promise<void> {
    try {
      await validateBoundary(localPath);
    } catch (err) {
      this.logger.warn('package-fetcher: refused a file:// address outside the boundary', {
        gitUrl,
      });
      throw err;
    }
  }

  /**
   * Look up the commit `ref` points at in `cloneUrl`, for comparison against an
   * installed commit. It resolves a ref exactly as a fetch does (the same
   * {@link GitTreeSource.lookup}), so the update check and an install can never
   * disagree about which commit a ref names. A refused address throws
   * `UnsupportedSourceUrlError`; a ref the remote does not have, or a remote
   * that cannot be reached, returns a `tmp-<ms>` placeholder (test with
   * `isRealCommitSha`), never a real-looking SHA. This is the only placeholder
   * the fetcher still produces, and it never reaches the cache.
   *
   * The ref is required so no caller reaches a default by accident: an install
   * fetches at `sourceKeyOf(...).ref`, and a lookup at any other ref would
   * compare two different places.
   *
   * @param cloneUrl - The URL git is given (`SourceKey.cloneUrl`).
   * @param ref - The effective ref (`SourceKey.ref`).
   * @returns The commit SHA, or a `tmp-<ms>` placeholder when the lookup failed.
   * @throws {UnsupportedSourceUrlError} When `cloneUrl` is an address this
   *   fetcher will not hand to `git`.
   */
  async lookupCommitSha(cloneUrl: string, ref: string): Promise<string> {
    // Deliberately outside any catch: a failure to look up becomes a
    // placeholder, which is right for "no network" and wrong for "we will not
    // run this" (DOR-1799).
    this.assertRemoteAllowed(cloneUrl);
    const found = await this.git.lookup(cloneUrl, ref);
    if (found.kind === 'found') return found.commitSha;
    this.logger.warn('package-fetcher: commit lookup failed, using tmp SHA', {
      gitUrl: cloneUrl,
      ref,
      ...(found.kind === 'unreachable' ? { error: found.reason } : { missing: true }),
    });
    return `tmp-${Date.now()}`;
  }
}

/** True for a filesystem error that just means "no file there". */
function isMissingFile(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * What a network error code means, for the ones a person can act on. undici
 * reports every connection failure as a bare `fetch failed` and puts the code
 * on `cause.code`, so without this every one of them reads the same.
 */
const NETWORK_FAILURE_REASONS: Readonly<Record<string, string>> = {
  ENOTFOUND: "couldn't find a server at that address",
  EAI_AGAIN: "couldn't find a server at that address",
  ECONNREFUSED: 'the server at that address refused the connection',
  ECONNRESET: 'the connection to the marketplace server was cut off',
  ETIMEDOUT: "couldn't connect to the marketplace server in time",
  UND_ERR_CONNECT_TIMEOUT: "couldn't connect to the marketplace server in time",
};

/**
 * Turn a rejected `fetch` into an error whose message a person can read,
 * keeping the original as its `cause`. An error with no code on its cause is
 * returned unchanged: there is nothing better to say than what it says.
 */
function describeNetworkFailure(err: unknown): unknown {
  const code =
    err instanceof Error && typeof (err.cause as { code?: unknown } | undefined)?.code === 'string'
      ? (err.cause as { code: string }).code
      : undefined;
  if (code === undefined) return err;
  return new Error(
    NETWORK_FAILURE_REASONS[code] ?? `couldn't reach the marketplace server (${code})`,
    { cause: err }
  );
}

/**
 * True when `source` is a `file://` URL pointing at a local directory. Used
 * to switch the fetcher between its remote (HTTP/git) and local (filesystem)
 * code paths.
 *
 * @param source - Raw marketplace source string from a `MarketplaceSource`.
 */
export function isFileUrl(source: string): boolean {
  return source.startsWith('file://');
}

/**
 * Convert a `file://` URL into an absolute filesystem path. Caller is
 * responsible for ensuring the input is a `file://` URL — see {@link isFileUrl}.
 *
 * Exported so every local-source code path shares one conversion (DOR-412):
 * `PackageFetcher`'s own `file://` handling here, and
 * `MarketplaceInstaller.buildFetchableSource`'s `marketplaceRoot`
 * population, previously each carried their own `new URL(source).pathname`,
 * which left directory names with spaces percent-encoded and mishandled
 * Windows drive letters.
 *
 * @param source - A `file://` URL produced by `pathToFileURL` or hand-built.
 * @throws {TypeError} If `source` is not a valid `file://` URL — for example
 *   a `file://host/...` form (a remote host segment, which Node's
 *   `fileURLToPath` refuses on all platforms) or a value with an encoded
 *   path separator (`%2F`/`%5C`), which `fileURLToPath` rejects rather than
 *   silently decoding. The old `new URL(source).pathname` code returned junk
 *   in these cases instead of throwing; callers of this function already
 *   catch and translate fetch failures (surfaced as a degraded install/502),
 *   so throwing here is a strictly more honest failure than the silent junk
 *   it replaces.
 */
export function fileUrlToPath(source: string): string {
  return fileURLToPath(source);
}

/**
 * Derive the raw `marketplace.json` URL from a marketplace source string.
 *
 * Per marketplace-05, the canonical location is
 * `.claude-plugin/marketplace.json` at the repo root (not the repo root
 * directly). This matches Claude Code's own convention.
 *
 * - If the source already ends in `.claude-plugin/marketplace.json`, return it as-is.
 * - If the source ends in the legacy `marketplace.json`, return it as-is for
 *   back-compat with older marketplaces that have not migrated yet.
 * - Otherwise, strip any `.git` suffix and append
 *   `/raw/main/.claude-plugin/marketplace.json`.
 */
function resolveMarketplaceJsonUrl(source: string): string {
  if (source.endsWith('.claude-plugin/marketplace.json')) {
    return source;
  }
  if (source.endsWith('marketplace.json')) {
    return source;
  }
  const base = source.replace(/\.git$/, '').replace(/\/$/, '');
  return `${base}/raw/main/.claude-plugin/marketplace.json`;
}

/**
 * Derive the raw `dorkos.json` sidecar URL from a marketplace source
 * string. The sidecar lives alongside `marketplace.json` at
 * `.claude-plugin/dorkos.json`.
 *
 * - If the source already ends in `.claude-plugin/dorkos.json`, return it as-is.
 * - Otherwise, strip any `.git` suffix and append
 *   `/raw/main/.claude-plugin/dorkos.json`.
 */
function resolveDorkosSidecarUrl(source: string): string {
  if (source.endsWith('.claude-plugin/dorkos.json')) {
    return source;
  }
  const base = source.replace(/\.git$/, '').replace(/\/$/, '');
  return `${base}/raw/main/.claude-plugin/dorkos.json`;
}
