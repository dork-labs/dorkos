/**
 * Marketplace installer orchestrator.
 *
 * The single entry point for every marketplace install path — CLI,
 * HTTP, and the update flow, whose checks call `resolveLatest` and whose
 * applies call `update`. Ties together the resolver,
 * fetcher, validator, permission preview builder, conflict detector, and
 * the four type-specific install flows. Emits exactly one telemetry event
 * per terminal state via {@link reportInstallEvent}.
 *
 * ```
 * MarketplaceInstaller
 *   1. Resolve package source (marketplace name → git URL)
 *   2. Cache check / clone via template-downloader
 *   3. Validate package via @dorkos/marketplace/package-validator
 *   4. Build PermissionPreview
 *   5. Confirm with user (CLI) / return preview (HTTP)
 *   6. Stage installation via the type-specific flow
 *   7. Detect conflicts
 *   8. Activate (atomic rename, register, notify)
 *   9. Cleanup or rollback
 * ```
 *
 * All collaborators are injected — the installer performs no disk or
 * network I/O of its own, which keeps it trivially unit-testable.
 *
 * @module services/marketplace/marketplace-installer
 */
import {
  isRealCommitSha,
  isSafeGitUrl,
  resolvePackageVersion,
  type MarketplacePackageManifest,
  type PackageType,
  type PluginSource,
  type SourceKey,
} from '@dorkos/marketplace';
import { validatePackage } from '@dorkos/marketplace/package-validator';
import type { Logger } from '@dorkos/shared/logger';
import { fileUrlToPath, type PackageFetcher } from './package-fetcher.js';
import type { PackageResolver, ResolvedPackageSource } from './package-resolver.js';
import type { RecordSource } from './lib/installed-files.js';
import { rebuildInstalledFiles } from './lib/legacy-record.js';
import type { PermissionPreviewBuilder } from './permission-preview.js';
import type { AdapterInstallFlow } from './flows/install-adapter.js';
import type { AgentInstallFlow } from './flows/install-agent.js';
import type { PluginInstallFlow } from './flows/install-plugin.js';
import type { ShapeInstallFlow } from './flows/install-shape.js';
import { skillFileProblems, type SkillPackInstallFlow } from './flows/install-skill-pack.js';
import type { UninstallFlow } from './flows/uninstall.js';
import { reportInstallEvent, type InstallEvent } from './telemetry-hook.js';
import { writeInstallMetadata } from './installed-metadata.js';
import { assertShipsNoRuntimeState, packageContentHash } from './lib/content-hash.js';
import { locateInstallRoot } from './lib/locate-install.js';
import {
  deriveSourceProvenance,
  hostOf,
  resolvedFromSourceKey,
  matchesRecordedKey,
  sourceKeyOfFetchable,
} from './lib/source-provenance.js';
import { materializePackageSchedules } from './lib/materialize-schedules.js';
import { withInstallTargetLock } from './transaction.js';
import { recordProjectInstall } from './lib/project-install-index.js';
import { validatePackageSchedules } from './lib/validate-package-schedules.js';
import {
  describeDisclosedEffects,
  disclosedEffectsOf,
  sameDisclosedEffects,
} from './disclosed-effects.js';
import { UnsupportedSourceUrlError } from './source-url-policy.js';
import type {
  ConflictReport,
  InstallRequest,
  InstallResult,
  LatestResolution,
  PermissionPreview,
  ResolveLatestOptions,
} from './types.js';
import path from 'node:path';

/** Sentinel marketplace value used when a package was resolved directly (git URL / local path). */
const DIRECT_SOURCE_LABEL = '<direct>';

/**
 * Thrown when `@dorkos/marketplace/package-validator` reports one or more
 * error-level issues for the staged package. The full list of error
 * messages is preserved on {@link InvalidPackageError.errors} so HTTP
 * routes can surface them verbatim.
 */
export class InvalidPackageError extends Error {
  /**
   * Build an `InvalidPackageError` from a list of validator error messages.
   *
   * @param errors - Human-readable validation error messages.
   */
  constructor(public readonly errors: string[]) {
    super(`Package failed validation:\n${errors.join('\n')}`);
    this.name = 'InvalidPackageError';
  }
}

/**
 * Thrown when the permission preview contains one or more error-level
 * conflicts and the caller did not pass `force: true`. The full conflict
 * list (including warnings) is preserved on {@link ConflictError.conflicts}.
 */
