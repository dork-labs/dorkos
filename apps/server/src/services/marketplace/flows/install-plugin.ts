/**
 * Plugin install flow.
 *
 * Owns the per-package logic for installing a `type: 'plugin'` package: copy
 * the package contents into a staging directory, compile every bundled
 * extension, then atomically activate the staging directory onto the install
 * root and enable each compiled extension. The cross-cutting transaction
 * lifecycle (staging dir creation, target backup, cleanup on failure) is
 * delegated to {@link runTransaction} from `../transaction`. The shared
 * discover + compile machinery lives in `../lib/staged-extensions`.
 *
 * @module services/marketplace/flows/install-plugin
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { PluginPackageManifest } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { atomicMove } from '../lib/atomic-move.js';
import { stagePackageContents } from '../lib/stage-package.js';
import {
  compileStagedExtensions,
  discoverExtensionIds,
  discoverStagedExtensions,
} from '../lib/staged-extensions.js';
import { runTransaction } from '../transaction.js';
import type { InstallRequest, InstallResult } from '../types.js';

/**
 * Structural interface for the extension compiler dependency. Mirrors the
 * shape of {@link ../../extensions/extension-compiler.ExtensionCompiler}'s
 * `compile` method but is declared locally so the flow can be exercised
 * with lightweight test doubles.
 */
export interface ExtensionCompilerLike {
  compile(
    record: ExtensionRecord
  ): Promise<
    | { code: string; sourceHash: string }
    | { error: { code: string; message: string }; sourceHash: string }
  >;
}

/**
 * Structural interface for the extension manager dependency. Mirrors the
 * `enable`/`disable` methods the install flow needs: `enable` activates the
 * freshly-staged package's extensions, and `disable` retires extensions a
 * reinstalled version dropped (see {@link PluginInstallFlow.install}).
 */
export interface ExtensionManagerLike {
  enable(id: string): Promise<unknown>;
  disable(id: string): Promise<unknown>;
}

/** Constructor dependencies for {@link PluginInstallFlow}. */
export interface PluginFlowDeps {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /** Compiler used to bundle each `.dork/extensions/<id>` directory. */
  extensionCompiler: ExtensionCompilerLike;
  /** Manager used to enable each compiled extension after activation. */
  extensionManager: ExtensionManagerLike;
  /** Logger for diagnostic output. */
  logger: Logger;
}

/**
 * Plugin install orchestrator.
 *
 * One instance is constructed per server runtime and shared across all
 * plugin installs. Every {@link install} call runs through {@link runTransaction}
 * so that staging directories are always cleaned up and, on a reinstall, the
 * previous installation at the target is restored if activation fails.
 *
 * On a reinstall (the install target already exists), any extension the
 * previous version bundled but the new version dropped is disabled after the
 * new set activates, so no extension is left enabled pointing at a bundle that
 * is no longer on disk.
 */
export class PluginInstallFlow {
  constructor(private readonly deps: PluginFlowDeps) {}

  /**
   * Install a plugin package that has already been validated and downloaded.
   *
   * On a reinstall (`installRoot` already exists), the previous install's
   * bundled extension IDs are captured before the transaction moves the old
   * target aside. After the new set activates and enables successfully, any
   * extension the new version dropped is disabled — otherwise it would stay
   * registered against a bundle that is no longer on disk (a dangling
   * extension). The disable runs only on the success path, so a rolled-back
   * activation leaves the restored prior install's extensions untouched.
   *
   * @param packagePath - Absolute path to the staged package source directory.
   * @param manifest - Validated plugin manifest read from the package.
   * @param opts - Install request options (currently only `projectPath`).
   * @returns The full {@link InstallResult} reporting where the package landed.
   */
  async install(
    packagePath: string,
    manifest: PluginPackageManifest,
    opts: Pick<InstallRequest, 'projectPath'>
  ): Promise<InstallResult> {
    const installRoot = computeInstallRoot(this.deps.dorkHome, manifest, opts.projectPath);

    // Capture the prior install's bundled extension IDs BEFORE the transaction
    // moves the existing target aside. Empty for a fresh install.
    const priorExtensionIds = await discoverExtensionIds(installRoot);

    const result = await runTransaction<InstallResult>({
      name: `install-plugin-${manifest.name}`,
      target: installRoot,
      stage: (staging) => this.stage(staging.path, packagePath),
      activate: (staging) => this.activate(staging.path, installRoot, manifest),
    });

    // Success path only: retire extensions the reinstalled version dropped.
    // Runs after activation so a rolled-back install never disables the
    // restored prior install's extensions.
    await this.disableDroppedExtensions(priorExtensionIds, installRoot);

    return result;
  }

