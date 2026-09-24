/**
 * Marketplace package uninstall flow.
 *
 * Removes a previously installed package by name. Plugin/skill-pack/adapter
 * packages live under `plugins/<name>/`, agent packages under `agents/<name>/`,
 * and Shapes under `shapes/<name>/` — the same per-type roots the install flows
 * write to ({@link installRootsUnder}), under either scope: the global
 * `dorkHome`, or a project's own `.dork/`. Probing the project scope for
 * `plugins/` alone is what left every project-scoped agent installable but not
 * removable (DOR-994).
 * **In place, and only the package's files (DOR-2245).** An install records
 * which files it put in its root (`.dork/installed-files.json`). An uninstall
 * moves only the files that record proves are the package's (listed, reached
 * through real directories, bytes unchanged), plus the installer-owned paths,
 * into a sibling `<root>.dorkos-uninstall-<createdAt>-<owner>-<uuid>` on the same
 * filesystem. The person's files never move. Everything is journaled before it
 * happens (`../lib/uninstall-journal.ts`): the package identity files move
 * last, side effects run from inputs captured before anything moved, a
 * `committed` phase is written, and only then is the sibling deleted and the
 * record pruned to what the person kept. A failure before the commit renames
 * every move back, identity files first; a crash is settled the same way by
 * recovery. `purge: true` removes the whole root once the uninstall commits.
 *
 * An agent package's agent leaves the team as the last side effect (its
 * `agent.json` parked as `.dork/uninstalled-agent.json` first), unless the
 * uninstall is the first half of an update (`replacing`).
 *
 * A linked install (the root is a symlink to a developer's working copy,
 * DOR-2194) is removed by removing the link; nothing inside it is touched.
 *
 * Concurrency: this flow takes the same per-target lock as the install engine
 * (`withInstallTargetLock`, DOR-711).
 *
 * @module services/marketplace/flows/uninstall
 */
