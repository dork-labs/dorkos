/**
 * Marketplace package uninstall flow.
 *
 * Removes a previously installed package by name. Plugin/skill-pack/adapter
 * packages live under `${dorkHome}/plugins/<name>/`, agent packages under
 * `${dorkHome}/agents/<name>/`, Shapes under `${dorkHome}/shapes/<name>/`, and
 * project-local plugins under `${projectPath}/.dork/plugins/<name>/` — the same
 * per-type roots the install flows write to ({@link INSTALL_ROOTS_WITH_TYPE}).
 * The flow is rollback-safe: the package is moved to a temporary staging
 * directory first, side-effects (extension disable, adapter removal, active-
 * Shape deactivation) run against the live (now-empty) location, and only after
 * every step succeeds is the staging directory permanently removed. Any thrown
 * error during the side-effect phase restores the package from staging back to
 * its original install path.
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
import { INSTALL_ROOTS_WITH_TYPE } from '../lib/install-roots.js';

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
  /**
   * Internal (installer-only): set `false` to keep `ui.shapes.active` intact
   * when this flow removes the active Shape. The installer's `update()` sets
   * it because its uninstall is the first half of a replace — the same Shape
   * lands back at the same path moments later — not a removal. Defaults to
   * `true`; the HTTP route's body schema does not expose this field, so
   * external callers always get the honest clear-on-remove behavior.
   */
  deactivateShape?: boolean;
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

/**
 * Person-scoped active-Shape surface the uninstall flow uses to keep
 * `ui.shapes.active` honest when the active Shape is removed. Optional on the
 * deps so non-Shape-aware callers (and most tests) need not supply it; when
 * absent, uninstalling a Shape simply skips the deactivation step.
 */
export interface UninstallShapeDeactivator {
  /** The currently-active Shape name (`ui.shapes.active`), or `null`. */
  getActiveShapeName(): string | null;
  /** Clear `ui.shapes.active` (set it to `null`). */
  clearActiveShape(): void;
}

/** Dependencies for {@link UninstallFlow}. */
export interface UninstallFlowDeps {
  dorkHome: string;
  extensionManager: UninstallExtensionManager;
  adapterManager: UninstallAdapterManager;
  /** Active-Shape state hooks; omit when the caller does not manage Shapes. */
  shapeDeactivator?: UninstallShapeDeactivator;
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
      await this.runSideEffects(stagingPath, located, req);
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
   * First-match wins across the probe order (project-local, then the global
   * roots `plugins` → `agents` → `shapes`): {@link UninstallRequest} carries no
   * package type, so when two different-type packages share a name (e.g. a
   * plugin *and* a Shape both called "linear-ops"), an uninstall by name always
   * resolves to the earlier root and the later one stays untouched. That
   * cross-type collision is surfaced as a non-blocking warning at install time
   * by the conflict detector's package-name rule, so the ambiguity is visible
   * before it is ever created.
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
    // Global roots, in install-root order (`plugins`, `agents`, `shapes`) —
    // derived from the shared mapping so a package type can never install
    // somewhere the uninstall probe does not look (the drift that hid Shapes).
    for (const { dir, representativeType } of INSTALL_ROOTS_WITH_TYPE) {
      candidates.push({
        installRoot: path.join(this.deps.dorkHome, dir, req.name),
        inferredType: representativeType,
      });
    }
    return candidates;
  }

  /**
   * Run the type-specific cleanup hooks against the staged copy. Plugin
   * extensions are disabled by walking the staged `.dork/extensions/`
   * directory; adapter entries are removed via `removeAdapter`; removing the
   * currently-active Shape clears `ui.shapes.active` so the pointer never
   * dangles at a deleted install (suppressed when `req.deactivateShape` is
   * `false` — the installer's update replace, where the Shape comes right
   * back).
   *
   * @internal
   */
  private async runSideEffects(
    stagingPath: string,
    located: LocatedPackage,
    req: UninstallRequest
  ): Promise<void> {
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
    if (type === 'shape' && req.deactivateShape !== false) {
      this.deactivateShapeIfActive(located);
    }
  }

  /**
   * Clear `ui.shapes.active` when the Shape being uninstalled is the one
   * currently applied. Leaving the pointer in place would leave the cockpit
   * referencing a Shape that no longer exists on disk (a dangling active
   * Shape); clearing it falls the cockpit back to no active Shape, which is
   * the honest state after its layout is removed. A no-op when the deactivator
   * dependency is absent (Shape-unaware caller) or a different Shape is active.
   *
   * @internal
   */
  private deactivateShapeIfActive(located: LocatedPackage): void {
    const deactivator = this.deps.shapeDeactivator;
    if (!deactivator) return;
    const shapeName = located.manifest?.name ?? path.basename(located.installRoot);
    if (deactivator.getActiveShapeName() !== shapeName) return;
    deactivator.clearActiveShape();
    this.deps.logger.info(
      `[marketplace/uninstall] Cleared active Shape "${shapeName}" — it was uninstalled`
    );
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