export class ConflictError extends Error {
  /**
   * Build a `ConflictError` from the full conflict list produced by the
   * permission preview builder.
   *
   * @param conflicts - Every conflict the detector reported, including warnings.
   */
  constructor(public readonly conflicts: ConflictReport[]) {
    const errorLines = conflicts
      .filter((c) => c.level === 'error')
      .map((c) => `  - ${c.description}`)
      .join('\n');
    super(`Install blocked by conflicts:\n${errorLines}`);
    this.name = 'ConflictError';
  }
}

/**
 * Thrown when the package resolved for the INSTALL declares different executable
 * content than the one a person approved (DOR-647).
 *
 * The approval binding closes the window between the card and the retry. This
 * closes the one after it: `install()` resolves and stages the package a second
 * time, so a source that served A while the card was being read can serve B while
 * the install runs, and everything up to this point would still be consistent.
 * The comparison costs nothing — `install()` already builds a preview here for the
 * conflict gate — and it is the last point at which refusing still means nothing
 * has been written.
 *
 * Distinct from {@link ConflictError} and {@link InvalidPackageError} because it
 * is neither: the package is valid and uncontested, it is simply not the one that
 * was agreed to.
 */
export class DisclosureChangedError extends Error {
  /**
   * Build the error from what the person approved and what arrived instead.
   *
   * @param approved - Plain-language description of the disclosed effects the
   *   approval was bound to.
   * @param resolved - The same description for the package that just resolved.
   */
  constructor(
    public readonly approved: string,
    public readonly resolved: string
  ) {
    super(
      `This package is not the one that was approved. The approval covered ${approved}; the ` +
        `copy that resolved just now declares ${resolved}. Nothing was installed. Ask again to ` +
        `see what it declares now.`
    );
    this.name = 'DisclosureChangedError';
  }
}

/**
 * Active-Shape hooks the installer's {@link MarketplaceInstaller.update} path
 * uses so updating the currently-applied Shape survives the uninstall →
 * reinstall round trip: the pointer is read before the uninstall (which runs
 * with Shape deactivation suppressed — an update is a replace, not a removal)
 * and the Shape is re-applied after the fresh version lands so its extensions,
 * schedules, and chrome reflect the new manifest. Optional: Shape-unaware
 * callers (and most tests) omit it, in which case an active-Shape update
 * leaves the pointer intact but skips the re-apply.
 */
export interface ShapeUpdateHooks {
  /** The currently-active Shape name (`ui.shapes.active`), or `null`. */
  getActiveShapeName(): string | null;
  /**
   * Re-apply an installed Shape (the same idempotent `applyShape` service the
   * `POST /api/shapes/:name/apply` route runs). The result is not surfaced to
   * the update caller; failures are logged, never thrown.
   *
   * @param name - The installed Shape name to re-apply.
   */
  reapplyShape(name: string): Promise<unknown>;
}

/**
 * Constructor dependencies for {@link MarketplaceInstaller}. Every
 * collaborator is injected so the orchestrator is fully testable without
 * touching disk, the network, or the transaction engine.
 */
export interface InstallerDeps {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /** Resolves user-supplied identifiers into concrete package sources. */
  resolver: PackageResolver;
  /** Fetches git-backed packages into the content-addressable cache. */
  fetcher: PackageFetcher;
  /** Builds the {@link PermissionPreview} shown to the user before install. */
  previewBuilder: PermissionPreviewBuilder;
  /** Flow for `type: 'plugin'` packages. */
  pluginFlow: PluginInstallFlow;
  /** Flow for `type: 'agent'` packages. */
  agentFlow: AgentInstallFlow;
  /** Flow for `type: 'skill-pack'` packages. */
  skillPackFlow: SkillPackInstallFlow;
  /** Flow for `type: 'adapter'` packages. */
  adapterFlow: AdapterInstallFlow;
  /** Flow for `type: 'shape'` packages. */
  shapeFlow: ShapeInstallFlow;
  /** Flow for uninstalling packages — wired here for HTTP route symmetry. */
  uninstallFlow: UninstallFlow;
  /** Active-Shape hooks for the update path; omit in Shape-unaware contexts. */
  shapeUpdateHooks?: ShapeUpdateHooks;
  /** Structured logger for diagnostic output. */
  logger: Logger;
}

