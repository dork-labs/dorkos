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
 * target backup, cleanup on failure) is delegated to
 * {@link runTransaction} from `../transaction`.
 *
 * @module services/marketplace/flows/install-agent
 */
import { lstat, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_IDENTITY_FILES,
  UNINSTALLED_AGENT_PATH,
  type AgentPackageManifest,
} from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { isSingleEmoji } from '@dorkos/shared/agent-face';
import type { createAgentWorkspace } from '../../core/agent-creator.js';
import { atomicMove } from '../lib/atomic-move.js';
import { installRootDirForType } from '../lib/install-roots.js';
import { installStagedNpmDependencies } from '../lib/npm-dependencies.js';
import { stagePackageContents } from '../lib/stage-package.js';
import { flowOwnership } from '../lib/flow-ownership.js';
import { readInstalledFiles, sameSource } from '../lib/installed-files.js';
import { runTransaction } from '../transaction.js';
import type { InstallRequest, InstallResult } from '../types.js';
import type { UninstallAgentRegistry } from './uninstall.js';

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
  /**
   * The agent registry, read when the install runs (DOR-2245): an adopted
   * agent already on the team is not announced again, and an install lifts a
   * denial on its own folder. Absent when Mesh is off.
   */
  getMeshCore?: () => Parameters<typeof createAgentWorkspace>[1];
  /**
   * Takes an earlier, different package's agent off the team (the full
   * unregister cascade) before this one replaces it (DOR-2245). Absent when
   * Mesh is off.
   */
  agentRegistry?: Pick<UninstallAgentRegistry, 'unregisterAtPath'>;
  /** Logger for diagnostic output. */
  logger: Logger;
}

/**
 * Agent template install orchestrator.
 *
 * One instance is constructed per server runtime and shared across all
 * agent-template installs. Every {@link install} call runs through
 * {@link runTransaction} so that staging directories are always cleaned up
 * and, on a reinstall, the previous installation at the target is restored if
 * activation fails.
 */
export class AgentInstallFlow {
  constructor(private readonly deps: AgentFlowDeps) {}

