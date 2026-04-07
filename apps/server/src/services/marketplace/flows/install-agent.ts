/**
 * Agent template install flow.
 *
 * Owns the per-package logic for installing a `type: 'agent'` package: copy
 * the package contents (template files) into a staging directory, atomically
 * activate the staging directory onto the install root, then delegate to the
 * existing {@link createAgentWorkspace} pipeline to scaffold the agent's
 * `.dork/agent.json`, SOUL.md, and NOPE.md. Mesh registration is handled
 * implicitly by the mesh-core reconciler — this flow never registers
 * directly. The cross-cutting transaction lifecycle (staging dir creation,
 * git rollback branch, cleanup on failure) is delegated to
 * {@link runTransaction} from `../transaction`.
 *
 * @module services/marketplace/flows/install-agent
 */
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentPackageManifest } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import type { createAgentWorkspace } from '../../core/agent-creator.js';
import { atomicMove } from '../lib/atomic-move.js';
import { runTransaction } from '../transaction.js';
import type { InstallRequest, InstallResult } from '../types.js';

/**
 * Structural interface for the agent-creator dependency. Mirrors only the
 * `createAgentWorkspace` function the install flow needs so the flow can be
 * exercised with lightweight test doubles.
 */
export interface AgentCreatorLike {
  createAgentWorkspace: typeof createAgentWorkspace;
}

/** Constructor dependencies for {@link AgentInstallFlow}. */
export interface AgentFlowDeps {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /** Existing agent-creator service used to scaffold `.dork/agent.json`. */
  agentCreator: AgentCreatorLike;
  /** Logger for diagnostic output. */
  logger: Logger;
}

/**
 * Agent template install orchestrator.
 *
 * One instance is constructed per server runtime and shared across all
 * agent-template installs. Every {@link install} call runs through
 * {@link runTransaction} so that staging directories are always cleaned up
 * and a git rollback branch is created when the user is inside a working
 * tree.
 */
export class AgentInstallFlow {
  constructor(private readonly deps: AgentFlowDeps) {}

  /**
   * Install an agent template package that has already been validated and
   * downloaded.
   *
   * @param packagePath - Absolute path to the staged package source directory.
   * @param manifest - Validated agent manifest read from the package.
   * @param opts - Install request options. `opts.projectPath`, when set, is
   *   used directly as the target directory; otherwise the agent lands under
   *   `<dorkHome>/agents/<name>`.
   * @returns The full {@link InstallResult} reporting where the package landed.
   */
  async install(
    packagePath: string,
    manifest: AgentPackageManifest,
    opts: InstallRequest
  ): Promise<InstallResult> {
    const targetDir = computeTargetDir(this.deps.dorkHome, manifest, opts.projectPath);

    this.deps.logger.info('[marketplace/install-agent] starting', {
      name: manifest.name,
      targetDir,
    });

    const transactionResult = await runTransaction({
      name: `install-agent-${manifest.name}`,
      rollbackBranch: true,
      stage: (staging) => stageAgentPackage(packagePath, staging.path),
      activate: (staging) => this.activate(staging.path, targetDir, manifest),
    });

    this.deps.logger.info('[marketplace/install-agent] success', { name: manifest.name });

    return {
      ok: true,
      packageName: manifest.name,
      version: manifest.version,
      type: 'agent',
      installPath: transactionResult.installPath,
      manifest,
      rollbackBranch: transactionResult.rollbackBranch,
      warnings: [],
    };
  }

  /**
   * Move the staged package onto the target directory, then delegate to
   * {@link createAgentWorkspace} to scaffold `.dork/agent.json`, SOUL.md, and
   * NOPE.md inside the now-populated directory. The atomic move falls back
   * to copy + remove on `EXDEV` (cross-filesystem rename).
   *
   * @internal
   */
  private async activate(
    stagingDir: string,
    targetDir: string,
    manifest: AgentPackageManifest
  ): Promise<{ installPath: string }> {
    await activateAgentPackage(stagingDir, targetDir);

    // The package contents are already on disk, so the creator must skip its
    // mkdir / template-download pre-steps and only run the scaffold pipeline.
    // The `skipTemplateDownload` flag is honored by the agent-creator service
    // (see its JSDoc); the marketplace install pipeline is the only caller
    // that sets it.
    await this.deps.agentCreator.createAgentWorkspace({
      directory: targetDir,
      name: manifest.name,
      description: manifest.description,
      traits: manifest.agentDefaults?.traits,
      skipTemplateDownload: true,
    });

    return { installPath: targetDir };
  }
}

/**
 * Compute the on-disk target directory for an agent package. Project-local
 * installs use `opts.projectPath` directly (it is the full target dir, not
 * a parent); global installs land under `<dorkHome>/agents/<name>`.
 *
 * @internal
 */
function computeTargetDir(
  dorkHome: string,
  manifest: AgentPackageManifest,
  projectPath: string | undefined
): string {
  if (projectPath) return projectPath;
  return path.join(dorkHome, 'agents', manifest.name);
}

/**
 * Copy the package source into the staging directory. Wrapped in a helper
 * so the transaction's `stage` callback stays a single statement.
 *
 * @internal
 */
async function stageAgentPackage(packagePath: string, stagingPath: string): Promise<void> {
  await cp(packagePath, stagingPath, { recursive: true });
}

/**
 * Move the staged package onto the live target directory. Ensures the parent
 * directory exists first (so installs work on a fresh `dorkHome` that has
 * not yet had an `agents/` subdirectory created), then delegates the move
 * itself to {@link atomicMove}, which handles the cross-device (`EXDEV`)
 * fallback when `os.tmpdir()` and `dorkHome` live on different filesystems.
 *
 * @internal
 */
async function activateAgentPackage(stagingPath: string, targetDir: string): Promise<void> {
  await mkdir(path.dirname(targetDir), { recursive: true });
  await atomicMove(stagingPath, targetDir);
}
