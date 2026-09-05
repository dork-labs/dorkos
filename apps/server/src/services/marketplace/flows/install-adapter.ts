/**
 * Adapter package install flow.
 *
 * Copies an adapter package into `${dorkHome}/plugins/<name>` via the
 * shared {@link runTransaction} engine, then registers the adapter with
 * the running {@link AdapterManager} so the relay subsystem picks it up
 * without a server restart. The transaction restores the previous package
 * contents at the target if activation fails; the adapter config
 * (`relay-adapters.json`) mutation is compensated separately by calling
 * `removeAdapter` if registration fails.
 *
 * @module services/marketplace/flows/install-adapter
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AdapterPackageManifest } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import type { AdapterManager } from '../../relay/adapter-manager.js';
import { atomicMove } from '../lib/atomic-move.js';
import { installRootDirForType } from '../lib/install-roots.js';
import { installStagedNpmDependencies } from '../lib/npm-dependencies.js';
import { stagePackageContents } from '../lib/stage-package.js';
import { runTransaction } from '../transaction.js';
import type { InstallRequest, InstallResult } from '../types.js';

/**
 * Warning surfaced in {@link InstallResult.warnings} when an install request
 * for an adapter carries a `projectPath`. Adapters are global-only (see
 * {@link AdapterInstallFlow.install}), so the request still succeeds — this
 * only tells the caller their scope choice was not honored, instead of
 * silently discarding it (DOR-1776, mirroring DOR-386 for Shapes).
 */
export const ADAPTER_PROJECT_PATH_IGNORED_WARNING =
  'Adapters always install for every project, not just the one you specified. Your project choice was ignored.';

/** Dependencies for {@link AdapterInstallFlow}. */
export interface AdapterFlowDeps {
  /** Resolved DorkOS data directory (`~/.dork` in production). */
  dorkHome: string;
  /** Live adapter manager — receives the registration call on activate. */
  adapterManager: AdapterManager;
  /** Structured logger for lifecycle events. */
  logger: Logger;
}

/**
 * Install flow for adapter-typed marketplace packages.
 *
 * Each instance is bound to a single set of dependencies. Call
 * {@link AdapterInstallFlow.install} once per package — it is safe to
 * reuse the flow across many installs.
 */
export class AdapterInstallFlow {
  constructor(private readonly deps: AdapterFlowDeps) {}

  /**
   * Install an adapter package.
   *
   * Adapters are global-only — the relay's adapter registry
   * (`relay-adapters.json`) has no per-project dimension, and
   * {@link AdapterManager} is a single process-wide instance — so
   * `opts.projectPath` never changes the install root. If the caller supplied
   * one anyway, the install still succeeds globally, but the returned
   * {@link InstallResult.warnings} carries
   * {@link ADAPTER_PROJECT_PATH_IGNORED_WARNING} so the caller knows their
   * scope choice was ignored rather than silently dropped (DOR-1776).
   *
   * @param packagePath - Validated package source directory on disk
   * @param manifest - Parsed and validated adapter manifest
   * @param opts - Install request options; only `projectPath` is read, and only
   *   to decide whether to warn
   * @returns The full {@link InstallResult} on success
   */
  async install(
    packagePath: string,
    manifest: AdapterPackageManifest,
    opts: Pick<InstallRequest, 'projectPath'>
  ): Promise<InstallResult> {
    const { dorkHome, adapterManager, logger } = this.deps;
    const installPath = path.join(dorkHome, installRootDirForType(manifest.type), manifest.name);

    logger.info('[marketplace/install-adapter] starting', {
      name: manifest.name,
      adapterType: manifest.adapterType,
      installPath,
    });

    const scopeWarnings = opts.projectPath ? [ADAPTER_PROJECT_PATH_IGNORED_WARNING] : [];
    // Filled during `stage` by the npm dependency step; read after the
    // transaction commits, so a rolled-back install reports nothing.
    const dependencyWarnings: string[] = [];

    const transactionResult = await runTransaction({
      name: `install-adapter:${manifest.name}`,
      target: installPath,
      stage: async (staging) => {
        await stageAdapterPackage(packagePath, staging.path, logger);
        dependencyWarnings.push(
          ...(await installStagedNpmDependencies({
            stagingDir: staging.path,
            installPath,
            logger,
          }))
        );
      },
      activate: async (staging) => {
        await activateAdapterPackage(staging.path, installPath);
        await registerAdapterWithCompensation(adapterManager, manifest, installPath, logger);
        return { installPath };
      },
    });

    logger.info('[marketplace/install-adapter] success', { name: manifest.name });

    return {
      ok: true,
      packageName: manifest.name,
      version: manifest.version,
      type: 'adapter',
      installPath: transactionResult.installPath,
      manifest,
      warnings: [
        ...scopeWarnings,
        `Configure secrets via dorkos relay-adapters set ${manifest.name}`,
        ...dependencyWarnings,
      ],
      dependencyWarnings: [...dependencyWarnings],
    };
  }
}

/**
 * Copy the package source into the staging directory, stripping symlinks so a
 * malicious package cannot smuggle a link that escapes the install root
 * (DOR-279). Wrapped in a helper so the transaction's `stage` callback stays a
 * single statement.
 *
 * @internal
 */
async function stageAdapterPackage(
  packagePath: string,
  stagingPath: string,
  logger: Logger
): Promise<void> {
  await stagePackageContents(packagePath, stagingPath, logger);
}

/**
 * Move the staged package onto the live install path via
 * {@link atomicMove}, which handles the cross-device (`EXDEV`)
 * fallback when `os.tmpdir()` and `dorkHome` live on different
 * filesystems (common on Linux CI runners).
 *
 * @internal
 */
async function activateAdapterPackage(stagingPath: string, installPath: string): Promise<void> {
  await mkdir(path.dirname(installPath), { recursive: true });
  await atomicMove(stagingPath, installPath);
}

/**
 * Register the adapter with `AdapterManager`, compensating with
 * `removeAdapter` if registration throws. The transaction engine handles
 * removal of the staging directory; this helper is responsible for
 * undoing the effect of `addAdapter` (which mutates `relay-adapters.json`
 * before throwing).
 *
 * @internal
 */
async function registerAdapterWithCompensation(
  adapterManager: AdapterManager,
  manifest: AdapterPackageManifest,
  installPath: string,
  logger: Logger
): Promise<void> {
  try {
    await adapterManager.addAdapter(manifest.adapterType, manifest.name, {
      pluginPath: path.join(installPath, '.dork', 'adapters', manifest.adapterType),
    });
  } catch (err) {
    logger.warn('[marketplace/install-adapter] addAdapter failed, compensating', {
      name: manifest.name,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await adapterManager.removeAdapter(manifest.name);
    } catch (compensationErr) {
      logger.error('[marketplace/install-adapter] compensation removeAdapter failed', {
        name: manifest.name,
        error: compensationErr instanceof Error ? compensationErr.message : String(compensationErr),
      });
    }
    throw err;
  }
}
