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
 * Concurrency: this flow does not use `runTransaction`, but it does take the
 * same per-target lock (`withInstallTargetLock`), because it has the same
 * destructive pair — move the install root aside, restore that copy on failure
 * — and therefore the same way of stepping on a concurrent install (DOR-711).
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
import { installRootCandidates, type InstallRootCandidate } from '../lib/locate-install.js';
import { assertPackageName } from '../lib/package-paths.js';
import { readInstallMetadata } from '../installed-metadata.js';
import { withInstallTargetLock } from '../transaction.js';

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
  /**
   * Drop the person's standing approval for this extension to run code inside
   * DorkOS (DOR-516), because the code it was given to is going away.
   */
  forgetRunApproval(id: string): Promise<void>;
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

/**
 * Schedule-teardown surface the uninstall flow uses to delete the schedules a
 * Shape created (stamped with its provenance marker) when that Shape is removed
 * — so a Shape's 15-minute tick never keeps firing after the Shape is gone.
 * Optional on the deps: a Shape-unaware caller (and most tests) omit it, in
 * which case a Shape uninstall simply skips schedule cleanup.
 */
export interface UninstallShapeScheduleTeardown {
  /**
   * Delete every schedule stamped with this Shape's provenance marker.
   *
   * @param shapeName - The Shape whose schedules to delete.
   * @returns The names of the schedules deleted.
   */
  deleteSchedulesForShape(shapeName: string): Promise<string[]>;
}

/** Dependencies for {@link UninstallFlow}. */
export interface UninstallFlowDeps {
  dorkHome: string;
  extensionManager: UninstallExtensionManager;
  adapterManager: UninstallAdapterManager;
  /** Active-Shape state hooks; omit when the caller does not manage Shapes. */
  shapeDeactivator?: UninstallShapeDeactivator;
  /** Deletes a removed Shape's schedules; omit when the caller does not manage Shapes. */
  shapeScheduleTeardown?: UninstallShapeScheduleTeardown;
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
   * The name is checked before anything touches disk. Every path this flow
   * builds — the probe roots in {@link UninstallFlow.candidatePaths}, and the
   * staging directory named after the package — interpolates `req.name`, and
   * `path.join` collapses a `..` without complaint. So a name that climbs used
   * to aim this flow's atomic-move-then-recursive-delete at any directory the
   * caller named, and the callers are the network: the `:name` route param and
   * the `marketplace_uninstall` MCP tool. Both validate too; this is the guard
   * that holds when a future caller forgets to (`lib/package-paths.ts`).
   *
   * Everything after the package is located runs inside
   * {@link withInstallTargetLock} on the located install root — the same lock
   * the install engine takes (DOR-711). This flow has the identical
   * destructive pair: it moves the install root aside, and on a side-effect
   * failure restores that copy over whatever is at the path now. Unserialised,
   * an install that landed in between would be deleted by an uninstall's
   * rollback, and a fresh install could land inside the window where the
   * uninstall has taken the directory away, only to be overwritten when the
   * uninstall restores it.
   *
   * {@link UninstallFlow.locate} stays OUTSIDE the lock, because the path to
   * lock is not known until it has run. The residue is narrow — a package
   * removed between the probe and the lock leaves this flow's `atomicMove`
   * throwing `ENOENT`, which is a loud failure, not a destructive one.
   *
   * @param req - Uninstall request — name, optional purge flag, optional project path.
   * @returns The uninstall result, including any data paths preserved on disk.
   * @throws {InvalidPackageNameError} If the name is not a canonical package name.
   * @throws {PackageNotInstalledError} If no install matches the requested name.
   */
  async uninstall(req: UninstallRequest): Promise<UninstallResult> {
    assertPackageName(req.name);
    const located = await this.locate(req);
    return withInstallTargetLock(located.installRoot, () => this.removeLocated(req, located));
  }

