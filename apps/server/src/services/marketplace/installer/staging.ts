/**
 * Resolve and stage a package for the installer: resolve the request to a
 * source, fetch or locate it, validate what arrived, and refuse one that can
 * never install. Shared by preview, install, update and the update check.
 *
 * @module services/marketplace/installer/staging
 */
import {
  isRealCommitSha,
  isSafeGitUrl,
  type MarketplacePackageManifest,
  type PluginSource,
  type SourceKey,
} from '@dorkos/marketplace';
import { validatePackage } from '@dorkos/marketplace/package-validator';
import { fileUrlToPath } from '../package-fetcher.js';
import type { ResolvedPackageSource } from '../package-resolver.js';
import { skillFileProblems } from '../flows/install-skill-pack.js';
import { assertShipsNoRuntimeState } from '../lib/content-hash.js';
import { sourceKeyOfFetchable } from '../lib/source-provenance.js';
import { validatePackageSchedules } from '../lib/schedules/validate-package-schedules.js';
import { UnsupportedSourceUrlError } from '../sources/source-url-policy.js';
import type { InstallRequest } from '../types.js';
import { InvalidPackageError } from './errors.js';
import type { InstallerDeps } from './marketplace-installer.js';

/** A resolved package, staged on disk and validated, ready to install. @internal */
export interface StagedPackage {
  resolved: ResolvedPackageSource;
  manifest: MarketplacePackageManifest;
  packagePath: string;
  /** Resolved commit SHA (DOR-147), when the staging fetch resolved a real one. */
  commitSha?: string;
  /** Where the package was fetched from; absent for local and `file://` sources. */
  sourceKey?: SourceKey;
  /** The version the staged tree declares (`readDeclaredVersion`). */
  declaredVersion?: string;
}

/** The installer's resolve → fetch → validate steps, on its dependencies. */
export class PackageStager {
  constructor(private readonly deps: InstallerDeps) {}

  /**
   * Run the resolve → fetch → validate pipeline shared by {@link MarketplaceInstaller.install}
   * and {@link MarketplaceInstaller.preview}. Returns the resolved source descriptor, the
   * parsed manifest, the path to the staged package on disk, and what the
   * install records about where it came from.
   *
   * @internal
   */
  async resolveAndValidate(req: InstallRequest): Promise<StagedPackage> {
    return this.stageAndValidate(await this.deps.resolver.resolve(buildResolverInput(req)), req);
  }

  /**
   * Stage an already-resolved package and validate it: the second half of
   * {@link resolveAndValidate}, for an update that resolved first.
   *
   * @internal
   */
  async stageAndValidate(
    resolved: ResolvedPackageSource,
    req: InstallRequest
  ): Promise<StagedPackage> {
    const staged = await this.stagePackage(resolved, req);

    // A local folder may be someone's own git worktree, whose root `.git` is a
    // `gitdir:` file; staging drops it (DOR-2326).
    const validation = await validatePackage(staged.path, {
      localSource: resolved.kind === 'local',
    });
    if (!validation.ok || !validation.manifest) {
      const errorMessages = validation.issues
        .filter((i) => i.level === 'error')
        .map((i) => i.message);
      throw new InvalidPackageError(errorMessages);
    }
    // A package may not ship DorkOS's runtime state (settings, secrets, install
    // records): files there are left out of the content hash an approval binds,
    // and a shipped install record must never stand in for ours (DOR-2306).
    await assertShipsNoRuntimeState(staged.path);

    return {
      resolved,
      manifest: validation.manifest,
      packagePath: staged.path,
      commitSha: staged.commitSha,
      sourceKey: staged.sourceKey,
      declaredVersion: validation.declaredVersion,
    };
  }

  /**
   * Stage the resolved package on disk. Local packages are used in place;
   * remote packages are fetched via the source-aware dispatcher in
   * {@link PackageFetcher.fetchPackage}.
   *
   * Reports the {@link SourceKey} of the concrete source it fetched, computed
   * from the same source handed to the fetcher, so what an install records is
   * what the update check later recomputes. The local branch and the legacy
   * bare-`gitUrl` branch record none.
   *
   * @internal
   */
  async stagePackage(
    resolved: ResolvedPackageSource,
    req: InstallRequest
  ): Promise<{ path: string; commitSha?: string; sourceKey?: SourceKey }> {
    if (resolved.kind === 'local') {
      if (!resolved.localPath) {
        throw new Error('Resolved local package missing localPath');
      }
      return { path: resolved.localPath };
    }

    // Modern path: dispatch via pluginSource (handles all five source types).
    if (resolved.pluginSource !== undefined) {
      const source = this.buildFetchableSource(resolved);
      const fetched = await this.deps.fetcher.fetchPackage({
        packageName: resolved.packageName,
        source,
        marketplaceRoot: resolved.marketplaceRoot,
        pluginRoot: resolved.pluginRoot,
        force: req.force,
      });
      // A placeholder commit is never recorded as provenance (DOR-147, "never
      // fabricate"): a remote git fetch reports the commit its checkout holds
      // (DOR-2248), while file:// and relative-path sources report a sentinel.
      const commitSha = isRealCommitSha(fetched.commitSha) ? fetched.commitSha : undefined;
      return { path: fetched.path, commitSha, sourceKey: sourceKeyOfFetchable(source) };
    }

    // Legacy path: bare gitUrl (deprecated — kept for backward compat with
    // pre-superset install inputs that resolve directly to a git URL).
    if (!resolved.gitUrl) {
      throw new Error(`Resolved ${resolved.kind} package missing gitUrl and pluginSource`);
    }
    const fetched = await this.deps.fetcher.fetchFromGit({
      packageName: resolved.packageName,
      gitUrl: resolved.gitUrl,
      force: req.force,
    });
    const commitSha = isRealCommitSha(fetched.commitSha) ? fetched.commitSha : undefined;
    return { path: fetched.path, commitSha };
  }

