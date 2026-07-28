/**
 * Tests for {@link AgentInstallFlow}.
 *
 * Each test stages a minimal agent template package on disk, then drives the
 * flow with a mocked `agentCreator` dependency. The four cases cover the
 * happy path (agent template installed under `<dorkHome>/agents/<name>`),
 * `agentDefaults.traits` propagation, project-local installs (via
 * `opts.projectPath`), the containment boundary a project-local install has to
 * hold (DOR-522), and the failure path where `createAgentWorkspace` throws —
 * staging must be cleaned and the install root must not exist.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import type { AgentPackageManifest } from '@dorkos/marketplace';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { AgentInstallFlow } from '../../flows/install-agent.js';

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
  await mkdir(path.join(root, '.dork'), { recursive: true });
  await writeFile(
    path.join(root, '.dork', 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );
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
    expect(await pathExists(path.join(expectedDir, '.dork', 'manifest.json'))).toBe(true);

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
        traits: { ...DEFAULT_TRAITS, verbosity: 4, autonomy: 5, chaos: 2, creativity: 5 },
      },
    });
    const pkgPath = await stagePackage(manifest);
    cleanupDirs.push(pkgPath);

    const flow = new AgentInstallFlow(deps);
    await flow.install(pkgPath, manifest, { name: manifest.name });

    const callArgs = deps.agentCreator.createAgentWorkspace.mock.calls[0]?.[0] as {
      traits: { verbosity: number; autonomy: number; chaos: number };
    };
    expect(callArgs.traits).toEqual({
      verbosity: 4,
      autonomy: 5,
      chaos: 2,
      creativity: 5,
      humor: 3,
      spice: 3,
    });
  });

  it('nests project-local installs under <projectPath>/.dork/agents/<name>', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const projectPath = await mkdtemp(path.join(tmpdir(), 'install-agent-proj-'));
    cleanupDirs.push(projectPath);
    const manifest = buildManifest({ name: 'local-agent' });
    const pkgPath = await stagePackage(manifest);
    cleanupDirs.push(pkgPath);

    const flow = new AgentInstallFlow(deps);
    const result = await flow.install(pkgPath, manifest, {
      name: manifest.name,
      projectPath,
    });

    // The package gets its own directory, exactly as a plugin does. It used to
    // get the project root itself (DOR-522).
    const targetDir = path.join(projectPath, '.dork', 'agents', 'local-agent');
    expect(result.installPath).toBe(targetDir);
    expect(await pathExists(path.join(targetDir, '.dork', 'manifest.json'))).toBe(true);
    // dorkHome must not have been touched for a project-local install.
    expect(await pathExists(path.join(deps.dorkHome, 'agents', 'local-agent'))).toBe(false);
  });

  it('cannot land an extension where DorkOS would discover it (DOR-522)', async () => {
    // The destination is the boundary. An `agent` package can ship any layout it
    // likes; what stops `.dork/extensions/<id>/server.ts` — code DorkOS loads
    // into its own process once approved — from arriving at a path
    // `ExtensionDiscovery` scans is that the package unpacks into a directory of
    // its own, not into the project root.
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const projectPath = await mkdtemp(path.join(tmpdir(), 'install-agent-evil-'));
    cleanupDirs.push(projectPath);
    const manifest = buildManifest({ name: 'trojan-agent' });
    const pkgPath = await stagePackage(manifest);
    cleanupDirs.push(pkgPath);

    const smuggled = path.join(pkgPath, '.dork', 'extensions', 'evil');
    await mkdir(smuggled, { recursive: true });
    await writeFile(
      path.join(smuggled, 'extension.json'),
      JSON.stringify({ id: 'evil', name: 'Evil', version: '1.0.0', server: 'server.js' }),
      'utf-8'
    );
    await writeFile(path.join(smuggled, 'server.ts'), 'export function initialize() {}\n', 'utf-8');

    const flow = new AgentInstallFlow(deps);
    await flow.install(pkgPath, manifest, { name: manifest.name, projectPath });

    // The two directories `ExtensionDiscovery.discover()` scans: `<cwd>/.dork/
    // extensions` and `<dorkHome>/extensions`. Neither may hold `evil`.
    expect(await pathExists(path.join(projectPath, '.dork', 'extensions', 'evil'))).toBe(false);
    expect(await pathExists(path.join(deps.dorkHome, 'extensions', 'evil'))).toBe(false);
    // It is still installed, inside its own directory, where nothing scans it.
    expect(
      await pathExists(
        path.join(projectPath, '.dork', 'agents', 'trojan-agent', '.dork', 'extensions', 'evil')
      )
    ).toBe(true);
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

  it('restores the previous agent directory when createAgentWorkspace throws on a reinstall', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    deps.agentCreator.createAgentWorkspace.mockRejectedValue(new Error('boom: scaffold failed'));
    const manifest = buildManifest({ name: 'reinstall-agent' });
    const pkgPath = await stagePackage(manifest);
    cleanupDirs.push(pkgPath);

    // Seed a distinctive pre-existing agent installation at the target.
    const targetDir = path.join(deps.dorkHome, 'agents', 'reinstall-agent');
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, 'original.txt'), 'ORIGINAL', 'utf-8');

    const flow = new AgentInstallFlow(deps);
    await expect(flow.install(pkgPath, manifest, { name: manifest.name })).rejects.toThrow(
      /boom: scaffold failed/
    );

    // The previous agent directory is restored byte-for-byte.
    expect(await pathExists(targetDir)).toBe(true);
    expect(await readFile(path.join(targetDir, 'original.txt'), 'utf-8')).toBe('ORIGINAL');
    // The failed reinstall's package files are gone.
    expect(await pathExists(path.join(targetDir, '.dork', 'manifest.json'))).toBe(false);
    // No leftover backup sibling under agents/.
    const agentEntries = await readdir(path.join(deps.dorkHome, 'agents'));
    expect(agentEntries.some((e) => e.includes('.dorkos-bak-'))).toBe(false);
  });
});
