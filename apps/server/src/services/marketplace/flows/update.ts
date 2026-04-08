/**
 * Marketplace package update flow.
 *
 * Advisory by default: enumerates installed packages, looks up their latest
 * available version in the marketplace catalog, and returns the comparison
 * result without touching disk. When `apply: true` is set, the flow
 * delegates reinstallation to an injected {@link InstallerLike} with
 * `force: true`. The installer is responsible for running the
 * uninstall-without-purge → install pattern that preserves
 * `.dork/data/` and `.dork/secrets.json` across versions.
 *
 * The `MarketplaceInstaller` class is built in a sibling task and is
 * injected into this module via the {@link InstallerLike} interface to
 * break the circular dependency between the update flow and the full
 * installer orchestrator.
 *
 * @module services/marketplace/flows/update
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { gt as semverGt, valid as semverValid, coerce as semverCoerce } from 'semver';
import { PACKAGE_MANIFEST_PATH } from '@dorkos/marketplace';
import type { MarketplaceJson, MarketplaceJsonEntry, PackageType } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import type { InstallRequest, InstallResult, MarketplaceSource } from '../types.js';
import { readInstallMetadata } from '../installed-metadata.js';

/**
 * Structural interface for the forward-declared `MarketplaceInstaller`
 * (implemented in a sibling task). Declared here so the update flow can
 * be wired against either the real installer or a test double without a
 * circular import on a not-yet-existing module.
 */
export interface InstallerLike {
  /**
   * Update an installed package by uninstalling (without purging
   * `.dork/data/` or `.dork/secrets.json`) and reinstalling fresh.
   * Preserves user secrets and persisted state across version bumps.
   */
  update(req: InstallRequest): Promise<InstallResult>;
}

/**
 * Structural interface for {@link import('../marketplace-source-manager.js').MarketplaceSourceManager}.
 * Declared locally so tests can mock with `vi.fn()` without constructing
 * the concrete class.
 */
export interface UpdateSourceManagerLike {
  list(): Promise<MarketplaceSource[]>;
  get(name: string): Promise<MarketplaceSource | null>;
}

/**
 * Structural interface for the marketplace.json fetch surface of
 * {@link import('../package-fetcher.js').PackageFetcher}.
 */
export interface UpdateFetcherLike {
  fetchMarketplaceJson(source: MarketplaceSource): Promise<MarketplaceJson>;
}

/** A single comparison result for one installed package. */
export interface UpdateCheckResult {
  packageName: string;
  installedVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  marketplace: string;
}

/** A request to check for (and optionally apply) updates. */
export interface UpdateRequest {
  /** Specific package name; if omitted, check every installed package. */
  name?: string;
  /** Apply the update (default: advisory only). */
  apply?: boolean;
  /** Project path for project-local installs. */
  projectPath?: string;
}

/** The composite result of an update check. */
export interface UpdateResult {
  checks: UpdateCheckResult[];
  /** Populated only when `apply: true`; one entry per successful reinstall. */
  applied: InstallResult[];
}

/** Constructor dependencies for {@link UpdateFlow}. */
export interface UpdateFlowDeps {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /** Installer orchestrator used when `apply: true`. Forward-declared. */
  installer: InstallerLike;
  /** Source manager used to resolve marketplace names to sources. */
  sourceManager: UpdateSourceManagerLike;
  /** Package fetcher used to retrieve marketplace.json documents. */
  fetcher: UpdateFetcherLike;
  /** Logger for diagnostic output. */
  logger: Logger;
}

/** A discovered installed package on disk, plus the raw manifest json. */
interface InstalledPackage {
  name: string;
  version: string;
  type: PackageType;
  installPath: string;
  installedFrom?: string;
}

/** Thrown when a named package is requested for update but is not installed. */
export class PackageNotInstalledForUpdateError extends Error {
  /**
   * Build a `PackageNotInstalledForUpdateError` for the supplied package name.
   *
   * @param name - The package name that could not be located on disk.
   */
  constructor(public readonly packageName: string) {
    super(`Package not installed: ${packageName}`);
    this.name = 'PackageNotInstalledForUpdateError';
  }
}

/**
 * Advisory-by-default update orchestrator for marketplace packages.
 *
 * Run with no `name` to get a comparison for every installed package; pass
 * `name` to narrow to one. Pass `apply: true` to invoke the injected
 * installer with `force: true` for every entry that has an update available.
 */
export class UpdateFlow {
  constructor(private readonly deps: UpdateFlowDeps) {}

  /**
   * Execute the update flow.
   *
   * @param req - Update request — name filter, apply flag, project path.
   * @returns The full {@link UpdateResult} with per-package checks and any
   *   applied reinstall results.
   * @throws {PackageNotInstalledForUpdateError} When `req.name` is set but
   *   no installed package matches.
   */
  async run(req: UpdateRequest): Promise<UpdateResult> {
    const installed = await this.listInstalled();
    const filtered = this.filterInstalled(installed, req.name);

    const checks: UpdateCheckResult[] = [];
    for (const pkg of filtered) {
      const check = await this.checkOne(pkg);
      if (check) checks.push(check);
    }

    const applied: InstallResult[] = [];
    if (req.apply) {
      for (const check of checks) {
        if (!check.hasUpdate) continue;
        const result = await this.deps.installer.update({
          name: check.packageName,
          marketplace: check.marketplace,
          projectPath: req.projectPath,
        });
        applied.push(result);
      }
    }

    return { checks, applied };
  }

