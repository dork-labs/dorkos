/**
 * Package resolver — converts a user-supplied identifier (e.g.
 * `code-review-suite@dorkos-community`, `github:dorkos/code-review-suite`,
 * or `./local/path`) into a concrete {@link ResolvedPackageSource}.
 *
 * The resolver is the single chokepoint between the user-facing install
 * surface (CLI flags, HTTP requests) and the downstream
 * `template-downloader` / install flows. It performs no network I/O of
 * its own — it consults the {@link MarketplaceSourceManager} for
 * configured sources and the {@link MarketplaceCache} for already-fetched
 * marketplace documents.
 *
 * @module services/marketplace/package-resolver
 */
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve as resolvePath } from 'node:path';
import type { MarketplaceJsonEntry } from '@dorkos/marketplace';
import type { MarketplaceCache } from './marketplace-cache.js';
import type { MarketplaceSourceManager } from './marketplace-source-manager.js';

/** Discriminator for the kind of source a resolved package was found in. */
export type PackageSourceKind = 'marketplace' | 'git' | 'local';

/**
 * A resolved package source descriptor — the output of
 * {@link PackageResolver.resolve}. Downstream stages (template downloader,
 * install flows) consume this and never re-parse the original input.
 */
export interface ResolvedPackageSource {
  /** Discriminator for which fields are populated. */
  kind: PackageSourceKind;
  /** Package name (post-`@` portion stripped). */
  packageName: string;
  /** Marketplace name when `kind === 'marketplace'`. */
  marketplaceName?: string;
  /** Git URL when `kind === 'git'` or `kind === 'marketplace'` (post lookup). */
  gitUrl?: string;
  /** Absolute local path when `kind === 'local'`. */
  localPath?: string;
  /** Optional version pin (`#sha` or trailing `@version` syntax — not v1). */
  version?: string;
}

/** The named marketplace was not found in the configured source list. */
export class MarketplaceNotFoundError extends Error {
  constructor(marketplaceName: string) {
    super(`Marketplace '${marketplaceName}' is not configured`);
    this.name = 'MarketplaceNotFoundError';
  }
}

/**
 * The package was not found in any (or the named) marketplace. Also
 * thrown when an explicit-marketplace lookup hits an uncached marketplace
 * — the message tells the caller to refresh the cache first.
 */
export class PackageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageNotFoundError';
  }
}

/**
 * A bare-name lookup matched packages in two or more enabled marketplaces.
 * The caller must disambiguate by re-issuing the request with explicit
 * `name@marketplace` syntax.
 */
export class AmbiguousPackageError extends Error {
  constructor(
    public readonly packageName: string,
    public readonly marketplaces: string[]
  ) {
    super(`Package '${packageName}' exists in multiple marketplaces: ${marketplaces.join(', ')}`);
    this.name = 'AmbiguousPackageError';
  }
}

/** Matches a Windows drive letter prefix like `C:\` or `c:/`. */
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/** Matches `github:user/repo` shorthand. */
const GITHUB_SHORTHAND_RE = /^github:([^/]+)\/([^/]+)$/;

/**
 * Resolves user-supplied package identifiers into concrete source
 * descriptors. Stateless beyond its two collaborators.
 */
export class PackageResolver {
  constructor(
    private readonly sourceManager: MarketplaceSourceManager,
    private readonly cache: MarketplaceCache
  ) {}

  /**
   * Resolve a user-supplied identifier into a concrete source.
   *
   * Supported input formats (checked in order):
   * 1. `./relative/path`, `../up`, `/abs/path`, or `C:\drive\path` →
   *    local directory. Resolved to an absolute path; the directory must
   *    exist on disk.
   * 2. `github:user/repo` → expanded to `https://github.com/user/repo`.
   *    Kind = `git`. `packageName` = repo segment.
   * 3. `name@<git url>` → direct git URL. Kind = `git`. `packageName` =
   *    left side of the `@`.
   * 4. `name@marketplaceName` → look up the marketplace via
   *    {@link MarketplaceSourceManager.get}. Throws
   *    {@link MarketplaceNotFoundError} when absent. Reads the cached
   *    document via {@link MarketplaceCache.readMarketplace}; throws
   *    {@link PackageNotFoundError} when the cache is empty (an actual
   *    fetch will be wired in via `package-fetcher` (task 1.5), which
   *    will pre-warm the cache before `resolve()` runs).
   * 5. Bare `name` → search every enabled marketplace via
   *    {@link MarketplaceSourceManager.list}. Throws
   *    {@link AmbiguousPackageError} on 2+ hits and
   *    {@link PackageNotFoundError} on zero hits.
   *
   * @param input - The raw user-supplied identifier.
   * @returns A {@link ResolvedPackageSource} ready for the install flow.
   * @throws {MarketplaceNotFoundError} An explicit marketplace name does not exist.
   * @throws {PackageNotFoundError} The package cannot be located.
   * @throws {AmbiguousPackageError} A bare name matches multiple marketplaces.
   */
  async resolve(input: string): Promise<ResolvedPackageSource> {
    if (isLocalPathInput(input)) {
      return resolveLocal(input);
    }

    const shorthandMatch = GITHUB_SHORTHAND_RE.exec(input);
    if (shorthandMatch) {
      return resolveGithubShorthand(shorthandMatch);
    }

    const atIdx = input.indexOf('@');
    if (atIdx > 0 && atIdx < input.length - 1) {
      const left = input.slice(0, atIdx);
      const right = input.slice(atIdx + 1);
      if (isParseableUrl(right)) {
        return { kind: 'git', packageName: left, gitUrl: right };
      }
      return this.resolveExplicitMarketplace(left, right);
    }

    return this.resolveBareName(input);
  }

