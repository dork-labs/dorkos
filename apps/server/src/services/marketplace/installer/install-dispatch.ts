/**
 * Install a staged package: the conflict and disclosure gates, the dispatch to
 * the type-specific flow, what the install records about itself, and the one
 * telemetry event per terminal state.
 *
 * @module services/marketplace/installer/install-dispatch
 */
import path from 'node:path';
import {
  resolvePackageVersion,
  type MarketplacePackageManifest,
  type PackageType,
  type PluginSource,
} from '@dorkos/marketplace';
import type { ResolvedPackageSource } from '../package-resolver.js';
import { rebuildInstalledFiles } from '../lib/records/legacy-record.js';
import { reportInstallEvent, type InstallEvent } from '../telemetry/telemetry-hook.js';
import { writeInstallMetadata } from '../installed-metadata.js';
import { deriveSourceProvenance } from '../lib/source-provenance.js';
import { materializePackageSchedules } from '../lib/schedules/materialize-schedules.js';
import { recordProjectInstall } from '../lib/project-install-index.js';
import { trustedSourceOfInstall } from '../lib/trusted-source.js';
import {
  describeDisclosedEffects,
  disclosedEffectsOf,
  sameDisclosedEffects,
} from '../preview/disclosed-effects.js';
import type { InstallRequest, InstallResult } from '../types.js';
import { ConflictError, DisclosureChangedError } from './errors.js';
import type { InstallerDeps } from './marketplace-installer.js';
import { recordableContentHash, recordSourceOf } from './metadata.js';
import { assertInstallable, type PackageStager, type StagedPackage } from './staging.js';

/** Sentinel marketplace value used when a package was resolved directly (git URL / local path). */
const DIRECT_SOURCE_LABEL = '<direct>';

/** Runs an install of a staged package, on the installer's dependencies. */
export class InstallDispatcher {
  constructor(
    private readonly deps: InstallerDeps,
    private readonly stager: PackageStager
  ) {}

