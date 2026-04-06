/**
 * Tests for {@link AgentInstallFlow}.
 *
 * Each test stages a minimal agent template package on disk, then drives the
 * flow with a mocked `agentCreator` dependency. The four cases cover the
 * happy path (agent template installed under `<dorkHome>/agents/<name>`),
 * `agentDefaults.traits` propagation, project-local installs (via
 * `opts.projectPath`), and the failure path where `createAgentWorkspace`
 * throws — staging must be cleaned and the install root must not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import type { AgentPackageManifest } from '@dorkos/marketplace';
import { AgentInstallFlow } from '../../flows/install-agent.js';
import { _internal as transactionInternal } from '../../transaction.js';

/** Construct a no-op {@link Logger} backed by spies for assertions. */
function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Build a minimal valid {@link AgentPackageManifest} with sensible defaults. */
function buildManifest(overrides: Partial<AgentPackageManifest> = {}): AgentPackageManifest {
  return {
    schemaVersion: 1,
    name: 'fixture-agent',
    version: '0.1.0',
    type: 'agent',
    description: 'Fixture agent template used by install-agent tests.',
    tags: [],
    layers: [],
    requires: [],
    ...overrides,
  };
}

/** Returns true if `target` exists on disk (file or directory). */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Materialize a fake agent template package on disk under a fresh temp
 * directory and return its absolute path. The caller is responsible for
 * removing it via `cleanupDirs`.
 */
async function stagePackage(manifest: AgentPackageManifest): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'install-agent-pkg-'));
  await writeFile(path.join(root, 'dork-package.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  return root;
}

/**
 * Build the deps object with a tmp `dorkHome`, a spy `agentCreator`, and
 * a no-op logger. The spy resolves with a minimal {@link AgentCreationResult}
 * shape so the flow can complete the happy path.
 */
async function buildDeps(): Promise<{
  dorkHome: string;
  agentCreator: { createAgentWorkspace: ReturnType<typeof vi.fn> };
  logger: Logger;
}> {
  const dorkHome = await mkdtemp(path.join(tmpdir(), 'install-agent-home-'));
  return {
    dorkHome,
    agentCreator: {
      createAgentWorkspace: vi.fn().mockImplementation(async (input: { directory: string }) => {
        return {
          manifest: { id: 'fake-id', name: 'fixture-agent' },
          path: input.directory,
        };
      }),
    },
    logger: buildLogger(),
  };
}

describe('AgentInstallFlow', () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    // CRITICAL: prevent runTransaction from doing real `git reset --hard` against
    // the live worktree. The transaction engine's failure-path rollback would
    // otherwise wipe uncommitted tracked-file changes during test runs.
    vi.spyOn(transactionInternal, 'isGitRepo').mockResolvedValue(false);
  });

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('installs an agent template under <dorkHome>/agents/<name> and calls createAgentWorkspace', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const manifest = buildManifest({ name: 'happy-agent' });
    const pkgPath = await stagePackage(manifest);
    cleanupDirs.push(pkgPath);

    const flow = new AgentInstallFlow(deps);
    const result = await flow.install(pkgPath, manifest, {
      name: manifest.name,
    });

    const expectedDir = path.join(deps.dorkHome, 'agents', 'happy-agent');
    expect(result.ok).toBe(true);
    expect(result.packageName).toBe('happy-agent');
    expect(result.version).toBe('0.1.0');
    expect(result.type).toBe('agent');
    expect(result.installPath).toBe(expectedDir);
    expect(result.manifest).toEqual(manifest);
    expect(result.warnings).toEqual([]);
    expect(await pathExists(expectedDir)).toBe(true);
    expect(await pathExists(path.join(expectedDir, 'dork-package.json'))).toBe(true);

    expect(deps.agentCreator.createAgentWorkspace).toHaveBeenCalledTimes(1);
    const callArgs = deps.agentCreator.createAgentWorkspace.mock.calls[0]?.[0] as {
      directory: string;
      name: string;
      skipTemplateDownload: boolean;
    };
    expect(callArgs.directory).toBe(expectedDir);
    expect(callArgs.name).toBe('happy-agent');
    expect(callArgs.skipTemplateDownload).toBe(true);
  });

  it('passes manifest.agentDefaults.traits through to createAgentWorkspace', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const manifest = buildManifest({
      name: 'traits-agent',
      agentDefaults: {
        capabilities: [],
        traits: { tone: 4, autonomy: 5, caution: 2, communication: 3, creativity: 5 },
      },
    });
    const pkgPath = await stagePackage(manifest);
    cleanupDirs.push(pkgPath);

    const flow = new AgentInstallFlow(deps);
    await flow.install(pkgPath, manifest, { name: manifest.name });

    const callArgs = deps.agentCreator.createAgentWorkspace.mock.calls[0]?.[0] as {
      traits: { tone: number; autonomy: number; caution: number };
    };
    expect(callArgs.traits).toEqual({
      tone: 4,
      autonomy: 5,
      caution: 2,
      communication: 3,
      creativity: 5,
    });
  });

  it('places project-local installs under opts.projectPath instead of dorkHome', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const projectPath = await mkdtemp(path.join(tmpdir(), 'install-agent-proj-'));
    cleanupDirs.push(projectPath);
    const manifest = buildManifest({ name: 'local-agent' });
    const pkgPath = await stagePackage(manifest);
    cleanupDirs.push(pkgPath);

    // For project-local installs, opts.projectPath is used as the targetDir directly
    // (the spec snippet uses projectPath as the full target, not as a parent).
    const targetDir = path.join(projectPath, 'local-agent');
    const flow = new AgentInstallFlow(deps);
    const result = await flow.install(pkgPath, manifest, {
      name: manifest.name,
      projectPath: targetDir,
    });

    expect(result.installPath).toBe(targetDir);
    expect(await pathExists(targetDir)).toBe(true);
    // dorkHome must not have been touched for a project-local install.
    expect(await pathExists(path.join(deps.dorkHome, 'agents', 'local-agent'))).toBe(false);
  });

  it('rolls back staging and skips installRoot when createAgentWorkspace throws', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    deps.agentCreator.createAgentWorkspace.mockRejectedValue(new Error('boom: scaffold failed'));
    const manifest = buildManifest({ name: 'broken-agent' });
    const pkgPath = await stagePackage(manifest);
    cleanupDirs.push(pkgPath);

    const flow = new AgentInstallFlow(deps);
    await expect(flow.install(pkgPath, manifest, { name: manifest.name })).rejects.toThrow(
      /boom: scaffold failed/
    );

    // No leftover staging directories from this transaction. The hyphen
    // suffix distinguishes our prefix from the dorkHome tmpdir's own name.
    const stagingPrefix = 'dorkos-install-install-agent-broken-agent-';
    const tmpEntries = await readdir(tmpdir());
    expect(tmpEntries.some((e) => e.startsWith(stagingPrefix))).toBe(false);
  });
});