  /**
   * Narrow the installed list to the requested package when `name` is set.
   * Throws when the name does not match any installed package.
   *
   * @internal
   */
  private filterInstalled(
    installed: InstalledPackage[],
    name: string | undefined
  ): InstalledPackage[] {
    if (!name) return installed;
    const match = installed.find((pkg) => pkg.name === name);
    if (!match) {
      throw new PackageNotInstalledForUpdateError(name);
    }
    return [match];
  }

  /**
   * Walk the install roots under `<dorkHome>/plugins/` and
   * `<dorkHome>/agents/`, reading each `.dork/manifest.json` for the
   * canonical package fields and `.dork/install-metadata.json` for the
   * provenance fields. Unreadable manifests are silently skipped so a
   * single malformed install never blocks the update check.
   *
   * @internal
   */
  private async listInstalled(): Promise<InstalledPackage[]> {
    const results: InstalledPackage[] = [];
    const roots: Array<{ dir: string; inferredType: PackageType }> = [
      { dir: path.join(this.deps.dorkHome, 'plugins'), inferredType: 'plugin' },
      { dir: path.join(this.deps.dorkHome, 'agents'), inferredType: 'agent' },
    ];

    for (const root of roots) {
      const entries = await readDirSafe(root.dir);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const installPath = path.join(root.dir, entry.name);
        const manifest = await readInstalledManifest(installPath);
        if (!manifest) continue;
        const installMetadata = await readInstallMetadata(installPath);
        results.push({
          name: typeof manifest.name === 'string' ? manifest.name : entry.name,
          version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
          type: (manifest.type as PackageType | undefined) ?? root.inferredType,
          installPath,
          installedFrom: installMetadata?.installedFrom,
        });
      }
    }

    return results;
  }

  /**
   * Compare a single installed package against its source marketplace and
   * build an {@link UpdateCheckResult}. Returns `null` when the package
   * cannot be found in any enabled marketplace (silent skip — the user is
   * still told about the packages we could match).
   *
   * @internal
   */
  private async checkOne(pkg: InstalledPackage): Promise<UpdateCheckResult | null> {
    const match = await this.findMarketplaceEntry(pkg);
    if (!match) {
      this.deps.logger.warn('update-flow: no marketplace entry found for package', {
        packageName: pkg.name,
        installedVersion: pkg.version,
      });
      return null;
    }
    const latest = match.entry.version ?? pkg.version;
    return {
      packageName: pkg.name,
      installedVersion: pkg.version,
      latestVersion: latest,
      hasUpdate: isNewerVersion(latest, pkg.version),
      marketplace: match.marketplaceName,
    };
  }

  /**
   * Locate the marketplace entry for an installed package. Uses
   * `installedFrom` as the primary lookup when present; otherwise scans
   * every enabled source until a matching entry is found.
   *
   * @internal
   */
  private async findMarketplaceEntry(
    pkg: InstalledPackage
  ): Promise<{ entry: MarketplaceJsonEntry; marketplaceName: string } | null> {
    if (pkg.installedFrom) {
      const source = await this.deps.sourceManager.get(pkg.installedFrom);
      if (source && source.enabled) {
        const entry = await this.fetchAndFindEntry(source, pkg.name);
        if (entry) return { entry, marketplaceName: source.name };
      }
    }

    const sources = await this.deps.sourceManager.list();
    for (const source of sources) {
      if (!source.enabled) continue;
      if (pkg.installedFrom && source.name === pkg.installedFrom) continue;
      const entry = await this.fetchAndFindEntry(source, pkg.name);
      if (entry) return { entry, marketplaceName: source.name };
    }
    return null;
  }

  /**
   * Fetch a marketplace.json and find the entry for a given package name.
   * Fetch errors are logged and treated as "entry not found" so one
   * unreachable marketplace never blocks the whole update check.
   *
   * @internal
   */
  private async fetchAndFindEntry(
    source: MarketplaceSource,
    packageName: string
  ): Promise<MarketplaceJsonEntry | null> {
    try {
      const json = await this.deps.fetcher.fetchMarketplaceJson(source);
      return json.plugins.find((entry) => entry.name === packageName) ?? null;
    } catch (err) {
      this.deps.logger.warn('update-flow: failed to fetch marketplace.json', {
        marketplaceName: source.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

/**
 * Compare two semver strings and return true when `latest` is strictly
 * greater than `installed`. Falls back to string inequality when either
 * value is not valid semver (after a best-effort coerce), so malformed
 * versions never silently report "up to date".
 */
function isNewerVersion(latest: string, installed: string): boolean {
  const latestValid = semverValid(latest) ?? semverCoerce(latest)?.version ?? null;
  const installedValid = semverValid(installed) ?? semverCoerce(installed)?.version ?? null;
  if (latestValid && installedValid) {
    return semverGt(latestValid, installedValid);
  }
  return latest !== installed;
}

/**
 * Read a directory without throwing on `ENOENT`. Returns an empty array
 * when the directory does not exist so the update flow works cleanly on
 * a fresh dorkHome with no installed packages.
 */
async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/**
 * Read and parse `.dork/manifest.json` from an install root. Returns
 * `null` if the file is missing or unparseable — the update check silently
 * skips malformed installs rather than blocking the whole scan.
 */
async function readInstalledManifest(installRoot: string): Promise<Record<string, unknown> | null> {
  const manifestPath = path.join(installRoot, PACKAGE_MANIFEST_PATH);
  try {
    const s = await stat(manifestPath);
    if (!s.isFile()) return null;
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