  /**
   * Resolve `name@marketplaceName` against the source manager and cache.
   * Performs no network I/O — task 1.5 (`package-fetcher`) will pre-warm
   * the cache before this method runs.
   */
  private async resolveExplicitMarketplace(
    packageName: string,
    marketplaceName: string
  ): Promise<ResolvedPackageSource> {
    const source = await this.sourceManager.get(marketplaceName);
    if (!source) {
      throw new MarketplaceNotFoundError(marketplaceName);
    }

    const cached = await this.cache.readMarketplace(marketplaceName);
    if (!cached) {
      throw new PackageNotFoundError(
        `Marketplace '${marketplaceName}' has no cached document (refresh marketplace cache first)`
      );
    }

    const entry = cached.json.plugins.find((p) => p.name === packageName);
    if (!entry) {
      throw new PackageNotFoundError(
        `Package '${packageName}' not found in marketplace '${marketplaceName}'`
      );
    }

    return {
      kind: 'marketplace',
      packageName,
      marketplaceName,
      gitUrl: entry.source,
    };
  }

  /**
   * Resolve a bare `name` by searching every enabled marketplace's cached
   * document. Marketplaces with no cache entry are treated as empty so
   * the search degrades gracefully when the user has not refreshed yet.
   */
  private async resolveBareName(packageName: string): Promise<ResolvedPackageSource> {
    const sources = await this.sourceManager.list();
    const hits: { marketplaceName: string; entry: MarketplaceJsonEntry }[] = [];

    for (const source of sources) {
      if (!source.enabled) {
        continue;
      }
      const cached = await this.cache.readMarketplace(source.name);
      if (!cached) {
        continue;
      }
      const entry = cached.json.plugins.find((p) => p.name === packageName);
      if (entry) {
        hits.push({ marketplaceName: source.name, entry });
      }
    }

    if (hits.length === 0) {
      throw new PackageNotFoundError(
        `Package '${packageName}' not found in any enabled marketplace (refresh marketplace cache first)`
      );
    }
    if (hits.length > 1) {
      throw new AmbiguousPackageError(
        packageName,
        hits.map((h) => h.marketplaceName)
      );
    }

    const [hit] = hits;
    return {
      kind: 'marketplace',
      packageName,
      marketplaceName: hit.marketplaceName,
      gitUrl: hit.entry.source,
    };
  }
}

/** True when `input` looks like a local filesystem path. */
function isLocalPathInput(input: string): boolean {
  return (
    input.startsWith('./') ||
    input.startsWith('../') ||
    input.startsWith('/') ||
    WINDOWS_DRIVE_RE.test(input) ||
    isAbsolute(input)
  );
}

/**
 * Resolve a local-path input. Verifies the directory exists and returns
 * a `local`-kind descriptor. The thrown error is a plain `Error` (not a
 * typed error) because user-provided paths failing here means
 * "directory missing", not "package not found".
 */
async function resolveLocal(input: string): Promise<ResolvedPackageSource> {
  const absolute = resolvePath(input);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(`Local package path does not exist: ${absolute}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Local package path is not a directory: ${absolute}`);
  }
  return {
    kind: 'local',
    packageName: basename(absolute),
    localPath: absolute,
  };
}

/** Build a git-source descriptor from a `github:user/repo` regex match. */
function resolveGithubShorthand(match: RegExpExecArray): ResolvedPackageSource {
  const [, user, repo] = match;
  return {
    kind: 'git',
    packageName: repo,
    gitUrl: `https://github.com/${user}/${repo}`,
  };
}

/** True when `value` parses as a URL via the WHATWG URL constructor. */
function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
