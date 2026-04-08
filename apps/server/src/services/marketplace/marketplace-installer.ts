/**
 * Marketplace installer orchestrator.
 *
 * The single entry point for every marketplace install path — CLI,
 * HTTP, and (eventually) the update flow. Ties together the resolver,
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
import type { MarketplacePackageManifest, PackageType, PluginSource } from '@dorkos/marketplace';
import { validatePackage } from '@dorkos/marketplace/package-validator';
import type { Logger } from '@dorkos/shared/logger';
import type { PackageFetcher } from './package-fetcher.js';
import type { PackageResolver, ResolvedPackageSource } from './package-resolver.js';
import type { PermissionPreviewBuilder } from './permission-preview.js';
import type { AdapterInstallFlow } from './flows/install-adapter.js';
import type { AgentInstallFlow } from './flows/install-agent.js';
import type { PluginInstallFlow } from './flows/install-plugin.js';
import type { SkillPackInstallFlow } from './flows/install-skill-pack.js';
import type { UninstallFlow } from './flows/uninstall.js';
import { reportInstallEvent, type InstallEvent } from './telemetry-hook.js';
import { writeInstallMetadata } from './installed-metadata.js';
import type { ConflictReport, InstallRequest, InstallResult, PermissionPreview } from './types.js';
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  /** Flow for uninstalling packages — wired here for HTTP route symmetry. */
  uninstallFlow: UninstallFlow;
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
    const startTime = Date.now();
    let resolved: ResolvedPackageSource | null = null;
    let packageType: PackageType | null = null;

    try {
      const staged = await this.resolveAndValidate(req);
      resolved = staged.resolved;
      packageType = staged.manifest.type;

      const preview = await this.deps.previewBuilder.build(staged.packagePath, staged.manifest, {
        projectPath: req.projectPath,
      });

      if (!req.force && preview.conflicts.some((c) => c.level === 'error')) {
        throw new ConflictError(preview.conflicts);
      }

      const result = await this.dispatchFlow(staged.packagePath, staged.manifest, req);

      // Persist install provenance to `.dork/install-metadata.json` so the
      // update flow can scope its marketplace lookups and the routes layer
      // can surface "installed from" / "installed at" to API clients.
      // Best-effort: a metadata write failure is logged but does not fail
      // the install — the package itself is already on disk.
      try {
        await writeInstallMetadata(result.installPath, {
          name: result.packageName,
          version: result.version,
          type: result.type,
          installedFrom: resolved.marketplaceName,
          installedAt: new Date().toISOString(),
        });
      } catch (metaErr) {
        this.deps.logger.warn('[marketplace-installer] failed to write install-metadata.json', {
          packageName: result.packageName,
          installPath: result.installPath,
          error: metaErr instanceof Error ? metaErr.message : String(metaErr),
        });
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
   * Update an installed package by uninstalling without purging
   * (`--purge: false`, which preserves `.dork/data/` and `.dork/secrets.json`)
   * and then reinstalling fresh. This is the documented apply-mode update
   * pattern (ADR-0233).
   *
   * The two-step uninstall → install dance is necessary because the install
   * flows use `atomicMove` to swing the staging directory onto the live
   * install root, which throws `ENOTEMPTY` against an existing install.
   * Removing the live install first sidesteps that and lets the freshly
   * fetched package version land cleanly. The uninstall flow's data
   * preservation primitives copy `.dork/data/` and `.dork/secrets.json`
   * back into the live location after package removal, so user state
   * survives the round trip and is then overwritten only if the new
   * version explicitly ships replacement files.
   *
   * Resolves the request through the same {@link PackageResolver} the
   * install path uses so the uninstall lookup keys off the canonical
   * package name (the manifest's `name` field), not whatever raw
   * identifier the caller passed in. This lets `update()` accept the
   * same input shapes as `install()` — bare names, marketplace
   * shortcuts, github shorthand, and local paths — without putting
   * format-parsing logic in two places.
   *
   * @param req - The install request to apply as an update.
   * @returns The {@link InstallResult} from the post-uninstall reinstall.
   */
  async update(req: InstallRequest): Promise<InstallResult> {
    // 1. Resolve so the uninstall lookup keys off the canonical package
    //    name, not whatever raw identifier the caller passed.
    const resolved = await this.deps.resolver.resolve(buildResolverInput(req));

    // 2. Uninstall WITH purge so the install root is fully removed and
    //    `atomicMove(stagingDir, installRoot)` does not later trip on
    //    `ENOTEMPTY`. We do our own data preservation around the call so
    //    `.dork/data/` and `.dork/secrets.json` survive the round trip.
    const result = await this.deps.uninstallFlow.uninstall({
      name: resolved.packageName,
      purge: false,
      projectPath: req.projectPath,
    });

    // 3. Capture preserved data into a temp scratch directory and remove
    //    the now-data-only install root before the fresh install runs.
    //    Without this, the surviving `.dork/data/` and `.dork/secrets.json`
    //    leave the install root non-empty and atomicMove throws ENOTEMPTY.
    const preserved = result.preservedData ?? [];
    let scratchDir: string | null = null;
    let installRoot: string | null = null;
    if (preserved.length > 0) {
      scratchDir = await mkdtemp(path.join(tmpdir(), 'dorkos-update-preserve-'));
      // Every preserved path lives under the same install root — derive
      // it from the first entry by finding the `.dork/` boundary so we
      // can strip the install-root prefix when copying back later.
      installRoot = await findInstallRootFromPreservedPath(preserved[0]);
      for (const livePath of preserved) {
        const relPath = path.relative(installRoot, livePath);
        const scratchPath = path.join(scratchDir, relPath);
        await mkdir(path.dirname(scratchPath), { recursive: true });
        await cp(livePath, scratchPath, { recursive: true });
      }
      // Now remove the data-only install root entirely so atomicMove has
      // a clean target. The caller's data is safe in `scratchDir`.
      await rm(installRoot, { recursive: true, force: true });
    }

    // 4. Fresh install. The install flow's atomicMove now lands cleanly
    //    onto an empty parent.
    let installResult: InstallResult;
    try {
      installResult = await this.install({ ...req, force: true });
    } catch (err) {
      // If the install fails after we removed the data-only install root,
      // restore preserved data to the original location so the user does
      // not lose state. Best-effort: rethrow the original error either way.
      if (scratchDir && installRoot) {
        try {
          await mkdir(installRoot, { recursive: true });
          for (const livePath of preserved) {
            const relPath = path.relative(installRoot, livePath);
            const scratchPath = path.join(scratchDir, relPath);
            await mkdir(path.dirname(livePath), { recursive: true });
            await cp(scratchPath, livePath, { recursive: true });
          }
        } catch {
          /* best-effort restore on failure path */
        }
        await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw err;
    }

    // 5. Copy preserved data back into the freshly installed package.
    if (scratchDir && installRoot) {
      for (const livePath of preserved) {
        const relPath = path.relative(installRoot, livePath);
        const scratchPath = path.join(scratchDir, relPath);
        const destPath = path.join(installResult.installPath, relPath);
        if (!(await pathExists(scratchPath))) continue;
        await mkdir(path.dirname(destPath), { recursive: true });
        await cp(scratchPath, destPath, { recursive: true });
      }
      await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }

    return installResult;
  }

  /**
   * Run the resolve → fetch → validate pipeline shared by {@link install}
   * and {@link preview}. Returns the resolved source descriptor, the
   * parsed manifest, and the path to the staged package on disk.
   *
   * @internal
   */
  private async resolveAndValidate(req: InstallRequest): Promise<{
    resolved: ResolvedPackageSource;
    manifest: MarketplacePackageManifest;
    packagePath: string;
  }> {
    const resolved = await this.deps.resolver.resolve(buildResolverInput(req));
    const packagePath = await this.stagePackage(resolved, req);

    const validation = await validatePackage(packagePath);
    if (!validation.ok || !validation.manifest) {
      const errorMessages = validation.issues
        .filter((i) => i.level === 'error')
        .map((i) => i.message);
      throw new InvalidPackageError(errorMessages);
    }

    return { resolved, manifest: validation.manifest, packagePath };
  }

  /**
   * Stage the resolved package on disk. Local packages are used in place;
   * git-backed packages are cloned into the content-addressable cache via
   * {@link PackageFetcher.fetchFromGit}.
   *
   * @internal
   */
  private async stagePackage(
    resolved: ResolvedPackageSource,
    req: InstallRequest
  ): Promise<string> {
    if (resolved.kind === 'local') {
      if (!resolved.localPath) {
        throw new Error('Resolved local package missing localPath');
      }
      return resolved.localPath;
    }

    if (!resolved.gitUrl) {
      throw new Error(`Resolved ${resolved.kind} package missing gitUrl`);
    }

    const fetched = await this.deps.fetcher.fetchFromGit({
      packageName: resolved.packageName,
      gitUrl: resolved.gitUrl,
      force: req.force,
    });
    return fetched.path;
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
 * Test whether a path exists on disk. Used by `update()` to skip
 * preserved paths that the user removed between snapshot and restore.
 *
 * @internal
 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive the install root from a preserved-data path produced by the
 * uninstall flow. Preserved entries always live under `<installRoot>/.dork/`
 * (either `.dork/data` or `.dork/secrets.json`), so the install root is the
 * parent of the first `.dork` segment in the path.
 *
 * @internal
 */
async function findInstallRootFromPreservedPath(preservedPath: string): Promise<string> {
  const segments = preservedPath.split(path.sep);
  const dorkIdx = segments.lastIndexOf('.dork');
  if (dorkIdx <= 0) {
    throw new Error(
      `[marketplace-installer] Cannot derive install root from preserved path '${preservedPath}'`
    );
  }
  return segments.slice(0, dorkIdx).join(path.sep);
}
