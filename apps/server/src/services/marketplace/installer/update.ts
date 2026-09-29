/**
 * Apply an update: the uninstall → remove → reinstall round trip, run under
 * the install target's lock by {@link MarketplaceInstaller.update}.
 *
 * @module services/marketplace/installer/update
 */
import type { ResolvedPackageSource } from '../package-resolver.js';
import { discoverExtensionIds } from '../lib/staged-extensions.js';
import {
  describeDisclosedEffects,
  disclosedEffectsOf,
  sameDisclosedEffects,
} from '../preview/disclosed-effects.js';
import type { InstallRequest, InstallResult } from '../types.js';
import { DisclosureChangedError } from './errors.js';
import type { InstallDispatcher } from './install-dispatch.js';
import type { InstallerDeps } from './marketplace-installer.js';
import { assertInstallable, type PackageStager } from './staging.js';

/** Applies updates, on the installer's dependencies and its staging and install steps. */
export class InstallUpdater {
  constructor(
    private readonly deps: InstallerDeps,
    private readonly stager: PackageStager,
    private readonly dispatcher: InstallDispatcher
  ) {}

  /**
   * The uninstall → remove → reinstall round trip itself, with no
   * serialisation of its own.
   *
   * Split out from {@link MarketplaceInstaller.update} so that entry point is
   * one readable "find the target, then do it under that target's lock" pair.
   * Never call it directly: holding the lock across every step is what keeps a
   * concurrent install from landing in a gap between them.
   *
   * @param req - The install request being applied as an update.
   * @param resolved - The already-resolved package source, so the round trip
   *   and the lock above agree on the canonical package name.
   * @internal
   */
  async applyUpdate(req: InstallRequest, resolved: ResolvedPackageSource): Promise<InstallResult> {
    // Capture whether this package is the currently-applied Shape BEFORE the
    // uninstall half runs, so the post-install re-apply below knows to fire.
    const wasActiveShape =
      this.deps.shapeUpdateHooks?.getActiveShapeName() === resolved.packageName;

    // Stage the new version BEFORE anything is removed, and install exactly
    // that one below (DOR-2195). A failed resolve or fetch now leaves the old
    // version in place, and nothing can land between the check and the install.
    const staged = await this.stager.stageAndValidate(resolved, req);

    // Every refusal that depends only on the new version's content runs here,
    // before the uninstall, so a version that can never install leaves the old
    // one installed rather than removed (DOR-2245 delta review). The install
    // half runs the same checks again; they pass the second time by definition.
    await assertInstallable(staged);

    // An approved update: check what the new version declares against what
    // the person approved, still before the uninstall, so a refusal leaves the
    // package untouched rather than removed.
    if (req.approvedDisclosure !== undefined) {
      const preview = await this.deps.previewBuilder.build(staged.packagePath, staged.manifest, {
        projectPath: req.projectPath,
      });
      const resolvedDisclosure = disclosedEffectsOf(preview);
      if (!sameDisclosedEffects(req.approvedDisclosure, resolvedDisclosure)) {
        throw new DisclosureChangedError(
          describeDisclosedEffects(req.approvedDisclosure),
          describeDisclosedEffects(resolvedDisclosure)
        );
      }
    }

    // 2. Uninstall as the first half of a replace (DOR-2245): only the
    //    package's own files leave, in place and journaled; the person's files
    //    and the pruned installed-files record stay in the root. `replacing`
    //    keeps `ui.shapes.active` intact and an agent package's agent on the
    //    team: the same package lands back here moments later.
    //    The extensions the new version still carries keep their approval
    //    (DOR-2383): the same copy lands back at the same path. Ones it drops
    //    are turned off and forgotten by the uninstall.
    await this.deps.uninstallFlow.uninstall({
      name: resolved.packageName,
      purge: false,
      projectPath: req.projectPath,
      replacing: true,
      retainedExtensionIds: await discoverExtensionIds(staged.packagePath),
      ...(req.installRoot !== undefined && { installRoot: req.installRoot }),
    });

    // 3. Reinstall exactly the version staged and checked above. Its
    //    transaction carries the person's files over from the root the
    //    uninstall left, and restores that root exactly if it fails.
    //
    //    Pre-existing residual, unchanged: a failed install leaves the package
    //    uninstalled (its person files and record in place, so a retry picks
    //    them up). When the update targeted the ACTIVE Shape,
    //    `ui.shapes.active` still points at it; the next apply 404s honestly
    //    and the switcher offers a re-install, where an auto-clear would
    //    silently discard the person's place.
    const installResult = await this.dispatcher.installStaged({ ...req, force: true }, staged);

    // 4. If the updated package is the currently-applied Shape, re-apply it so
    //    the app picks up the new version's extensions, schedules, and
    //    chrome — the suppressed uninstall kept `ui.shapes.active` pointing
    //    here, but only `applyShape` actually activates a manifest.
    //    `installResult.type === 'shape'` guards the cross-type same-name edge
    //    (a plugin named after the active Shape must not trigger a re-apply).
    //    Best-effort: the update itself already succeeded, so a re-apply
    //    failure is logged and the user re-applies from the switcher.
    if (wasActiveShape && installResult.type === 'shape' && this.deps.shapeUpdateHooks) {
      try {
        await this.deps.shapeUpdateHooks.reapplyShape(resolved.packageName);
        this.deps.logger.info(
          `[marketplace/update] Re-applied active Shape "${resolved.packageName}" after update`
        );
      } catch (err) {
        this.deps.logger.warn(
          `[marketplace/update] Failed to re-apply active Shape "${resolved.packageName}" after update (the update itself succeeded — re-apply it from the Shape switcher): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return installResult;
  }
}