  /**
   * Disable every extension the previous install bundled that the newly
   * activated install no longer ships. Extensions that persist across the
   * reinstall are left alone — {@link activate} has already re-enabled and
   * recompiled them against the new bundle. Each `disable` is best-effort:
   * a failure is logged but does not fail the completed install.
   */
  private async disableDroppedExtensions(
    priorExtensionIds: string[],
    installRoot: string
  ): Promise<void> {
    if (priorExtensionIds.length === 0) return;
    // This runs AFTER the transaction has already committed the new package, so a
    // failure here must never bubble out of `install()` — the update path
    // (marketplace-installer) treats any rejection as "the install failed" and
    // would report failure for a reinstall that actually succeeded. Everything
    // below is best-effort: log and continue, so one failing teardown neither
    // fails the completed install nor skips the remaining dropped extensions.
    let currentExtensionIds: Set<string>;
    try {
      currentExtensionIds = new Set(await discoverExtensionIds(installRoot));
    } catch (err) {
      this.deps.logger.warn(
        `[install-plugin] Could not read the reinstalled extensions to compute the dropped set; skipping extension cleanup: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    for (const id of priorExtensionIds) {
      if (currentExtensionIds.has(id)) continue;
      try {
        await this.deps.extensionManager.disable(id);
        this.deps.logger.info(`[install-plugin] Disabled dropped extension ${id}`);
      } catch (err) {
        this.deps.logger.warn(
          `[install-plugin] Failed to disable dropped extension ${id} (install already succeeded): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /**
   * Copy the package into the staging directory and compile every bundled
   * extension. Throws on any compile error so the transaction wrapper
   * tears the staging dir down before {@link activate} ever runs. The copy
   * strips symlinks ({@link stagePackageContents}) so a malicious package
   * cannot smuggle a link that escapes the install root (DOR-279).
   */
  private async stage(stagingDir: string, packagePath: string): Promise<void> {
    await stagePackageContents(packagePath, stagingDir, this.deps.logger);
    await compileStagedExtensions(
      stagingDir,
      this.deps.extensionCompiler,
      this.deps.logger,
      '[install-plugin]'
    );
  }

  /**
   * Atomically move the staging directory onto the install root, then enable
   * every bundled extension. The atomic move falls back to copy + remove on
   * `EXDEV` (cross-filesystem rename) so installs work when `os.tmpdir()`
   * lives on a different volume than `dorkHome`.
   */
  private async activate(
    stagingDir: string,
    installRoot: string,
    manifest: PluginPackageManifest
  ): Promise<InstallResult> {
    await mkdir(path.dirname(installRoot), { recursive: true });
    await atomicMove(stagingDir, installRoot);

    const extensions = await discoverStagedExtensions(installRoot);
    for (const ext of extensions) {
      await this.deps.extensionManager.enable(ext.id);
      this.deps.logger.info(`[install-plugin] Enabled extension ${ext.id}`);
    }

    return {
      ok: true,
      packageName: manifest.name,
      version: manifest.version,
      type: 'plugin',
      installPath: installRoot,
      manifest,
      warnings: [],
    };
  }
}

/**
 * Compute the on-disk install root for a plugin. Project-local installs land
 * under `<projectPath>/.dork/plugins/<name>`; global installs under
 * `<dorkHome>/plugins/<name>`.
 */
function computeInstallRoot(
  dorkHome: string,
  manifest: PluginPackageManifest,
  projectPath: string | undefined
): string {
  if (projectPath) {
    return path.join(projectPath, '.dork', 'plugins', manifest.name);
  }
  return path.join(dorkHome, 'plugins', manifest.name);
}