  /**
   * Stage the located package aside, run its side-effects, and either commit
   * the removal or restore the staged copy.
   *
   * Split from {@link UninstallFlow.uninstall} so that entry point is one
   * readable "locate, then do it under the target's lock" pair. Never call this
   * directly: the lock is what keeps the move-aside and the restore from being
   * split apart by a concurrent install.
   *
   * @internal
   */
  private async removeLocated(
    req: UninstallRequest,
    located: LocatedPackage
  ): Promise<UninstallResult> {
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
   * Shared with `MarketplaceInstaller.update()`, which probes the same order to
   * decide which target to lock across its whole uninstall-then-install round
   * trip — two orders would mean it locked a directory this flow never touches.
   *
   * @internal
   */
  private candidatePaths(req: UninstallRequest): InstallRootCandidate[] {
    return installRootCandidates({
      dorkHome: this.deps.dorkHome,
      name: req.name,
      projectPath: req.projectPath,
    });
  }

  /**
   * Run the type-specific cleanup hooks against the staged copy. Plugin
   * extensions are disabled by walking the staged `.dork/extensions/`
   * directory; adapter entries are removed via `removeAdapter`; a removed Shape
   * gets its full lifecycle teardown ({@link teardownShape}), suppressed when
   * `req.deactivateShape` is `false` — the installer's update replace, where the
   * Shape comes right back.
   *
   * @internal
   */
  private async runSideEffects(
    stagingPath: string,
    located: LocatedPackage,
    req: UninstallRequest
  ): Promise<void> {
    const type = located.inferredType;
    // Only these two types walk `.dork/extensions/`. `shape` and `adapter` packages
    // may carry that directory too, and the asymmetry looks like an oversight, so:
    // a bundled extension under either of those types never becomes a discovery
    // record today, and therefore has nothing to turn off and no approval to forget
    // (DOR-516). `ExtensionDiscovery` scans exactly two roots, one level deep —
    // `{dorkHome}/extensions` and `{cwd}/.dork/extensions` — and neither
    // `{dorkHome}/shapes/**` nor an adapter's install root is among them.
    // `applyShape` does not close the gap either: it iterates `manifest.activates`,
    // a list of ids, and skips any id `extensionManager.get()` does not already
    // know, so a Shape's own bundled tree is never registered.
    //
    // Two changes would make this live, and whoever makes one has to add the walk
    // here as part of it: discovery gaining a third root, or `applyShape` learning
    // to read `manifest.extensions` instead of only `activates`. Adding the call
    // now would be dead code that reads like coverage.
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
      await this.teardownShape(located);
    }
    // Type-agnostic and therefore last: any package type may have generated
    // schedule files outside its own install root, and removing the package does
    // not remove those.
    await this.removeGeneratedSchedules(stagingPath);
  }

  /**
   * Delete the skill directories this package's install generated for its inline
   * `schedules[]` declarations.
   *
   * These live outside the install root — in a project's `.agents/skills/` or the
   * global `<dorkHome>/skills/` — so the package leaving disk does not take them
   * with it, and a left-behind one is a schedule that keeps firing for a package
   * that is gone. The list comes from the install receipt
   * (`InstallMetadata.generatedSchedulePaths`), read out of the STAGED copy: by
   * this point the package has already been moved aside, so the sidecar is at
   * `<stagingPath>/.dork/install-metadata.json` and nowhere else.
   *
   * Deleting only what the receipt names is the whole safety model. Nothing here
   * scans a skills root or matches on names: a generated schedule is
   * indistinguishable from a person's own skill by location, so an uninstall that
   * went looking would eventually delete somebody's work. A receipt that is
   * missing, truncated, or (for an install that pre-dates the field) absent
   * simply removes less.
   *
   * Best-effort, like the rest of the janitorial phase: a directory that cannot
   * be removed is logged, never thrown. Failing here would roll the whole
   * uninstall back and restore a package the person asked to remove, over a
   * leftover file.
   *
   * @param stagingPath - The staged copy of the package being removed.
   * @internal
   */
  private async removeGeneratedSchedules(stagingPath: string): Promise<void> {
    const metadata = await readInstallMetadata(stagingPath);
    const generated = metadata?.generatedSchedulePaths ?? [];
    if (generated.length === 0) return;

    for (const dirPath of generated) {
      try {
        await rm(dirPath, { recursive: true, force: true });
      } catch (err) {
        this.deps.logger.warn(
          '[marketplace/uninstall] could not remove a generated schedule directory',
          { path: dirPath, error: err instanceof Error ? err.message : String(err) }
        );
      }
    }
    this.deps.logger.info(
      `[marketplace/uninstall] Removed ${generated.length} generated schedule(s)`,
      { paths: generated }
    );
  }