  /**
   * Install an agent template package that has already been validated and
   * downloaded.
   *
   * @param packagePath - Absolute path to the staged package source directory.
   * @param manifest - Validated agent manifest read from the package.
   * @param opts - Install request options. With `opts.projectPath` set the agent
   *   lands under `<projectPath>/.dork/agents/<name>`; otherwise under
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

    // Filled during `stage` by the npm dependency step; read after the
    // transaction commits, so a rolled-back install reports nothing.
    const warnings: string[] = [];
    const { ownership, finish } = flowOwnership(manifest, opts);
    // Who installed what is here now, read before the transaction replaces it:
    // a different package that shares the name must not inherit this agent.
    const previousSource = (await readInstalledFiles(targetDir))?.package.source;
    const incomingSource = ownership.identity.source;
    const differentPackage =
      previousSource !== undefined &&
      incomingSource !== undefined &&
      !sameSource(previousSource, incomingSource);

    const transactionResult = await runTransaction({
      name: `install-agent-${manifest.name}`,
      target: targetDir,
      stage: (staging) =>
        stageAgentPackage(packagePath, staging.path, targetDir, warnings, this.deps.logger),
      activate: (staging) =>
        this.activate(staging.path, targetDir, manifest, differentPackage, warnings),
      ownership,
    });

    this.deps.logger.info('[marketplace/install-agent] success', { name: manifest.name });

    return finish({
      ok: true,
      packageName: manifest.name,
      version: manifest.version,
      type: 'agent',
      installPath: transactionResult.installPath,
      manifest,
      warnings: [...warnings],
      dependencyWarnings: [...warnings],
    });
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
    manifest: AgentPackageManifest,
    differentPackage: boolean,
    warnings: string[]
  ): Promise<{ installPath: string }> {
    await activateAgentPackage(stagingDir, targetDir);

    // A different package that happens to share this name never inherits the
    // earlier agent (DOR-2245): its identity files are set aside, and this one
    // starts fresh.
    // The earlier agent leaves the team first, with the full cascade: setting
    // its identity aside while it is still registered would swap the id under
    // its schedules, grants and room seats (DOR-1791 F1). Like an uninstall's,
    // the cascade is not undone if the install then rolls back.
    if (differentPackage) await this.deps.agentRegistry?.unregisterAtPath(targetDir);
    if (differentPackage && (await setAsideIdentityFiles(targetDir))) {
      warnings.push(
        `An earlier agent named ${manifest.name} came from a different source, so its files were set aside (.dork-old) and this one starts fresh.`
      );
    }

    // The package contents are already on disk, so the creator must skip its
    // mkdir / template-download pre-steps and only run the scaffold pipeline.
    // The `skipTemplateDownload` flag is honored by the agent-creator service
    // (see its JSDoc); the marketplace install pipeline is the only caller
    // that sets it.
    const created = await this.deps.agentCreator.createAgentWorkspace(
      {
        directory: targetDir,
        name: manifest.name,
        description: manifest.description,
        traits: manifest.agentDefaults?.traits,
        // The package author's own face, when they shipped one. The manifest's
        // `icon` is documented as "an emoji OR an icon identifier", so only an
        // emoji can be worn — anything else (`"package"`, a file name) is not a
        // face, and leaving the key off lets the creator seed one instead
        // (DOR-949).
        ...(manifest.icon && isSingleEmoji(manifest.icon) ? { icon: manifest.icon } : {}),
        skipTemplateDownload: true,
      },
      this.deps.getMeshCore?.(),
      // The agent's identity files are its own: adopt an existing agent.json,
      // write SOUL/NOPE/MEMORY only where absent (ADR 260923-163516).
      { marketplace: true }
    );
    if (created.defaultsDiffer) {
      warnings.push(
        "Kept this agent's own settings. The new version suggests different traits; change them in the agent's settings if you want them."
      );
    }
    if (created.denialLifted) {
      warnings.push("This agent's folder was blocked from your team; installing it lifted that.");
    }

    return { installPath: targetDir };
  }
}

/**
 * Compute the on-disk target directory for an agent package. Project-local
 * installs land under `<projectPath>/.dork/agents/<name>`; global installs under
 * `<dorkHome>/agents/<name>`.
 *
 * The project-local nesting mirrors `computeInstallRoot` in the plugin flow, and
 * it is a containment boundary, not a tidiness preference (DOR-522). This used to
 * return `projectPath` itself, which made the whole repository the install
 * target: a package's files unpacked straight into the project root, so anything
 * it shipped landed wherever its own layout said — including
 * `.dork/extensions/<id>/server.ts`, a path DorkOS discovers and, once approved,
 * runs inside its own process. It also pointed the transaction's backup-and-
 * restore at the entire project directory. Nesting closes both by construction.
 * `permission-preview.ts` has always shown this path, so the disclosure and the
 * behavior now agree.
 *
 * @internal
 */
function computeTargetDir(
  dorkHome: string,
  manifest: AgentPackageManifest,
  projectPath: string | undefined
): string {
  if (projectPath) {
    return path.join(projectPath, '.dork', installRootDirForType(manifest.type), manifest.name);
  }
  return path.join(dorkHome, installRootDirForType(manifest.type), manifest.name);
}

/**
 * Copy the package source into the staging directory, stripping symlinks so a
 * malicious package cannot smuggle a link that escapes the install root
 * (DOR-279), then install any npm dependencies it declares. The npm step runs
 * on the staged tree so its `node_modules` is activated by the same atomic move
 * as the package files (DOR-1341); it never throws, and appends any problem to
 * `warnings` instead. Wrapped in a helper so the transaction's `stage` callback
 * stays a single statement.
 *
 * @internal
 */
async function stageAgentPackage(
  packagePath: string,
  stagingPath: string,
  targetDir: string,
  warnings: string[],
  logger: Logger
): Promise<void> {
  await stagePackageContents(packagePath, stagingPath, logger);
  warnings.push(
    ...(await installStagedNpmDependencies({
      stagingDir: stagingPath,
      installPath: targetDir,
      logger,
    }))
  );
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

/**
 * Save an agent's identity files, and a parked uninstalled identity, under free
 * `.dork-old` names, so a different package sharing the name starts fresh
 * without deleting anything (DOR-2245).
 *
 * @param targetDir - The agent's folder.
 * @returns Whether anything was set aside.
 */
async function setAsideIdentityFiles(targetDir: string): Promise<boolean> {
  let moved = false;
  for (const rel of [...AGENT_IDENTITY_FILES, UNINSTALLED_AGENT_PATH]) {
    const abs = path.join(targetDir, ...rel.split('/'));
    if ((await lstat(abs).catch(() => undefined)) === undefined) continue;
    let saved = `${abs}.dork-old`;
    for (let n = 2; (await lstat(saved).catch(() => undefined)) !== undefined; n++) {
      saved = `${abs}.dork-old.${n}`;
    }
    await rename(abs, saved);
    moved = true;
  }
  return moved;
}
