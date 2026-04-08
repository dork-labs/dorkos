/**
 * Adapter package install flow.
 *
 * Copies an adapter package into `${dorkHome}/plugins/<name>` via the
 * shared {@link runTransaction} engine, then registers the adapter with
 * the running {@link AdapterManager} so the relay subsystem picks it up
 * without a server restart. Adapter config (`relay-adapters.json`)
 * mutation is reversible without git, so this flow uses
 * `rollbackBranch: false` and instead compensates by calling
 * `removeAdapter` if registration fails.
 *
 * @module services/marketplace/flows/install-adapter
 */
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AdapterPackageManifest } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import type { AdapterManager } from '../../relay/adapter-manager.js';
import { atomicMove } from '../lib/atomic-move.js';
import { runTransaction } from '../transaction.js';
import type { InstallRequest, InstallResult } from '../types.js';

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
   * @param packagePath - Validated package source directory on disk
   * @param manifest - Parsed and validated adapter manifest
   * @param _opts - Original install request (reserved for future use)
   * @returns The full {@link InstallResult} on success
   */
  async install(
    packagePath: string,
    manifest: AdapterPackageManifest,
    _opts: InstallRequest
  ): Promise<InstallResult> {
    const { dorkHome, adapterManager, logger } = this.deps;
    const installPath = path.join(dorkHome, 'plugins', manifest.name);

    logger.info('[marketplace/install-adapter] starting', {
      name: manifest.name,
      adapterType: manifest.adapterType,
      installPath,
    });

    const transactionResult = await runTransaction({
      name: `install-adapter:${manifest.name}`,
      rollbackBranch: false,
      stage: async (staging) => {
        await stageAdapterPackage(packagePath, staging.path);
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
      warnings: [`Configure secrets via dorkos relay-adapters set ${manifest.name}`],
    };
  }
}

/**
 * Copy the package source into the staging directory. Wrapped in a
 * helper so the transaction's `stage` callback stays a single statement.
 *
 * @internal
 */
async function stageAdapterPackage(packagePath: string, stagingPath: string): Promise<void> {
  await cp(packagePath, stagingPath, { recursive: true });
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
