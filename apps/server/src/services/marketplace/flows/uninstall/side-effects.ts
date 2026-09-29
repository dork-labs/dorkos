/**
 * What removing a package undoes elsewhere: its bundled extensions, adapter
 * entries, generated schedules, an active Shape, and an agent package's
 * agent. Inputs are captured from the live root before anything moves.
 *
 * @module services/marketplace/flows/uninstall/side-effects
 */
import { copyFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { isManifestGitTracked } from '@dorkos/mesh';
import type { AgentRemovedSummary } from '@dorkos/shared/marketplace-schemas';
import { AGENT_MANIFEST_PATH, UNINSTALLED_AGENT_PATH } from '@dorkos/marketplace';
import { readInstallMetadata } from '../../installed-metadata.js';
import { writeJournal, type UninstallJournal } from '../../lib/records/uninstall-journal.js';
import {
  type LocatedPackage,
  type SideEffectInputs,
  type UninstallFlowDeps,
  type UninstallRequest,
  pathExists,
} from './support.js';

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

/**
 * Whether `target` is `root` or lies inside it, compared lexically.
 *
 * @param target - Path to test.
 * @param root - Directory that may contain it.
 */
function isPathWithin(target: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Captures and runs an uninstall's side effects, on the flow's dependencies. */
export class UninstallSideEffects {
  constructor(private readonly deps: UninstallFlowDeps) {}

  /**
   * Capture what the side effects need from the live root, before anything
   * moves: an extension whose files the person edited is still disabled and
   * its approval still forgotten (DOR-516), and the generated-schedule receipt
   * is read while it is still in place.
   *
   * @internal
   */
  async captureSideEffectInputs(root: string): Promise<SideEffectInputs> {
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
   * Run the type-specific cleanup hooks against the staged copy. Plugin
   * extensions are disabled by walking the staged `.dork/extensions/`
   * directory; adapter entries are removed via `removeAdapter`; a removed Shape
   * gets its full lifecycle teardown ({@link teardownShape}), suppressed when
   * `req.deactivateShape` is `false` — the installer's update replace, where the
   * Shape comes right back.
   *
   * @internal
   */
  async runSideEffects(
    inputs: SideEffectInputs,
    located: LocatedPackage,
    req: UninstallRequest,
    journaled?: { root: string; sibling: string; journal: UninstallJournal }
  ): Promise<AgentRemovedSummary | undefined> {
    const type = located.inferredType;
    // Every package type that installs under `plugins/` walks `.dork/extensions/`,
    // because discovery reads the extensions of everything installed there
    // (`{dorkHome}/plugins/*/.dork/extensions` and its project twin, DOR-2383):
    // whatever it found is turned off and its approval forgotten here. A `shape`
    // is the exception and keeps its own teardown below. Its bundled tree lives
    // under `shapes/`, which discovery does not scan, and `applyShape` iterates
    // `manifest.activates`, a list of ids, skipping any id
    // `extensionManager.get()` does not already know — so a Shape's own bundled
    // extensions never become a record, and have nothing to turn off and no
    // approval to forget (DOR-516). Whoever teaches discovery or `applyShape` to
    // read a Shape's own tree has to add the walk here as part of it.
    if (type === 'plugin' || type === 'skill-pack' || type === 'adapter') {
      // An update from the same package keeps what it still carries (see
      // `UninstallRequest.retainedExtensionIds`); a plain uninstall keeps nothing.
      const retained = new Set(req.replacing ? (req.retainedExtensionIds ?? []) : []);
      await this.disableBundledExtensions(
        inputs.extensionIds.filter((id) => !retained.has(id)),
        located.installRoot
      );
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
   * An update from the same package is the exception (DOR-2383): the
   * installer passes `retainedExtensionIds`, the extensions the new version
   * still carries, and those keep their approval, since the same copy lands back
   * at the same path — the trade editing an approved extension already makes.
   * Only the ones the new version drops reach this walk. Editing an installed
   * extension's files never comes through here, so the edit → test → reload loop
   * stays free.
   *
   * An approval recorded for a copy of the same id that lives OUTSIDE this
   * package (DOR-2383: another plugin can carry the id) is about that copy, and
   * removing this package leaves it alone.
   *
   * @internal
   */
  private async disableBundledExtensions(
    ids: readonly string[],
    installRoot: string
  ): Promise<void> {
    for (const id of ids) {
      // The id is live from another copy (another plugin carries it, or it is
      // installed directly), and that copy is what discovery resolved: turning
      // the id off would stop it. This package's copy was never the one
      // running, so there is nothing of it to stop (DOR-2383).
      const live = this.deps.extensionManager.get(id);
      if (live && !isPathWithin(live.path, installRoot)) {
        this.deps.logger.info(
          `[marketplace/uninstall] Left '${id}' running: the live copy is ${live.path}, ` +
            `not the one in ${installRoot}`
        );
      } else {
        await this.deps.extensionManager.disable(id);
      }
      // Always asked, whichever copy is live: an approval recorded for THIS
      // package's copy must not survive it (a reinstall would run unasked), and
      // the manager keeps any approval recorded for a copy outside `installRoot`.
      await this.deps.extensionManager.forgetRunApproval(id, installRoot);
    }
  }
}
