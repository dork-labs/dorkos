/**
 * Plugin install flow.
 *
 * Owns the per-package logic for installing a `type: 'plugin'` package: copy
 * the package contents into a staging directory, compile every bundled
 * extension, then atomically activate the staging directory onto the install
 * root and enable each compiled extension. The cross-cutting transaction
 * lifecycle (staging dir creation, target backup, cleanup on failure) is
 * delegated to {@link runTransaction} from `../transaction`.
 *
 * @module services/marketplace/flows/install-plugin
 */
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionManifest, ExtensionRecord } from '@dorkos/extension-api';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import type { PluginPackageManifest } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { atomicMove } from '../lib/atomic-move.js';
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

/** Discovered extension within a staged plugin package. */
interface StagedExtension {
  id: string;
  path: string;
  manifest: ExtensionManifest;
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
   * tears the staging dir down before {@link activate} ever runs.
   */
  private async stage(stagingDir: string, packagePath: string): Promise<void> {
    await cp(packagePath, stagingDir, { recursive: true });
    const extensions = await discoverStagedExtensions(stagingDir);

    for (const ext of extensions) {
      const record = buildCompilerRecord(ext);
      const result = await this.deps.extensionCompiler.compile(record);
      if ('error' in result) {
        throw new Error(
          `[install-plugin] Extension '${ext.id}' failed to compile: ${result.error.message}`
        );
      }
      this.deps.logger.info(`[install-plugin] Compiled extension ${ext.id}`);
    }
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

/**
 * Walk `<root>/.dork/extensions/<id>/extension.json` and return every
 * extension found, with parsed manifests. Invalid manifests are skipped —
 * the package validator is responsible for surfacing schema errors before
 * this point.
 */
async function discoverStagedExtensions(root: string): Promise<StagedExtension[]> {
  const extRoot = path.join(root, '.dork', 'extensions');
  if (!(await exists(extRoot))) return [];

  const entries = await readdir(extRoot, { withFileTypes: true });
  const found: StagedExtension[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extDir = path.join(extRoot, entry.name);
    const manifestPath = path.join(extDir, 'extension.json');
    if (!(await exists(manifestPath))) continue;
    const parsed = await readExtensionManifest(manifestPath);
    if (parsed) {
      found.push({ id: entry.name, path: extDir, manifest: parsed });
    }
  }
  return found;
}

/**
 * List the bundled extension IDs under `<root>/.dork/extensions/` by directory
 * name, without parsing each `extension.json`. Used to capture the extension
 * set of an install so a reinstall can disable the ones the new version drops.
 * Unlike {@link discoverStagedExtensions}, this does not skip extensions whose
 * manifest fails to parse — a dangling extension must still be disabled even if
 * its manifest is malformed. Mirrors the directory walk in the uninstall flow's
 * `disableBundledExtensions`. Returns an empty array when `root` (a fresh
 * install) or its extensions directory does not exist.
 */
async function discoverExtensionIds(root: string): Promise<string[]> {
  const extRoot = path.join(root, '.dork', 'extensions');
  if (!(await exists(extRoot))) return [];
  const entries = await readdir(extRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Parse a single `extension.json` file. Returns `null` on any read or
 * validation failure so the caller can skip the extension instead of
 * failing the entire install on a malformed manifest.
 */
async function readExtensionManifest(manifestPath: string): Promise<ExtensionManifest | null> {
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = ExtensionManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Build the minimal {@link ExtensionRecord} the compiler needs. The record
 * is transient — it lives only for the duration of the compile call and is
 * never persisted.
 */
function buildCompilerRecord(ext: StagedExtension): ExtensionRecord {
  return {
    id: ext.id,
    manifest: ext.manifest,
    status: 'discovered',
    scope: 'global',
    origin: 'user',
    path: ext.path,
    bundleReady: false,
    hasServerEntry: false,
    hasDataProxy: ext.manifest.dataProxy !== undefined,
  };
}

/** Returns true if the supplied path exists on disk (file or directory). */
async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
