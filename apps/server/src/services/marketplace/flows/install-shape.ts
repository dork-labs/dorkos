/**
 * Shape install flow.
 *
 * Owns the per-package logic for installing a `type: 'shape'` package — the
 * fifth marketplace package type (DOR-355). A Shape is a "place": it composes
 * existing extensions, agents, schedules, and chrome into an installable unit.
 *
 * Installing a Shape *stages* it; it does not *activate* it. Any extensions the
 * Shape bundles inline (under `.dork/extensions/<id>/`) are compiled exactly
 * like a plugin's, but they are **not enabled** here — turning extensions on is
 * a place decision that belongs to `applyShape` (spec §6.1), so a user can
 * install several Shapes and switch between them without their extensions all
 * coming on at once.
 *
 * The cross-cutting transaction lifecycle (staging dir creation, target backup,
 * cleanup on failure) is delegated to {@link runTransaction}; the shared
 * discover + compile machinery lives in `../lib/staged-extensions`.
 *
 * @module services/marketplace/flows/install-shape
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ShapePackageManifest } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { atomicMove } from '../lib/atomic-move.js';
import { installRootDirForType } from '../lib/install-roots.js';
import { stagePackageContents } from '../lib/stage-package.js';
import { compileStagedExtensions, type StagedExtensionCompiler } from '../lib/staged-extensions.js';
import { runTransaction } from '../transaction.js';
import type { InstallRequest, InstallResult } from '../types.js';

/**
 * Warning surfaced in {@link InstallResult.warnings} when an install request
 * for a Shape carries a `projectPath`. Shapes are global-only (see
 * {@link ShapeInstallFlow.install}), so the request still succeeds — this
 * only tells the caller their scope choice was not honored, instead of
 * silently discarding it (DOR-386).
 */
export const SHAPE_PROJECT_PATH_IGNORED_WARNING =
  'Shapes always install for every project, not just the one you specified. Your project choice was ignored.';

/** Constructor dependencies for {@link ShapeInstallFlow}. */
export interface ShapeFlowDeps {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /** Compiler used to bundle each inline `.dork/extensions/<id>` directory. */
  extensionCompiler: StagedExtensionCompiler;
  /** Logger for diagnostic output. */
  logger: Logger;
}

/**
 * Shape install orchestrator.
 *
 * One instance is constructed per server runtime and shared across all Shape
 * installs. Every {@link install} call runs through {@link runTransaction} so
 * that staging directories are always cleaned up and, on a reinstall, the
 * previous installation at the target is restored if activation fails.
 *
 * Unlike the plugin flow, activation performs no extension `enable` step —
 * bundled extensions land compiled-but-disabled and are only enabled when the
 * Shape is applied.
 */
export class ShapeInstallFlow {
  constructor(private readonly deps: ShapeFlowDeps) {}

  /**
   * Install a Shape package that has already been validated and downloaded.
   *
   * Shapes are global-only in v1 — there is no project-scoped Shape install
   * (a Shape rearranges the whole cockpit, which is a person-scoped concept),
   * so `opts.projectPath` never changes the install root. If the caller
   * supplied one anyway, the install still succeeds globally, but the
   * returned {@link InstallResult.warnings} carries
   * {@link SHAPE_PROJECT_PATH_IGNORED_WARNING} so the caller knows their
   * scope choice was ignored rather than silently dropped (DOR-386).
   *
   * @param packagePath - Absolute path to the staged package source directory.
   * @param manifest - Validated Shape manifest read from the package.
   * @param opts - Install request options; only `projectPath` is read, and
   *   only to decide whether to warn.
   * @returns The full {@link InstallResult} reporting where the Shape landed.
   */
  async install(
    packagePath: string,
    manifest: ShapePackageManifest,
    opts: Pick<InstallRequest, 'projectPath'>
  ): Promise<InstallResult> {
    const installRoot = path.join(
      this.deps.dorkHome,
      installRootDirForType(manifest.type),
      manifest.name
    );
    const warnings = opts.projectPath ? [SHAPE_PROJECT_PATH_IGNORED_WARNING] : [];

    return runTransaction<InstallResult>({
      name: `install-shape-${manifest.name}`,
      target: installRoot,
      stage: (staging) => this.stage(staging.path, packagePath),
      activate: (staging) => this.activate(staging.path, installRoot, manifest, warnings),
    });
  }

  /**
   * Copy the package into the staging directory and compile every bundled
   * inline extension. Throws on any compile error so the transaction wrapper
   * tears the staging dir down before {@link activate} ever runs — a malformed
   * inline extension never lands on disk (a compile failure is recorded per
   * spec §7's "Bundled inline extension failed to compile" row at *apply* time,
   * but a hard compile throw here keeps a broken Shape off disk entirely). The
   * copy strips symlinks ({@link stagePackageContents}) so a malicious package
   * cannot smuggle a link that escapes the install root (DOR-279).
   */
  private async stage(stagingDir: string, packagePath: string): Promise<void> {
    await stagePackageContents(packagePath, stagingDir, this.deps.logger);
    await compileStagedExtensions(
      stagingDir,
      this.deps.extensionCompiler,
      this.deps.logger,
      '[install-shape]'
    );
  }

  /**
   * Atomically move the staging directory onto the install root. Deliberately
   * does NOT enable any bundled extension — activation of a Shape's extensions
   * is `applyShape`'s job, not the installer's (spec §6.1). The atomic move
   * falls back to copy + remove on `EXDEV` (cross-filesystem rename) so installs
   * work when `os.tmpdir()` lives on a different volume than `dorkHome`.
   */
  private async activate(
    stagingDir: string,
    installRoot: string,
    manifest: ShapePackageManifest,
    warnings: string[]
  ): Promise<InstallResult> {
    await mkdir(path.dirname(installRoot), { recursive: true });
    await atomicMove(stagingDir, installRoot);

    return {
      ok: true,
      packageName: manifest.name,
      version: manifest.version,
      type: 'shape',
      installPath: installRoot,
      manifest,
      warnings,
    };
  }
}
