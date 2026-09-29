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
 * happens (`../../lib/records/uninstall-journal.ts`): the package identity files move
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
 * The steps live beside it: `locate.ts` finds the install root, and
 * `side-effects.ts` captures and runs what removing a package undoes
 * elsewhere (extensions, adapters, schedules, Shapes, an agent). The request,
 * result and dependency types, and the not-installed error, are in
 * `support.ts`.
 *
 * @module services/marketplace/flows/uninstall/uninstall
 */
import { copyFile, lstat, readdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRemovedSummary } from '@dorkos/shared/marketplace-schemas';
import {
  AGENT_MANIFEST_PATH,
  CLAUDE_PLUGIN_MANIFEST_PATH,
  INSTALL_METADATA_POSIX_PATH,
  PACKAGE_MANIFEST_PATH,
  UNINSTALLED_AGENT_PATH,
} from '@dorkos/marketplace';
import { hasPackageIdentity } from '../../lib/locate-install.js';
import { assertPackageName } from '../../lib/package-paths.js';
import { describeUnproven } from '../../lib/integrity/unproven.js';
import {
  isProvenPackageFile,
  readInstalledFiles,
  type InstalledFiles,
} from '../../lib/records/installed-files.js';
import { scanTree } from '../../lib/records/tree-scan.js';
import {
  createUninstallSibling,
  finishUninstall,
  journaledMove,
  returnStrays,
  rollBackUninstall,
  writeJournal,
  type UninstallJournal,
} from '../../lib/records/uninstall-journal.js';
import type { InstallRecord } from '../../recovery/install-recovery.js';
import {
  releaseSupersededRecords,
  settleInterruptedInstall,
  withInstallTargetLock,
} from '../../transaction.js';
import { freeSavedFileName, makeInert } from '../../lib/saved-copies/saved-copies.js';
import { UninstallLocator, readManifestIfPresent } from './locate.js';
import { UninstallSideEffects } from './side-effects.js';
import {
  type LocatedPackage,
  type UninstallFlowDeps,
  type UninstallRequest,
  type UninstallResult,
  pathExists,
} from './support.js';

/** Package identity files: always the package's, moved last, restored first. */
const IDENTITY_FILES = [PACKAGE_MANIFEST_PATH, CLAUDE_PLUGIN_MANIFEST_PATH];

/**
 * The files the record lists as unproven (a rebuild could not prove them, or
 * an earlier update kept them) that are still in `root` after the uninstall,
 * as absolute paths, sorted. None when the record lists none.
 */
async function keptUnproven(root: string, record: InstalledFiles | null): Promise<string[]> {
  if (!record?.unproven) return [];
  const kept: string[] = [];
  for (const p of Object.keys(record.unproven.files).sort()) {
    const abs = path.join(root, ...p.split('/'));
    if (await pathExists(abs)) kept.push(abs);
  }
  return kept;
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

/**
 * Uninstall a marketplace package and clean up its registered side-effects
 * (extensions, adapter entries) with rollback safety.
 */
export class UninstallFlow {
  private readonly locator: UninstallLocator;
  private readonly sideEffects: UninstallSideEffects;

  constructor(private readonly deps: UninstallFlowDeps) {
    this.locator = new UninstallLocator(deps);
    this.sideEffects = new UninstallSideEffects(deps);
  }

  /**
   * Locate, stage, and remove the named package.
   *
   * The name is checked before anything touches disk. Every path this flow
   * builds — the probe roots in {@link UninstallLocator.candidatePaths}, and the
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
   * {@link UninstallLocator.locate} stays OUTSIDE the lock, because the path to
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
      const located = await this.locator.locate(req, triedEmpty);
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

    const inputs = await this.sideEffects.captureSideEffectInputs(root);
    if ((await lstat(root)).isSymbolicLink()) {
      // A linked install: the tree is a developer's own; remove the link only.
      await this.sideEffects.runSideEffects(inputs, located, req);
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
      agentRemoved = await this.sideEffects.runSideEffects(inputs, located, req, {
        root,
        sibling,
        journal,
      });
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
    let unproven: string[] = [];
    try {
      if (req.purge) {
        await rm(sibling, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      } else {
        await finishUninstall(sibling, journal);
        preservedData = await keptEntries(root);
        unproven = await keptUnproven(root, record);
      }
    } catch (err) {
      this.deps.logger.warn('[marketplace/uninstall] cleanup after the uninstall failed', {
        root,
        error: err instanceof Error ? err.message : String(err),
      });
      warnings.push('Some cleanup did not finish; DorkOS will finish it the next time it starts.');
    }
    await releaseSupersededRecords(kept);
    if (unproven.length > 0 && record?.unproven) {
      warnings.unshift(
        describeUnproven(
          req.name,
          record.unproven.why,
          unproven.map((p) => path.relative(root, p).split(path.sep).join('/')),
          'uninstall',
          { carried: !record.inferred }
        )
      );
    }
    return {
      ok: true,
      packageName: req.name,
      removedFiles: journal.moves.length,
      preservedData,
      ...(agentRemoved && { agentRemoved }),
      ...(unproven.length > 0 && { unproven }),
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
        const rel = await freeSavedFileName(root, p);
        const saved = path.join(root, ...rel.split('/'));
        // Journaled before it is written, so a rollback removes it.
        journaled.journal.savedCopies = [...(journaled.journal.savedCopies ?? []), rel];
        await writeJournal(journaled.sibling, journaled.journal);
        await copyFile(abs, saved);
        // Kept to read, never to run (DOR-2340).
        await makeInert(saved);
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
}