  /**
   * {@link MarketplaceInstaller.install}, optionally from a package an update already resolved,
   * staged and checked, so the install writes exactly what was checked instead
   * of resolving a second time (DOR-2195).
   *
   * @param req - The install request.
   * @param prestaged - The update's own resolve and stage, when there is one.
   * @returns The populated {@link InstallResult}.
   * @internal
   */
  async installStaged(req: InstallRequest, prestaged?: StagedPackage): Promise<InstallResult> {
    const startTime = Date.now();
    let resolved: ResolvedPackageSource | null = null;
    let packageType: PackageType | null = null;

    try {
      const staged = prestaged ?? (await this.stager.resolveAndValidate(req));
      resolved = staged.resolved;
      packageType = staged.manifest.type;
      // The type decides where a package lands and whether an agent's install
      // was carded, so a source that served one type to the preview and
      // another to this fetch is refused before anything is written (DOR-2325).
      if (req.approvedPackageType !== undefined && req.approvedPackageType !== packageType) {
        throw new DisclosureChangedError(
          `a ${req.approvedPackageType} package`,
          `a ${packageType} package`
        );
      }

      // Refusals that depend only on the package's content: a schedule that
      // could never run, an unparseable SKILL.md. Checked before any flow
      // touches disk, so the answer is one clear sentence (see the helper).
      await assertInstallable(staged);

      const preview = await this.deps.previewBuilder.build(staged.packagePath, staged.manifest, {
        projectPath: req.projectPath,
      });

      // The last window (DOR-647). This preview is a SECOND resolve of the
      // package: the approval bound what the first one disclosed, so a source that
      // served one thing while a person read the card and another while the
      // install runs would slip through everything upstream. Free to check — the
      // preview above is built for the conflict gate anyway — and this is the last
      // moment at which refusing still means nothing has been written.
      //
      // Only when the caller actually carries an approval. The CLI and the
      // cockpit's `act`-tier route resolve once and install from what they
      // resolved, so there is no earlier disclosure to be inconsistent with, and
      // inventing one would refuse installs nobody ever approved anything about.
      if (req.approvedDisclosure !== undefined) {
        const resolvedDisclosure = disclosedEffectsOf(preview);
        if (!sameDisclosedEffects(req.approvedDisclosure, resolvedDisclosure)) {
          throw new DisclosureChangedError(
            describeDisclosedEffects(req.approvedDisclosure),
            describeDisclosedEffects(resolvedDisclosure)
          );
        }
      }

      if (!req.force && preview.conflicts.some((c) => c.level === 'error')) {
        throw new ConflictError(preview.conflicts);
      }

      // The package exactly as it came through the channel, hashed BEFORE the
      // flow copies it, npm writes into the copy and `prepareStaged` injects
      // skillRef schedules (neither of which the preview does): what a person's
      // approval of a global package binds, the same hash the preview showed
      // (DOR-2306).
      const shippedHash = await recordableContentHash(staged.packagePath);
      // Held to the files its preview fetched, whatever the type (DOR-2325):
      // nothing is written when the source served something else since. A
      // copy that cannot be hashed is refused too.
      if (
        req.approvedContentHash !== undefined &&
        shippedHash.contentHash !== req.approvedContentHash
      ) {
        throw new DisclosureChangedError('the files you were shown', 'different files');
      }
      // A `skillRef` schedule is written into the package's own SKILL.md in the
      // staged tree, before the installed-files record is computed, so the
      // record holds the file as installed: an untouched update then reports
      // nothing and an uninstall removes it (DOR-2318). Warnings wait for the
      // result, and a rolled-back install says nothing.
      const stagedScheduleWarnings: string[] = [];
      const result = await this.dispatchFlow(staged.packagePath, staged.manifest, {
        ...req,
        ownership: {
          prepareStaged: async (stagingDir: string) => {
            const injected = await materializePackageSchedules({
              manifest: staged.manifest,
              installPath: stagingDir,
              forms: 'skillRef',
              dorkHome: this.deps.dorkHome,
              projectPath: req.projectPath,
              logger: this.deps.logger,
            });
            stagedScheduleWarnings.splice(0, Infinity, ...injected.warnings);
          },
          rebuildLegacy: (liveRoot: string, stagedTree: string) =>
            rebuildInstalledFiles(
              liveRoot,
              { fetcher: this.deps.fetcher, logger: this.deps.logger },
              stagedTree
            ),
          ...req.ownership,
          ...(recordSourceOf(staged.sourceKey, resolved) && {
            source: recordSourceOf(staged.sourceKey, resolved),
          }),
        },
      });

      // Turn the package's inline schedules into files. Type-agnostic and
      // therefore here rather than in each flow: a schedule means the same thing
      // whichever of the four types shipped it, and three copies of this call
      // would be three chances to drift. It runs AFTER the flow because it
      // writes into the skills root the install is scoped to. (`skillRef`
      // entries were written into the staged tree above.)
      //
      // Failures warn rather than fail: the package is already installed and
      // working, and the schedule problems that genuinely justify refusing an
      // install were caught in `resolveAndValidate`, before anything touched
      // disk. See `lib/schedules/materialize-schedules.ts`.
      const materialized = await materializePackageSchedules({
        manifest: staged.manifest,
        installPath: result.installPath,
        forms: 'inline',
        dorkHome: this.deps.dorkHome,
        projectPath: req.projectPath,
        logger: this.deps.logger,
      });
      result.warnings.push(...stagedScheduleWarnings, ...materialized.warnings);

      // Persist install provenance to `.dork/install-metadata.json` so the
      // update flow can scope its marketplace lookups, the routes layer can
      // surface "installed from" / "installed at" to API clients, and (DOR-147)
      // downstream consumers (reinstall integrity, `dorkos contribute`) can
      // trace an installed package back to its source repo/ref/commit.
      // Best-effort: a metadata write failure is logged but does not fail
      // the install — the package itself is already on disk.
      try {
        const provenance = deriveSourceProvenance(resolved);
        // Claude Code's chain, not the manifest: a Claude-Code-only package's
        // synthesized manifest says 0.0.0 whatever plugin.json states. The
        // commit is deliberately left out, so `version` stays a version string
        // and the commit keeps its own field.
        const resolvedVersion = resolvePackageVersion({
          declaredVersion: staged.declaredVersion,
          entryVersion: resolved.entryVersion,
        });
        await writeInstallMetadata(result.installPath, {
          name: result.packageName,
          version: resolvedVersion?.version ?? result.version,
          type: result.type,
          installedFrom: resolved.marketplaceName,
          installedAt: new Date().toISOString(),
          sourceRepo: provenance.sourceRepo,
          sourceRef: provenance.sourceRef,
          commitSha: staged.commitSha,
          ...(resolved.entryVersion !== undefined && { entryVersion: resolved.entryVersion }),
          ...(staged.sourceKey !== undefined && { sourceKey: staged.sourceKey }),
          ...(result.dependencyWarnings !== undefined &&
            result.dependencyWarnings.length > 0 && {
              dependencyWarnings: result.dependencyWarnings,
            }),
          // The uninstall receipt: skill directories this install generated
          // OUTSIDE the package's own install root, which removing the package
          // would otherwise leave behind firing forever.
          ...(materialized.generatedPaths.length > 0 && {
            generatedSchedulePaths: materialized.generatedPaths,
          }),
          // What was installed, as it arrived (hashed above, never re-hashed
          // after npm wrote into it): what a person's approval of a global
          // package binds (DOR-2306). Left out if it could not be hashed, which
          // holds the package back until someone reviews it.
          ...shippedHash,
        });
      } catch (metaErr) {
        this.deps.logger.warn('[marketplace-installer] failed to write install-metadata.json', {
          packageName: result.packageName,
          installPath: result.installPath,
          error: metaErr instanceof Error ? metaErr.message : String(metaErr),
        });
        // The receipt is the ONLY record of the directories this install
        // generated outside the package. Without it, uninstall has no safe way
        // to find them — it deletes from the receipt and never by scanning — so
        // they would outlive the package permanently, with the install still
        // reporting success. Name them, so a person has the list the file was
        // supposed to keep.
        if (materialized.generatedPaths.length > 0) {
          result.warnings.push(
            `DorkOS could not record what this package installed, so removing it later will ` +
              `leave its scheduled tasks behind. Delete these folders by hand if you uninstall ` +
              `it: ${materialized.generatedPaths.join(', ')}`
          );
        }
      }

      // DOR-2249: the package cache's sweep keeps the tree an install records,
      // but it only finds project installs through the agent registry, which
      // misses unregistered folders. This record is how it finds the rest.
      if (req.projectPath && isInsideDir(req.projectPath, result.installPath)) {
        // Where it came from, recorded HERE rather than trusted from the
        // sidecar inside the project later: this record is the only proof of
        // a project copy's origin (spec `flow-multiproject` §9.1). Only a
        // branch or tag of the source repository counts, and the staged
        // folder's digest is kept so a later write anywhere in the plugin
        // never inherits the origin.
        const source = trustedSourceOfInstall({
          sourceRepo: deriveSourceProvenance(resolved).sourceRepo,
          sourceKey: staged.sourceKey,
        });
        try {
          await recordProjectInstall(this.deps.dorkHome, {
            projectPath: req.projectPath,
            installRoot: result.installPath,
            name: result.packageName,
            ...(staged.commitSha !== undefined && { commitSha: staged.commitSha }),
            ...(staged.sourceKey !== undefined && { subpath: staged.sourceKey.subpath }),
            ...(source !== null &&
              result.installDigest !== undefined && {
                source,
                installDigest: result.installDigest,
              }),
          });
        } catch (err) {
          // Best-effort like the sidecar: the package is installed; at worst
          // its cached tree is fetched again later.
          this.deps.logger.warn('[marketplace-installer] failed to record the project install', {
            packageName: result.packageName,
            installPath: result.installPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // The sidecar and the project record above are what prove where a
      // plugin's extensions came from (spec `flow-multiproject` §9.1), and both
      // land after the plugin flow enabled them. Re-scan so a newer copy of an
      // extension from an approved source takes over; it runs in the
      // background, after this install answers.
      if (result.type === 'plugin') this.deps.pluginFlow.refreshExtensionCopies();

      await this.reportTerminalOutcome({
        resolved,
        packageType: staged.manifest.type,
        requestedName: req.name,
        outcome: 'success',
        startTime,
      });

      return result;
    } catch (err) {
      await this.reportTerminalOutcome({
        resolved,
        packageType,
        requestedName: req.name,
        outcome: 'failure',
        startTime,
        errorCode: err instanceof Error ? err.name : 'UnknownError',
      });
      throw err;
    }
  }

  /**
   * Dispatch to the type-specific flow. The discriminated union on
   * `manifest.type` gives us exhaustive routing that would fail to compile
   * if a new package type is added without updating the installer.
   *
   * @internal
   */
  private async dispatchFlow(
    packagePath: string,
    manifest: MarketplacePackageManifest,
    req: InstallRequest
  ): Promise<InstallResult> {
    switch (manifest.type) {
      case 'plugin':
        return this.deps.pluginFlow.install(packagePath, manifest, req);
      case 'agent':
        return this.deps.agentFlow.install(packagePath, manifest, req);
      case 'skill-pack':
        return this.deps.skillPackFlow.install(packagePath, manifest, req);
      case 'adapter':
        return this.deps.adapterFlow.install(packagePath, manifest, req);
      case 'shape':
        return this.deps.shapeFlow.install(packagePath, manifest, req);
      default: {
        // Exhaustiveness guard: a sixth package type added to the schema
        // without a dispatch case here fails to compile (the `never`
        // assignment), and — belt and braces — throws at runtime rather than
        // silently no-op'ing if one ever reaches this arm untyped.
        const _exhaustive: never = manifest;
        throw new Error(
          `Unsupported package type '${(_exhaustive as { type?: string }).type ?? 'unknown'}'`
        );
      }
    }
  }

  /**
   * Emit a single {@link reportInstallEvent} call describing the terminal
   * state of the pipeline. Called once per `install()` invocation from both
   * the success and failure paths.
   *
   * @internal
   */
  private async reportTerminalOutcome(params: {
    resolved: ResolvedPackageSource | null;
    packageType: PackageType | null;
    requestedName: string;
    outcome: 'success' | 'failure' | 'cancelled';
    startTime: number;
    errorCode?: string;
  }): Promise<void> {
    await reportInstallEvent({
      packageName: params.resolved?.packageName ?? params.requestedName,
      marketplace: params.resolved?.marketplaceName ?? DIRECT_SOURCE_LABEL,
      type: params.packageType ?? 'plugin',
      outcome: params.outcome,
      durationMs: Date.now() - params.startTime,
      errorCode: params.errorCode,
      sourceType: derivePluginSourceType(params.resolved?.pluginSource),
    });
  }
}

/**
 * Derive the `sourceType` discriminator for telemetry from a resolved
 * discriminated-union `PluginSource`. Falls back to `github` when the
 * resolver surface hasn't been populated yet (direct-URL installs
 * routed through the legacy `gitUrl` path).
 */
function derivePluginSourceType(source: PluginSource | undefined): InstallEvent['sourceType'] {
  if (!source) return 'github';
  if (typeof source === 'string') return 'relative-path';
  return source.source;
}

/**
 * True when `target` is `dir` or inside it.
 *
 * @param dir - Absolute directory path.
 * @param target - Absolute path to test.
 */
function isInsideDir(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}
