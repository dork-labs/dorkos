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
 * The steps live beside it: `staging.ts` (resolve, fetch, validate),
 * `install-dispatch.ts` (gates, flow dispatch, telemetry), `update.ts` (the
 * update round trip), `metadata.ts` (what an install records) and
 * `errors.ts`.
 *
 * All collaborators are injected — the installer performs no disk or
 * network I/O of its own, which keeps it trivially unit-testable.
 *
 * @module services/marketplace/installer/marketplace-installer
 */
import { isRealCommitSha, type MarketplacePackageManifest } from '@dorkos/marketplace';
import { validatePackage } from '@dorkos/marketplace/package-validator';
import type { Logger } from '@dorkos/shared/logger';
import type { PackageFetcher } from '../package-fetcher.js';
import type { PackageResolver } from '../package-resolver.js';
import type { PermissionPreviewBuilder } from '../preview/permission-preview.js';
import type { AdapterInstallFlow } from '../flows/install-adapter.js';
import type { AgentInstallFlow } from '../flows/install-agent.js';
import type { PluginInstallFlow } from '../flows/install-plugin.js';
import type { ShapeInstallFlow } from '../flows/install-shape.js';
import type { SkillPackInstallFlow } from '../flows/install-skill-pack.js';
import type { UninstallFlow } from '../flows/uninstall/uninstall.js';
import { locateInstallRoot } from '../lib/locate-install.js';
import {
  hostOf,
  resolvedFromSourceKey,
  matchesRecordedKey,
  sourceKeyOfFetchable,
} from '../lib/source-provenance.js';
import { withInstallTargetLock } from '../transaction.js';
import type {
  InstallRequest,
  InstallResult,
  LatestResolution,
  PermissionPreview,
  ResolveLatestOptions,
} from '../types.js';
import { InstallDispatcher } from './install-dispatch.js';
import { buildResolverInput, PackageStager } from './staging.js';
import { InstallUpdater } from './update.js';

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

/**
 * Top-level orchestrator for marketplace installs. One instance is
 * constructed per server runtime and shared across every install path
 * (CLI, HTTP routes, and — via {@link InstallerLike} — the update flow).
 */
export class MarketplaceInstaller implements InstallerLike {
  private readonly stager: PackageStager;
  private readonly dispatcher: InstallDispatcher;
  private readonly updater: InstallUpdater;

  constructor(private readonly deps: InstallerDeps) {
    this.stager = new PackageStager(deps);
    this.dispatcher = new InstallDispatcher(deps, this.stager);
    this.updater = new InstallUpdater(deps, this.stager, this.dispatcher);
  }

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
    const { manifest, packagePath } = await this.stager.resolveAndValidate(req);
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
    return this.dispatcher.installStaged(req);
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
    if (installRoot === null) return this.updater.applyUpdate(req, resolved);
    return withInstallTargetLock(installRoot, () => this.updater.applyUpdate(req, resolved));
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
          ? sourceKeyOfFetchable(this.stager.buildFetchableSource(resolved))
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

      const staged = await this.stager.stagePackage(resolved, req);
      const validation = await validatePackage(staged.path, {
        localSource: resolved.kind === 'local',
      });
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
}