import { copyFile, lstat, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import { isManifestGitTracked } from '@dorkos/mesh';
import type { AgentRemovedSummary } from '@dorkos/shared/marketplace-schemas';
import {
  AGENT_MANIFEST_PATH,
  CLAUDE_PLUGIN_MANIFEST_PATH,
  INSTALL_METADATA_POSIX_PATH,
  PACKAGE_MANIFEST_PATH,
  UNINSTALLED_AGENT_PATH,
} from '@dorkos/marketplace';
import type { MarketplacePackageManifest, PackageType } from '@dorkos/marketplace';
import {
  hasPackageIdentity,
  installRootCandidates,
  type InstallRootCandidate,
} from '../lib/locate-install.js';
import { assertPackageName } from '../lib/package-paths.js';
import { readInstallMetadata } from '../installed-metadata.js';
import {
  isProvenPackageFile,
  readInstalledFiles,
  scanTree,
  type InstalledFiles,
} from '../lib/installed-files.js';
import {
  createUninstallSibling,
  finishUninstall,
  journaledMove,
  returnStrays,
  rollBackUninstall,
  writeJournal,
  type UninstallJournal,
} from '../lib/uninstall-journal.js';
import { hasInstallRecords, type InstallRecord } from '../install-recovery.js';
import {
  releaseSupersededRecords,
  settleInterruptedInstall,
  withInstallTargetLock,
} from '../transaction.js';

/** Everything removing an agent from the team takes away (the unregister cascade). */
const AGENT_REMOVAL_EFFECTS: AgentRemovedSummary['removed'] = [
  'relay-endpoint',
  'rooms',
  'schedules-paused',
  'task-roots',
  'mcp-sign-ins',
  'identity-tokens',
  'community-enrollments',
  'connection-access',
];

/** Package identity files: always the package's, moved last, restored first. */
const IDENTITY_FILES = [PACKAGE_MANIFEST_PATH, CLAUDE_PLUGIN_MANIFEST_PATH];

/** A request to uninstall a marketplace package. */
export interface UninstallRequest {
  /** Package name to uninstall. */
  name: string;
  /** Also remove the files you and your agents added or changed. */
  purge?: boolean;
  /** Project path for project-local uninstalls. */
  projectPath?: string;
  /**
   * Internal (installer-only): this removal is the first half of a replace
   * (the installer's `update()`), not a removal. It keeps `ui.shapes.active`
   * intact and leaves an agent package's agent registered, because the same
   * package lands back at the same path moments later. The HTTP route's body
   * schema does not expose it, so external callers always get the full
   * removal.
   */
  replacing?: boolean;
  /**
   * Internal (installer-only): the exact install root to remove, when the
   * caller already resolved which installation it means — the installer's
   * `update()` replacing the installation an update check found. See
   * `LocateInstallInput.installRoot`; not exposed by the HTTP body schema.
   */
  installRoot?: string;
}

/** The outcome of a successful uninstall. */
export interface UninstallResult {
  ok: boolean;
  packageName: string;
  /** Number of entries moved out of the install root (a whole directory counts once). */
  removedFiles: number;
  /**
   * Absolute paths kept on disk because `purge` was false: the files you and
   * your agents added or changed, collapsed to the highest directory whose
   * whole contents were kept.
   */
  preservedData: string[];
  /** Set when uninstalling an agent package removed the agent from the team. */
  agentRemoved?: AgentRemovedSummary;
  /** Non-fatal notes: cleanup the recovery sweep will finish, files moved back. */
  warnings?: string[];
}

/**
 * The agent-registry surface the uninstall flow uses to take an uninstalled
 * agent package's agent off the team, and to put it back when the uninstall
 * rolls back after that step.
 */
export interface UninstallAgentRegistry {
  /**
   * Unregister the agent registered at `projectPath` (the full cascade).
   *
   * @returns Its id and whether its manifest was kept and the folder denied, or
   *   `null` when no agent is registered there.
   */
  unregisterAtPath(projectPath: string): Promise<{ id: string; directoryDenied: boolean } | null>;
  /** Register the agent at `projectPath` again from its `agent.json`. */
  restoreAtPath(projectPath: string): Promise<void>;
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
  /** Takes an uninstalled agent package's agent off the team; omit when mesh is off. */
  agentRegistry?: UninstallAgentRegistry;
  /**
   * Rebuild the installed-files record of an install made before records
   * existed (spec §9); `null` when none can be rebuilt.
   */
  rebuildLegacy?: (installRoot: string) => Promise<InstalledFiles | null>;
  logger: Logger;
}

/** The side-effect inputs, captured from the live root before anything moves. */
interface SideEffectInputs {
  /** Bundled extension ids (`.dork/extensions/<id>/`). */
  extensionIds: string[];
  /** Skill directories this install generated for its schedules. */
  generatedSchedulePaths: string[];
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
   * lock is not known until it has run. It counts a root with transaction
   * records beside it as a candidate even when the root itself is missing —
   * a crash can leave the previous install only in a backup (DOR-2273), and
   * calling that "not installed" would let a later recovery bring the package
   * back. Inside the lock the root is settled and read again
   * ({@link UninstallFlow.settleAndReread}); when settling leaves nothing
   * there (a half-written fresh install removed, or a package removed between
   * the probe and the lock), the search moves on to the next candidate and
   * never offers that one again.
   *
   * The crash window of `MarketplaceInstaller.update()` — between this
   * uninstall moving the package to the system temp directory and the
   * reinstall committing — is not covered here: nothing on disk beside the
   * target describes a package that is in the temp directory. DOR-2245
   * replaces this temp-dir uninstall with an in-place one that journals it.
   *
   * @param req - Uninstall request — name, optional purge flag, optional project path.
   * @returns The uninstall result, including any data paths preserved on disk.
   * @throws {InvalidPackageNameError} If the name is not a canonical package name.
   * @throws {PackageNotInstalledError} If no install matches the requested name.
   */
  async uninstall(req: UninstallRequest): Promise<UninstallResult> {
    assertPackageName(req.name);
    // Each pass either removes the package or finds its candidate empty once
    // settled. An empty candidate is never offered again — a record settling
    // could not delete (a stuck `.committed`) would otherwise keep offering
    // it every pass, and a later candidate holding the package would never
    // be reached — so this ends after at most one pass per candidate.
    const triedEmpty = new Set<string>();
    for (;;) {
      const located = await this.locate(req, triedEmpty);
      const result = await withInstallTargetLock(located.installRoot, () =>
        this.removeLocated(req, located)
      );
      if (result) return result;
      triedEmpty.add(located.installRoot);
    }
  }

  /**
   * Settle the located root, then stage the package aside, run its
   * side-effects, and either commit the removal or restore the staged copy.
   * Returns `undefined` when settling left nothing at the root.
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
    probed: LocatedPackage
  ): Promise<UninstallResult | undefined> {
    const settled = await this.settleAndReread(probed);
    if (!settled) return undefined;
    const { located, kept } = settled;
    const root = located.installRoot;

    const inputs = await this.captureSideEffectInputs(root);
    if ((await lstat(root)).isSymbolicLink()) {
      // A linked install: the tree is a developer's own; remove the link only.
      await this.runSideEffects(inputs, located, req);
      await unlink(root);
      await releaseSupersededRecords(kept);
      return { ok: true, packageName: req.name, removedFiles: 1, preservedData: [] };
    }

    const record = await this.recordFor(root);
    const sibling = await createUninstallSibling(root);
    const journal: UninstallJournal = {
      version: 1,
      root,
      package: { name: req.name, type: located.inferredType },
      moves: [],
      phase: 'moving',
    };
    const warnings: string[] = [];
    let agentRemoved: AgentRemovedSummary | undefined;
    try {
      await writeJournal(sibling, journal);
      for (const move of await this.planMoves(root, record, { sibling, journal })) {
        await journaledMove({ root, sibling, journal, move });
      }
      journal.phase = 'side-effects';
      await writeJournal(sibling, journal);
      agentRemoved = await this.runSideEffects(inputs, located, req, { root, sibling, journal });
      for (const stray of await returnStrays({ root, sibling, journal })) {
        warnings.push(
          `${stray.path} was written while the uninstall ran and was kept at ${stray.landedAt}.`
        );
      }
      journal.phase = 'committed';
      await writeJournal(sibling, journal);
    } catch (err) {
      await this.rollBack(sibling, journal);
      throw err;
    }

    // Committed: the uninstall is decided. A failure from here on is logged and
    // left for recovery to finish; it never rolls back a torn-down package.
    let preservedData: string[] = [];
    try {
      if (req.purge) {
        await rm(sibling, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      } else {
        await finishUninstall(sibling, journal);
        preservedData = await keptEntries(root);
      }
    } catch (err) {
      this.deps.logger.warn('[marketplace/uninstall] cleanup after the uninstall failed', {
        root,
        error: err instanceof Error ? err.message : String(err),
      });
      warnings.push('Some cleanup did not finish; DorkOS will finish it the next time it starts.');
    }
    await releaseSupersededRecords(kept);
    return {
      ok: true,
      packageName: req.name,
      removedFiles: journal.moves.length,
      preservedData,
      ...(agentRemoved && { agentRemoved }),
      ...(warnings.length > 0 && { warnings }),
    };
  }

  /**
   * The root's installed-files record, rebuilt for an install made before
   * records existed, or `null` when none can be had (the legacy fallback).
   *
   * @internal
   */
  private async recordFor(root: string): Promise<InstalledFiles | null> {
    const record = await readInstalledFiles(root, this.deps.logger);
    if (record || !this.deps.rebuildLegacy) return record;
    return this.deps.rebuildLegacy(root);
  }

  /**
   * What to move into the sibling, in order: record-proven package files
   * (whole directories when everything in them is the package's), the
   * installer-owned paths, then the identity files last. With no record (the
   * legacy fallback), only the installer-owned paths and the identity files
   * move: everything else is kept, since nothing proves it is the package's.
   *
   * @internal
   */
  private async planMoves(
    root: string,
    record: InstalledFiles | null,
    journaled: { sibling: string; journal: UninstallJournal }
  ): Promise<{ path: string; unitFiles?: string[] }[]> {
    const ownedPaths = record?.ownedPaths ?? ['node_modules'];
    const installerFiles = [INSTALL_METADATA_POSIX_PATH];
    const skip = (p: string): boolean =>
      IDENTITY_FILES.includes(p) ||
      installerFiles.includes(p) ||
      ownedPaths.some((o) => p === o || p.startsWith(`${o}/`));
    const scan = await scanTree(root, { skip });
    const proven = new Set<string>();
    if (record) {
      for (const p of Object.keys(record.files)) {
        if (skip(p)) continue;
        if (await isProvenPackageFile(root, p, record)) proven.add(p);
      }
    }
    // Whole directories whose every entry is a proven package file move as one unit.
    const units: string[] = [];
    for (const dir of [...scan.dirs].sort()) {
      if (units.some((u) => dir.startsWith(`${u}/`))) continue;
      const inside = [...scan.entries.keys()].filter((p) => p.startsWith(`${dir}/`));
      const hasSubdirOnlyWithoutFiles = [...scan.dirs].some(
        (d) =>
          d.startsWith(`${dir}/`) && ![...scan.entries.keys()].some((p) => p.startsWith(`${d}/`))
      );
      if (inside.length > 0 && !hasSubdirOnlyWithoutFiles && inside.every((p) => proven.has(p))) {
        units.push(dir);
      }
    }
    const moves: { path: string; unitFiles?: string[] }[] = [];
    for (const unit of units) {
      moves.push({
        path: unit,
        unitFiles: [...proven]
          .filter((p) => p.startsWith(`${unit}/`))
          .map((p) => p.slice(unit.length + 1)),
      });
    }
    for (const p of [...proven].sort()) {
      if (!units.some((u) => p.startsWith(`${u}/`))) moves.push({ path: p });
    }
    for (const p of [...ownedPaths, ...installerFiles, ...IDENTITY_FILES]) {
      if ((await lstat(path.join(root, ...p.split('/'))).catch(() => undefined)) !== undefined) {
        moves.push({ path: p });
      }
    }
    // An identity file always leaves with the package, but one the person
    // edited is theirs too: a copy stays behind as `.dork-old`, as an update does.
    if (record) {
      for (const p of IDENTITY_FILES) {
        if (!(p in record.files) || (await isProvenPackageFile(root, p, record))) continue;
        const abs = path.join(root, ...p.split('/'));
        if (!(await pathExists(abs))) continue;
        let saved = `${abs}.dork-old`;
        for (let n = 2; await pathExists(saved); n++) saved = `${abs}.dork-old.${n}`;
        // Journaled before it is written, so a rollback removes it.
        const rel = path.relative(root, saved).split(path.sep).join('/');
        journaled.journal.savedCopies = [...(journaled.journal.savedCopies ?? []), rel];
        await writeJournal(journaled.sibling, journaled.journal);
        await copyFile(abs, saved);
      }
    }
    return moves;
  }

  /**
   * Undo an uncommitted uninstall: every journaled move back, identity files
   * first, and, when the agent was already taken off the team, its manifest
   * restored and the agent registered again. Logged, never thrown, so it
   * cannot mask the original error.
   *
   * @internal
   */
  private async rollBack(sibling: string, journal: UninstallJournal): Promise<void> {
    try {
      await rollBackUninstall(sibling, journal);
      if (journal.agentUnregistered) {
        const parked = path.join(journal.root, ...UNINSTALLED_AGENT_PATH.split('/'));
        const manifest = path.join(journal.root, ...AGENT_MANIFEST_PATH.split('/'));
        if (!(await pathExists(manifest)) && (await pathExists(parked))) {
          await copyFile(parked, manifest);
        }
        await rm(parked, { force: true });
        await this.deps.agentRegistry?.restoreAtPath(journal.root);
      }
    } catch (rollbackErr) {
      this.deps.logger.warn(
        `[marketplace/uninstall] rollback of ${journal.root} did not finish; recovery will retry: ${
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        }`
      );
    }
  }

  /**
   * Capture what the side effects need from the live root, before anything
   * moves: an extension whose files the person edited is still disabled and
   * its approval still forgotten (DOR-516), and the generated-schedule receipt
   * is read while it is still in place.
   *
   * @internal
   */
  private async captureSideEffectInputs(root: string): Promise<SideEffectInputs> {
    const extensionIds: string[] = [];
    try {
      for (const entry of await readdir(path.join(root, '.dork', 'extensions'), {
        withFileTypes: true,
      })) {
        if (entry.isDirectory()) extensionIds.push(entry.name);
      }
    } catch {
      // No bundled extensions.
    }
    const metadata = await readInstallMetadata(root);
    return { extensionIds, generatedSchedulePaths: metadata?.generatedSchedulePaths ?? [] };
  }

  /**
   * Settle an install a crash interrupted at the located root, then read what
   * stands there now (DOR-2273). Uninstall must remove the last committed
   * install, never a half-written one, and must not leave that install's
   * backup behind for a later recovery to put back. Settling can restore an
   * older version or remove a half-written fresh install, so the manifest read
   * before the lock is stale. Returns `undefined` when nothing stands at the
   * root afterwards, and the records settling kept, to release once the
   * removal finishes.
   *
   * @internal
   */
  private async settleAndReread(
    probed: LocatedPackage
  ): Promise<{ located: LocatedPackage; kept: InstallRecord[] } | undefined> {
    const { kept, restoredAgent } = await settleInterruptedInstall(probed.installRoot);
    // An earlier uninstall of this agent, interrupted after it left the team,
    // was just rolled back: register it again, as startup recovery does, so
    // this uninstall takes it off the team with the full cascade.
    if (restoredAgent) await this.deps.agentRegistry?.restoreAtPath(probed.installRoot);
    if (!(await hasPackageIdentity(probed.installRoot))) return undefined;
    const manifest = await readManifestIfPresent(probed.installRoot);
    return {
      located: {
        installRoot: probed.installRoot,
        manifest,
        inferredType: manifest?.type ?? probed.inferredType,
      },
      kept,
    };
  }

  /**
   * Search the canonical install locations for a package matching `req.name`
   * and return the first match. Reads `dork-package.json` to determine the
   * package type when one is present, otherwise infers it from the layout.
   *
   * First-match wins across the probe order (the project scope's roots
   * `plugins` → `agents` → `shapes`, then the global scope's):
   * {@link UninstallRequest} carries no
   * package type, so when two different-type packages share a name (e.g. a
   * plugin *and* a Shape both called "linear-ops"), an uninstall by name always
   * resolves to the earlier root and the later one stays untouched. That
   * cross-type collision is surfaced as a non-blocking warning at install time
   * by the conflict detector's package-name rule, so the ambiguity is visible
   * before it is ever created.
   *
   * @param req - The uninstall request.
   * @param skip - Roots already settled and found empty in this uninstall.
   * @throws {PackageNotInstalledError} When no candidate outside `skip` holds
   *   the package or records of it.
   * @internal
   */
  private async locate(
    req: UninstallRequest,
    skip: ReadonlySet<string> = new Set()
  ): Promise<LocatedPackage> {
    const candidates = this.candidatePaths(req);
    for (const candidate of candidates) {
      if (skip.has(candidate.installRoot)) continue;
      // A root holding only files an earlier uninstall kept is not an install
      // (DOR-2245); records beside a target still are, so recovery settles them.
      const present =
        (await hasPackageIdentity(candidate.installRoot)) ||
        (await hasInstallRecords(candidate.installRoot));
      if (!present) continue;
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
   * Build the ordered list of paths to probe for an installed package: every
   * install root (`plugins`, `agents`, `shapes`) under the request's project
   * scope when it has one, then every install root under the global
   * `dorkHome`.
   *
   * Both halves come from {@link installRootsUnder}, so a package type can
   * never install somewhere the probe does not look — the drift that first hid
   * Shapes globally, and then hid project-scoped agents, which the project half
   * used to miss by hardcoding `plugins` (DOR-994). A project's roots stay
   * ahead of the global ones because a project install shadows a global package
   * of the same name for that project, matching the installed scanner's merged
   * view, which the update flow checks.
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
      installRoot: req.installRoot,
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
    inputs: SideEffectInputs,
    located: LocatedPackage,
    req: UninstallRequest,
    journaled?: { root: string; sibling: string; journal: UninstallJournal }
  ): Promise<AgentRemovedSummary | undefined> {
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
      await this.disableBundledExtensions(inputs.extensionIds);
    }
    if (type === 'adapter') {
      await this.deps.adapterManager.removeAdapter(
        located.manifest?.name ?? path.basename(located.installRoot)
      );
    }
    if (type === 'shape' && !req.replacing) {
      await this.teardownShape(located);
    }
    // Type-agnostic: any package type may have generated schedule files outside
    // its own install root, and removing the package does not remove those.
    await this.removeGeneratedSchedules(inputs.generatedSchedulePaths);
    // Last, because nothing after it may fail and roll the package back
    // without its agent: take an uninstalled agent package's agent off the team.
    if (type === 'agent' && !req.replacing && journaled) {
      return this.removeAgent(journaled);
    }
    return undefined;
  }

  /**
   * Park `agent.json` as `.dork/uninstalled-agent.json` (so a reinstall of the
   * same package can keep the agent's identity) and unregister the agent: the
   * full cascade, which a reinstall does not restore. The journal records it
   * before it happens, so a rollback knows to register the agent again.
   *
   * @internal
   */
  private async removeAgent(journaled: {
    root: string;
    sibling: string;
    journal: UninstallJournal;
  }): Promise<AgentRemovedSummary | undefined> {
    if (!this.deps.agentRegistry) return undefined;
    const manifest = path.join(journaled.root, ...AGENT_MANIFEST_PATH.split('/'));
    const parked = path.join(journaled.root, ...UNINSTALLED_AGENT_PATH.split('/'));
    // Journaled first, so a rollback knows to put the manifest back.
    journaled.journal.agentUnregistered = true;
    await writeJournal(journaled.sibling, journaled.journal);
    if (await pathExists(manifest)) {
      // Moved, so no live agent.json is left for a scan to register when the
      // registry has no row to release it. A git-tracked one is copied instead
      // and left to the unregister, which keeps it and denies the folder
      // (DOR-1019): an uninstall never changes a person's source tree.
      if (await isManifestGitTracked(journaled.root, this.deps.logger)) {
        await copyFile(manifest, parked);
      } else {
        await rename(manifest, parked);
      }
    }
    const removed = await this.deps.agentRegistry.unregisterAtPath(journaled.root);
    if (!removed) return undefined;
    return {
      id: removed.id,
      directoryDenied: removed.directoryDenied,
      removed: [...AGENT_REMOVAL_EFFECTS],
    };
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
  private async removeGeneratedSchedules(generated: readonly string[]): Promise<void> {
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
  private async disableBundledExtensions(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.deps.extensionManager.disable(id);
      await this.deps.extensionManager.forgetRunApproval(id);
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

/**
 * What an uninstall kept in `root`: every remaining entry, collapsed to the
 * highest directory whose whole contents were kept. After an uninstall
 * finishes, everything left is the person's except the pruned record, so a
 * directory is listed whole unless the record sits inside it. Empty when the
 * root is gone.
 */
async function keptEntries(root: string): Promise<string[]> {
  const recordPath = path.join(root, '.dork', 'installed-files.json');
  const kept: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (abs === recordPath) continue;
      if (entry.isDirectory() && recordPath.startsWith(`${abs}${path.sep}`)) await walk(abs);
      else kept.push(abs);
    }
  };
  await walk(root);
  return kept.sort();
}