/**
 * The public surface exposed to anything that needs to invoke installs via
 * the orchestrator — forward-declared here so the update flow (spec task
 * 4.6) can depend on just the interface without creating a circular import
 * on the concrete {@link MarketplaceInstaller} class.
 */
export interface InstallerLike {
  preview(req: InstallRequest): Promise<PreviewResult>;
  install(req: InstallRequest): Promise<InstallResult>;
  update(req: InstallRequest): Promise<InstallResult>;
  resolveLatest(req: InstallRequest, opts: ResolveLatestOptions): Promise<LatestResolution>;
}

/** The tuple returned by {@link MarketplaceInstaller.preview}. */
export interface PreviewResult {
  preview: PermissionPreview;
  manifest: MarketplacePackageManifest;
  packagePath: string;
}

/** A resolved package, staged on disk and validated, ready to install. @internal */
interface StagedPackage {
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

/**
 * Top-level orchestrator for marketplace installs. One instance is
 * constructed per server runtime and shared across every install path
 * (CLI, HTTP routes, and — via {@link InstallerLike} — the update flow).
 */
export class MarketplaceInstaller implements InstallerLike {
  constructor(private readonly deps: InstallerDeps) {}

  /**
   * Build a {@link PermissionPreview} for a package without installing it.
   *
   * Exposed as a separate method so the HTTP `POST /api/marketplace/
   * packages/:name/preview` endpoint and the CLI confirmation prompt share
   * the exact same resolve → fetch → validate → preview pipeline that
   * {@link install} uses.
   *
   * @param req - The install request to preview (never dispatched to a flow).
   * @returns The permission preview, the parsed manifest, and the staged package path.
   * @throws {InvalidPackageError} If the staged package fails validation.
   */
  async preview(req: InstallRequest): Promise<PreviewResult> {
    const { manifest, packagePath } = await this.resolveAndValidate(req);
    const preview = await this.deps.previewBuilder.build(packagePath, manifest, {
      projectPath: req.projectPath,
    });
    return { preview, manifest, packagePath };
  }

  /**
   * Install a marketplace package, dispatching to the type-specific flow.
   *
   * Emits exactly one {@link reportInstallEvent} call per terminal state
   * (success, validation failure, conflict gate, or flow failure). The
   * telemetry hook swallows reporter errors, so it is safe to `await` it
   * in the error path without masking the original throw.
   *
   * @param req - The resolved install request.
   * @returns The populated {@link InstallResult} from the chosen flow.
   * @throws {InvalidPackageError} When validation fails.
   * @throws {ConflictError} When error-level conflicts are present and `req.force` is false.
   */
  async install(req: InstallRequest): Promise<InstallResult> {
    return this.installStaged(req);
  }