  /**
   * Tear down everything a removed Shape stood up, so nothing it created
   * outlives it:
   *
   *  1. Delete the schedules it created (provenance-gated), across global and
   *     agent-bound scopes — always, because a Shape's tick must not keep firing
   *     once the Shape is gone. A no-op when the schedule-teardown dependency is
   *     absent (Shape-unaware caller).
   *  2. When this Shape is the currently-active one: turn OFF the extensions it
   *     turned ON (its declared `activates`) and clear `ui.shapes.active` so the
   *     cockpit falls back to no active Shape — the honest state once its layout
   *     is removed. A NON-active Shape's extensions are left alone: they were
   *     never turned on by this Shape's apply, and the active Shape may depend on
   *     them.
   *
   * @internal
   */
  private async teardownShape(located: LocatedPackage): Promise<void> {
    const shapeName = located.manifest?.name ?? path.basename(located.installRoot);
    const deactivator = this.deps.shapeDeactivator;
    const isActive = deactivator?.getActiveShapeName() === shapeName;

    // 1. Delete the Shape's schedules — always, active or not.
    if (this.deps.shapeScheduleTeardown) {
      const removed = await this.deps.shapeScheduleTeardown.deleteSchedulesForShape(shapeName);
      if (removed.length > 0) {
        this.deps.logger.info(
          `[marketplace/uninstall] Removed ${removed.length} schedule(s) created by Shape "${shapeName}"`,
          { schedules: removed }
        );
      }
    }

    // 2. Extensions + active pointer — only when this was the active Shape.
    if (deactivator && isActive) {
      await this.disableShapeExtensions(located);
      deactivator.clearActiveShape();
      this.deps.logger.info(
        `[marketplace/uninstall] Cleared active Shape "${shapeName}" — it was uninstalled`
      );
    }
  }

  /**
   * Disable the extensions an active Shape turned on (its manifest's
   * `activates`), the reverse of `applyShape`'s enable step. A no-op when the
   * located manifest is missing or not a Shape.
   *
   * @internal
   */
  private async disableShapeExtensions(located: LocatedPackage): Promise<void> {
    const manifest = located.manifest;
    if (!manifest || manifest.type !== 'shape') return;
    for (const id of manifest.activates) {
      await this.deps.extensionManager.disable(id);
    }
  }

  /**
   * Walk the staged `.dork/extensions/` directory and, for each extension ID
   * found, turn it off and forget the person's approval for it to run code inside
   * DorkOS.
   *
   * Forgetting the approval is the load-bearing half (DOR-516). An approval is
   * keyed to the extension id, and an update is an uninstall followed by a fresh
   * install ({@link MarketplaceInstaller.update}), so leaving the approval behind
   * meant `foo` v2 — or a package that merely reuses the name `foo` — inherited a
   * decision the person made about entirely different code, with nothing to click
   * and nothing shown. `marketplace_install` is tier `act`, so an agent reaches
   * that path unaided.
   *
   * A person who updates an extension they had approved is asked once more. That
   * is the intended cost: new code, new decision. Editing an installed
   * extension's files never comes through here, so the edit → test → reload loop
   * stays free.
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
        await this.deps.extensionManager.forgetRunApproval(entry.name);
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