  /**
   * Build a fetchable {@link PluginSource} from the resolved descriptor.
   *
   * For relative-path sources (`typeof pluginSource === 'string'`) from
   * remote marketplaces, converts to a `git-subdir` source so the fetcher
   * performs a sparse clone of just the package subdirectory rather than
   * requiring a full marketplace clone. For `file://` marketplaces, the
   * source is passed through and the fetcher resolves it locally via
   * `marketplaceRoot`.
   *
   * The `git-subdir` source built here is the one that skips
   * `GitSubdirSourceSchema` — it is assembled in code from the CONFIGURED
   * marketplace's address, not parsed out of a `marketplace.json` — so it asks
   * the schema's own transport question directly (DOR-1710). Addresses are
   * already refused when a source is added; this is what still stands between
   * `git` and an address that reached `marketplaces.json` some other way.
   *
   * It asks `isSafeGitUrl`, not the narrower
   * `isSupportedMarketplaceSourceUrl` the add path uses: the question here is
   * the security one — may this string be handed to `git` — and not the
   * separate question of which addresses can serve a listing over HTTP.
   *
   * @internal
   */
  buildFetchableSource(resolved: ResolvedPackageSource): PluginSource {
    if (typeof resolved.pluginSource !== 'string') {
      return resolved.pluginSource!;
    }

    // For file:// marketplace sources, the relative-path resolver can
    // resolve directly against the local filesystem.
    const sourceUrl = resolved.marketplaceSourceUrl;
    if (!sourceUrl || sourceUrl.startsWith('file://')) {
      // Populate marketplaceRoot from the file:// URL for the fetcher.
      // fileUrlToPath (DOR-412), not new URL(sourceUrl).pathname: the latter
      // leaves directory names with spaces percent-encoded.
      if (sourceUrl) {
        resolved.marketplaceRoot = fileUrlToPath(sourceUrl);
      }
      return resolved.pluginSource;
    }

    // Remote marketplace: convert relative-path to a git-subdir source.
    // This lets the fetcher sparse-clone just the package subdirectory.
    if (!isSafeGitUrl(sourceUrl)) {
      // The address is logged here and nowhere else: it is the one fact that
      // makes this refusal actionable, and the operator-facing message
      // deliberately omits it.
      this.deps.logger.warn(
        '[marketplace-installer] refused to clone from an unsupported marketplace address',
        { marketplace: resolved.marketplaceName, url: sourceUrl }
      );
      throw new UnsupportedSourceUrlError(sourceUrl);
    }
    const subpath = resolveRelativeSubpath(resolved.pluginSource, resolved.pluginRoot);
    return { source: 'git-subdir', url: sourceUrl, path: subpath };
  }
}

/**
 * Convert an {@link InstallRequest} into the single-string input shape
 * accepted by {@link PackageResolver.resolve}. Precedence:
 *
 * 1. `req.source` (explicit git URL or local path) → `${name}@${source}`.
 * 2. `req.marketplace` (configured marketplace name) → `${name}@${marketplace}`.
 * 3. Bare `req.name` → resolver searches every enabled marketplace.
 *
 * @internal
 */
export function buildResolverInput(req: InstallRequest): string {
  if (req.source) {
    return `${req.name}@${req.source}`;
  }
  if (req.marketplace) {
    return `${req.name}@${req.marketplace}`;
  }
  return req.name;
}

/**
 * Resolve a relative-path `pluginSource` string into the subdirectory path
 * within the marketplace repo. Mirrors the logic in
 * `@dorkos/marketplace/source-resolver#resolveRelativePath`:
 *
 * - `./plugins/code-reviewer` → `plugins/code-reviewer` (strip `./`)
 * - `code-reviewer` (bare name) + `pluginRoot: './plugins'` → `plugins/code-reviewer`
 *
 * @internal
 */
function resolveRelativeSubpath(source: string, pluginRoot?: string): string {
  if (source.startsWith('./')) {
    return source.slice(2);
  }
  const normalized = pluginRoot ? pluginRoot.replace(/^\.\//, '').replace(/\/+$/, '') : '';
  return normalized ? `${normalized}/${source}` : source;
}

/**
 * Refuse a staged package that can never install, from its content alone: a
 * schedule that could never run (croner's reading of the cron and timezone, a
 * `skillRef` the package does not ship, two schedules on one directory), and,
 * for a skill pack, a `SKILL.md` DorkOS's parser rejects. Nothing here reads
 * the install target, the network or npm, so an update runs it before its
 * uninstall half.
 *
 * Deliberately not in `resolveAndValidate`, which `preview()` also calls: the
 * preview backs the marketplace's package DETAIL page, and refusing there would
 * turn one package's bad cron into a page a person cannot open to read about
 * it. Browsing a broken package is fine; installing it is not.
 *
 * What is left in the install half can fail for reasons outside the package's
 * text (npm, the disk, compiling an extension against the dependencies npm
 * installs), and an update that fails there leaves the package uninstalled
 * with the person's files and record in place for a retry.
 *
 * @param staged - The resolved, staged and schema-validated package.
 * @throws {InvalidPackageError} Naming every problem found.
 */
export async function assertInstallable(staged: StagedPackage): Promise<void> {
  const problems = await validatePackageSchedules(staged.packagePath, staged.manifest);
  if (staged.manifest.type === 'skill-pack') {
    problems.push(...(await skillFileProblems(staged.packagePath)));
  }
  if (problems.length > 0) throw new InvalidPackageError(problems);
}