  /**
   * {@link install}, optionally from a package an update already resolved,
   * staged and checked, so the install writes exactly what was checked instead
   * of resolving a second time (DOR-2195).
   *
   * @param req - The install request.
   * @param prestaged - The update's own resolve and stage, when there is one.
   * @returns The populated {@link InstallResult}.
   * @internal
   */
  private async installStaged(
    req: InstallRequest,
    prestaged?: StagedPackage
  ): Promise<InstallResult> {
    const startTime = Date.now();
    let resolved: ResolvedPackageSource | null = null;
    let packageType: PackageType | null = null;

    try {
      const staged = prestaged ?? (await this.resolveAndValidate(req));
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
      // disk. See `lib/materialize-schedules.ts`.
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
        try {
          await recordProjectInstall(this.deps.dorkHome, {
            projectPath: req.projectPath,
            installRoot: result.installPath,
            name: result.packageName,
            ...(staged.commitSha !== undefined && { commitSha: staged.commitSha }),
            ...(staged.sourceKey !== undefined && { subpath: staged.sourceKey.subpath }),
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
   * Update an installed package: uninstall it as the first half of a replace,
   * then install the new version (ADR-0233, amended by ADR 260923-163513).
   *
   * The uninstall half runs the package's teardown (its extensions turned off
   * and their run approvals forgotten, DOR-516; its adapter entry; its
   * generated schedules) and moves only the package's own files out, in
   * place. The install half's transaction then carries every file the person
   * or their agent added or changed into the new version, and reports what it
   * did with any shipped file the person had edited.
   *
   * Resolves the request through the same {@link PackageResolver} the
   * install path uses so the uninstall lookup keys off the canonical
   * package name (the manifest's `name` field), not whatever raw
   * identifier the caller passed in. This lets `update()` accept the
   * same input shapes as `install()` — bare names, marketplace
   * shortcuts, github shorthand, and local paths — without putting
   * format-parsing logic in two places.
   *
   * The whole round trip runs inside one {@link withInstallTargetLock} on the
   * install root (DOR-1722). Both halves take that lock for themselves — it is
   * re-entrant within an async context, so they run inline under this hold —
   * and holding it across them is what closes the gap between them: an install
   * that landed there used to be deleted, without a backup and without an
   * error, by the by-hand removal of the data-only install root in step 3.
   * Locating the root is the one step outside the lock, because the path to
   * lock is not known until it has run; the residue is the same narrow, loud
   * one the uninstall flow documents (a package removed between the probe and
   * the lock is reported as not installed rather than destroying anything).
   *
   * @param req - The install request to apply as an update.
   * @returns The {@link InstallResult} from the post-uninstall reinstall.
   */
  async update(req: InstallRequest): Promise<InstallResult> {
    // 1. Resolve so the uninstall lookup keys off the canonical package
    //    name, not whatever raw identifier the caller passed.
    const resolved = await this.deps.resolver.resolve(buildResolverInput(req));

    const installRoot = await locateInstallRoot({
      dorkHome: this.deps.dorkHome,
      name: resolved.packageName,
      projectPath: req.projectPath,
      installRoot: req.installRoot,
    });
    // Nothing of that name is installed: there is no target to serialise on,
    // and the uninstall half below raises the canonical
    // `PackageNotInstalledError` for the caller.
    if (installRoot === null) return this.applyUpdate(req, resolved);
    return withInstallTargetLock(installRoot, () => this.applyUpdate(req, resolved));
  }

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
  private async applyUpdate(
    req: InstallRequest,
    resolved: ResolvedPackageSource
  ): Promise<InstallResult> {
    // Capture whether this package is the currently-applied Shape BEFORE the
    // uninstall half runs, so the post-install re-apply below knows to fire.
    const wasActiveShape =
      this.deps.shapeUpdateHooks?.getActiveShapeName() === resolved.packageName;

    // Stage the new version BEFORE anything is removed, and install exactly
    // that one below (DOR-2195). A failed resolve or fetch now leaves the old
    // version in place, and nothing can land between the check and the install.
    const staged = await this.stageAndValidate(resolved, req);

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
    await this.deps.uninstallFlow.uninstall({
      name: resolved.packageName,
      purge: false,
      projectPath: req.projectPath,
      replacing: true,
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
    const installResult = await this.installStaged({ ...req, force: true }, staged);

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

  /**
   * Work out what installing a package right now would give, for the update
   * check, without installing anything.
   *
   * Reuses the install pipeline — resolve, stage into the SHA-keyed cache,
   * validate — so the answer is what an install would actually get, and adds
   * one short-circuit: when the source ({@link SourceKey}), the marketplace
   * entry's version and the source's current commit all equal what the install
   * recorded, the package is `unchanged` and nothing is staged or cloned. All
   * three are needed: an entry can be re-pointed or re-versioned in the index
   * while the package's own repository does not move. A sidecar with no
   * recorded key never short-circuits.
   *
   * A staged tree that fails validation (including `VERSION_MISMATCH`) is
   * `unresolved`: a version DorkOS would refuse to install is never offered.
   * A `file://` source has no key and no commit, so it is always staged in
   * place and validated, which costs nothing remote.
   *
   * Never throws. Any resolver, fetch or staging error — a refused address
   * included (DOR-1799) — becomes `unresolved` with its message, so one bad
   * package cannot sink a check of many. Runs no package code: stage and
   * validate only, exactly as {@link preview} does.
   *
   * @param req - `marketplace` names the source the update flow matched; a
   *   direct install passes `source` instead.
   * @param opts - What the install recorded, and how to look up a commit.
   * @returns What an install would resolve to now.
   */
  async resolveLatest(req: InstallRequest, opts: ResolveLatestOptions): Promise<LatestResolution> {
    try {
      const recordedKey = opts.installed.sourceKey;
      const resolved =
        req.source && !req.marketplace && recordedKey
          ? resolvedFromSourceKey(req.name, recordedKey)
          : await this.deps.resolver.resolve(buildResolverInput(req));

      const key =
        resolved.kind !== 'local' && resolved.pluginSource !== undefined
          ? sourceKeyOfFetchable(this.buildFetchableSource(resolved))
          : undefined;

      if (
        key &&
        recordedKey &&
        matchesRecordedKey(key, recordedKey) &&
        resolved.entryVersion === opts.installed.entryVersion &&
        isRealCommitSha(opts.installed.commitSha)
      ) {
        const current = await opts.commitLookup(key.cloneUrl, key.ref);
        if (!isRealCommitSha(current)) {
          return { kind: 'unresolved', reason: `couldn't reach ${hostOf(key.cloneUrl)}` };
        }
        if (current === opts.installed.commitSha) return { kind: 'unchanged' };
      }

      const staged = await this.stagePackage(resolved, req);
      const validation = await validatePackage(staged.path);
      if (!validation.ok) {
        const errors = validation.issues.filter((i) => i.level === 'error').map((i) => i.message);
        return {
          kind: 'unresolved',
          reason: `the new version can't be installed: ${errors.join('; ')}`,
        };
      }
      return {
        kind: 'resolved',
        declaredVersion: validation.declaredVersion,
        entryVersion: resolved.entryVersion,
        // Staging's commit, not the lookup's: a push that lands between the
        // two is reported as what an install would actually fetch.
        commitSha: staged.commitSha,
        sourceKey: staged.sourceKey,
      };
    } catch (err) {
      return { kind: 'unresolved', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Run the resolve → fetch → validate pipeline shared by {@link install}
   * and {@link preview}. Returns the resolved source descriptor, the
   * parsed manifest, the path to the staged package on disk, and what the
   * install records about where it came from.
   *
   * @internal
   */
  private async resolveAndValidate(req: InstallRequest): Promise<StagedPackage> {
    return this.stageAndValidate(await this.deps.resolver.resolve(buildResolverInput(req)), req);
  }

  /**
   * Stage an already-resolved package and validate it: the second half of
   * {@link resolveAndValidate}, for an update that resolved first.
   *
   * @internal
   */
  private async stageAndValidate(
    resolved: ResolvedPackageSource,
    req: InstallRequest
  ): Promise<StagedPackage> {
    const staged = await this.stagePackage(resolved, req);

    const validation = await validatePackage(staged.path);
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
  private async stagePackage(
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
  private buildFetchableSource(resolved: ResolvedPackageSource): PluginSource {
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
 * Convert an {@link InstallRequest} into the single-string input shape
 * accepted by {@link PackageResolver.resolve}. Precedence:
 *
 * 1. `req.source` (explicit git URL or local path) → `${name}@${source}`.
 * 2. `req.marketplace` (configured marketplace name) → `${name}@${marketplace}`.
 * 3. Bare `req.name` → resolver searches every enabled marketplace.
 *
 * @internal
 */
function buildResolverInput(req: InstallRequest): string {
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
 * True when `target` is `dir` or inside it.
 *
 * @param dir - Absolute directory path.
 * @param target - Absolute path to test.
 */
function isInsideDir(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
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
async function assertInstallable(staged: StagedPackage): Promise<void> {
  const problems = await validatePackageSchedules(staged.packagePath, staged.manifest);
  if (staged.manifest.type === 'skill-pack') {
    problems.push(...(await skillFileProblems(staged.packagePath)));
  }
  if (problems.length > 0) throw new InvalidPackageError(problems);
}

/**
 * Where an install came from, as the installed-files record keeps it
 * (DOR-2245): the fetched source key's clone URL, subpath and ref, or the
 * local directory a local install copied. Compared later with the ref ignored.
 *
 * @internal
 */
function recordSourceOf(
  sourceKey: SourceKey | undefined,
  resolved: ResolvedPackageSource
): RecordSource | undefined {
  if (sourceKey) {
    return { cloneUrl: sourceKey.cloneUrl, subpath: sourceKey.subpath, ref: sourceKey.ref };
  }
  if (resolved.localPath) return { localPath: path.resolve(resolved.localPath) };
  return undefined;
}

/**
 * A staged package's content hash for the install metadata, or nothing when
 * it cannot be hashed (DOR-2306).
 *
 * @param installPath - The staged package root, as it arrived.
 * @internal
 */
async function recordableContentHash(installPath: string): Promise<{ contentHash?: string }> {
  try {
    return { contentHash: await packageContentHash(installPath) };
  } catch {
    return {};
  }
}
