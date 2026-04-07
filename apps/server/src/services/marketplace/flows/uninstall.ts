/**
 * Marketplace package uninstall flow.
 *
 * Removes a previously installed package by name. Plugin/skill-pack/adapter
 * packages live under `${dorkHome}/plugins/<name>/`, agent packages under
 * `${dorkHome}/agents/<name>/`, and project-local plugins under
 * `${projectPath}/.dork/plugins/<name>/`. The flow is rollback-safe: the
 * package is moved to a temporary staging directory first, side-effects
 * (extension disable, adapter removal) run against the live (now-empty)
 * location, and only after every step succeeds is the staging directory
 * permanently removed. Any thrown error during the side-effect phase
 * restores the package from staging back to its original install path.
 *
 * Data preservation: when `purge` is false (the default), the contents of
 * `<installRoot>/.dork/data/` and `<installRoot>/.dork/secrets.json` are
 * copied back into the live install location after the package files have
 * been removed. With `purge: true`, those paths are removed along with
 * everything else.
 *
 * @module services/marketplace/flows/uninstall
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { atomicMove } from '../lib/atomic-move.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import { PACKAGE_MANIFEST_PATH } from '@dorkos/marketplace';
import type { MarketplacePackageManifest, PackageType } from '@dorkos/marketplace';

/** Staging directory prefix used by the uninstall flow. */
const STAGING_DIR_PREFIX = 'dorkos-uninstall-';

/** Subdirectory containing package data preserved across reinstalls. */
const DATA_SUBPATH = path.join('.dork', 'data');

/** Path to the package secrets file relative to the install root. */
const SECRETS_SUBPATH = path.join('.dork', 'secrets.json');

/** A request to uninstall a marketplace package. */
export interface UninstallRequest {
  /** Package name to uninstall. */
  name: string;
  /** Remove `.dork/data/` and `.dork/secrets.json` in addition to package files. */
  purge?: boolean;
  /** Project path for project-local uninstalls. */
  projectPath?: string;
}

/** The outcome of a successful uninstall. */
export interface UninstallResult {
  ok: boolean;
  packageName: string;
  /** Number of top-level entries removed from the install root. */
  removedFiles: number;
  /** Absolute paths preserved on disk because `purge` was false. */
  preservedData: string[];
}

/**
 * Minimal {@link ExtensionManager} surface required by the uninstall flow.
 * Avoids importing the concrete class so tests can mock with `vi.fn()`.
 */
export interface UninstallExtensionManager {
  disable(id: string): Promise<unknown>;
}

/**
 * Minimal {@link AdapterManager} surface required by the uninstall flow.
 */
export interface UninstallAdapterManager {
  removeAdapter(id: string): Promise<void>;
}

/** Dependencies for {@link UninstallFlow}. */
export interface UninstallFlowDeps {
  dorkHome: string;
  extensionManager: UninstallExtensionManager;
  adapterManager: UninstallAdapterManager;
  logger: Logger;
}

/** Thrown when {@link UninstallFlow.uninstall} cannot find the requested package. */
export class PackageNotInstalledError extends Error {
  /**
   * Build a `PackageNotInstalledError` for the supplied package name.
   *
   * @param name - The package name that could not be located on disk.
   */
  constructor(public readonly name: string) {
    super(`Package not installed: ${name}`);
    this.name = 'PackageNotInstalledError';
  }
}

/** A located install with its parsed manifest (when one exists). */
interface LocatedPackage {
  installRoot: string;
  manifest: MarketplacePackageManifest | null;
  inferredType: PackageType;
}

/**
 * Uninstall a marketplace package and clean up its registered side-effects
 * (extensions, adapter entries) with rollback safety.
 */
export class UninstallFlow {
  constructor(private readonly deps: UninstallFlowDeps) {}

  /**
   * Locate, stage, and remove the named package.
   *
   * @param req - Uninstall request — name, optional purge flag, optional project path.
   * @returns The uninstall result, including any data paths preserved on disk.
   * @throws {PackageNotInstalledError} If no install matches the requested name.
   */
  async uninstall(req: UninstallRequest): Promise<UninstallResult> {
    const located = await this.locate(req);
    const stagingDir = await mkdtemp(path.join(tmpdir(), `${STAGING_DIR_PREFIX}${req.name}-`));
    const stagingPath = path.join(stagingDir, 'pkg');

    try {
      await atomicMove(located.installRoot, stagingPath);
    } catch (err) {
      await rm(stagingDir, { recursive: true, force: true });
      throw err;
    }

    try {
      const removedFiles = await this.countTopLevelEntries(stagingPath);
      await this.runSideEffects(stagingPath, located);
      const preservedData = req.purge
        ? []
        : await this.restorePreservedData(stagingPath, located.installRoot);
      await rm(stagingDir, { recursive: true, force: true });
      return { ok: true, packageName: req.name, removedFiles, preservedData };
    } catch (err) {
      await this.rollbackFromStaging(stagingPath, located.installRoot, stagingDir);
      throw err;
    }
  }

  /**
   * Search the canonical install locations for a package matching `req.name`
   * and return the first match. Reads `dork-package.json` to determine the
   * package type when one is present, otherwise infers it from the layout.
   *
   * @internal
   */
  private async locate(req: UninstallRequest): Promise<LocatedPackage> {
    const candidates = this.candidatePaths(req);
    for (const candidate of candidates) {
      if (!(await pathExists(candidate.installRoot))) continue;
      const manifest = await readManifestIfPresent(candidate.installRoot);
      return {
        installRoot: candidate.installRoot,
        manifest,
        inferredType: manifest?.type ?? candidate.inferredType,
      };
    }
    throw new PackageNotInstalledError(req.name);
  }

  /**
   * Build the ordered list of paths to probe for an installed package.
   *
   * @internal
   */
  private candidatePaths(
    req: UninstallRequest
  ): { installRoot: string; inferredType: PackageType }[] {
    const candidates: { installRoot: string; inferredType: PackageType }[] = [];
    if (req.projectPath) {
      candidates.push({
        installRoot: path.join(req.projectPath, '.dork', 'plugins', req.name),
        inferredType: 'plugin',
      });
    }
    candidates.push({
      installRoot: path.join(this.deps.dorkHome, 'plugins', req.name),
      inferredType: 'plugin',
    });
    candidates.push({
      installRoot: path.join(this.deps.dorkHome, 'agents', req.name),
      inferredType: 'agent',
    });
    return candidates;
  }

  /**
   * Run the type-specific cleanup hooks against the staged copy. Plugin
   * extensions are disabled by walking the staged `.dork/extensions/`
   * directory; adapter entries are removed via `removeAdapter`.
   *
   * @internal
   */
  private async runSideEffects(stagingPath: string, located: LocatedPackage): Promise<void> {
    const type = located.inferredType;
    if (type === 'plugin' || type === 'skill-pack') {
      await this.disableBundledExtensions(stagingPath);
    }
    if (type === 'adapter') {
      // Prefer the manifest name; fall back to the install root basename
      // (the directory the package was installed into) rather than the
      // staging dir basename (which is always the literal 'pkg').
      await this.deps.adapterManager.removeAdapter(
        located.manifest?.name ?? path.basename(located.installRoot)
      );
    }
  }

  /**
   * Walk the staged `.dork/extensions/` directory and call
   * `extensionManager.disable()` for each extension ID found.
   *
   * @internal
   */
  private async disableBundledExtensions(stagingPath: string): Promise<void> {
    const extDir = path.join(stagingPath, '.dork', 'extensions');
    if (!(await pathExists(extDir))) return;
    const entries = await readdir(extDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.deps.extensionManager.disable(entry.name);
      }
    }
  }

  /**
   * Re-create `.dork/data/` and `.dork/secrets.json` in the original
   * install location by copying them out of the staged package. Returns
   * the list of preserved absolute paths.
   *
   * @internal
   */
  private async restorePreservedData(stagingPath: string, installRoot: string): Promise<string[]> {
    const preserved: string[] = [];
    const stagedDataDir = path.join(stagingPath, DATA_SUBPATH);
    const stagedSecrets = path.join(stagingPath, SECRETS_SUBPATH);
    const liveDataDir = path.join(installRoot, DATA_SUBPATH);
    const liveSecrets = path.join(installRoot, SECRETS_SUBPATH);

    if (await pathExists(stagedDataDir)) {
      await mkdir(path.dirname(liveDataDir), { recursive: true });
      await cp(stagedDataDir, liveDataDir, { recursive: true });
      preserved.push(liveDataDir);
    }
    if (await pathExists(stagedSecrets)) {
      await mkdir(path.dirname(liveSecrets), { recursive: true });
      await cp(stagedSecrets, liveSecrets);
      preserved.push(liveSecrets);
    }
    return preserved;
  }

  /**
   * Move the staged copy back to its original location after a failure
   * during side-effects. Cleanup errors are logged but never thrown so
   * they cannot mask the original transaction error.
   *
   * @internal
   */
  private async rollbackFromStaging(
    stagingPath: string,
    installRoot: string,
    stagingDir: string
  ): Promise<void> {
    try {
      if (await pathExists(installRoot)) {
        await rm(installRoot, { recursive: true, force: true });
      }
      await mkdir(path.dirname(installRoot), { recursive: true });
      await atomicMove(stagingPath, installRoot);
    } catch (rollbackErr) {
      this.deps.logger.warn(
        `[marketplace/uninstall] rollback failed for ${installRoot}: ${
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        }`
      );
    }
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Count the number of top-level entries in the staged package — used as
   * the `removedFiles` reporter on the result. Returns 0 if the directory
   * is unreadable.
   *
   * @internal
   */
  private async countTopLevelEntries(stagingPath: string): Promise<number> {
    try {
      const entries = await readdir(stagingPath);
      return entries.length;
    } catch {
      return 0;
    }
  }
}

/** Returns true if `target` exists on disk. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse `.dork/manifest.json` from an install root, returning
 * `null` if the file is missing or unparseable. Validation is the
 * installer's job — we only need the type for routing.
 */
async function readManifestIfPresent(
  installRoot: string
): Promise<MarketplacePackageManifest | null> {
  try {
    const raw = await readFile(path.join(installRoot, PACKAGE_MANIFEST_PATH), 'utf-8');
    return JSON.parse(raw) as MarketplacePackageManifest;
  } catch {
    return null;
  }
}
