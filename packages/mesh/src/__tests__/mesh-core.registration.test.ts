import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { MeshCore } from '../mesh-core.js';
import { AgentRegistry } from '../agent-registry.js';
import { writeManifest } from '../manifest.js';
import * as manifestModule from '../manifest.js';
import type { AgentManifest, DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import { seedAgentFace, AGENT_COLOR_PRESETS, AGENT_EMOJI_SET } from '@dorkos/shared/agent-face';
import {
  cleanTempDirsAfterEach,
  collectCandidates,
  makeManifest,
  makeTempDir,
  setupProjects,
} from './mesh-core.fixtures.js';

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

cleanTempDirsAfterEach();

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe('full lifecycle', () => {
  it('discover -> register -> list -> unregister', async () => {
    const base = await makeTempDir();
    const projects = path.join(base, 'projects');

    const { projectA } = await setupProjects(projects);
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    // Discover
    const candidates = await collectCandidates(mesh.discover([projects]));
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const candidateA = candidates.find((c) => c.path === projectA);
    expect(candidateA).toBeDefined();

    // Register
    const manifest = await mesh.register(candidateA!);
    expect(manifest.name).toBeTruthy();
    expect(manifest.id).toBeTruthy();
    expect(manifest.namespace).toBe('projects');

    // Verify .dork/agent.json was written
    await expect(fs.access(path.join(projectA, '.dork', 'agent.json'))).resolves.toBeUndefined();

    // List
    const agents = mesh.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(manifest.id);

    // Unregister
    await mesh.unregister(manifest.id);
    expect(mesh.list()).toHaveLength(0);

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// Auto-import
// ---------------------------------------------------------------------------

describe('auto-import', () => {
  it('auto-imports pre-registered projects without yielding as candidate', async () => {
    const base = await makeTempDir();
    const projects = path.join(base, 'projects');

    const preRegisteredDir = path.join(projects, 'pre-registered');
    await fs.mkdir(preRegisteredDir, { recursive: true });
    await writeManifest(preRegisteredDir, makeManifest({ name: 'pre-registered-agent' }));

    const mesh = new MeshCore({ db, defaultScanRoot: base });

    const candidates = await collectCandidates(mesh.discover([projects]));

    // pre-registered should not appear as a candidate
    const preRegisteredCandidate = candidates.find((c) => c.path === preRegisteredDir);
    expect(preRegisteredCandidate).toBeUndefined();

    // But should be in list()
    const agents = mesh.list();
    expect(agents.some((a) => a.name === 'pre-registered-agent')).toBe(true);

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// upsertAutoImported sync behavior
// ---------------------------------------------------------------------------

describe('upsertAutoImported()', () => {
  it('updates DB when manifest file has changed', async () => {
    const base = await makeTempDir();
    const projects = path.join(base, 'projects');
    const agentDir = path.join(projects, 'my-agent');
    await fs.mkdir(agentDir, { recursive: true });

    const manifestV1 = makeManifest({ name: 'V1' });
    await writeManifest(agentDir, manifestV1);

    const mesh = new MeshCore({ db, defaultScanRoot: base });

    // First discover — auto-imports V1

    await collectCandidates(mesh.discover([projects])); // drain
    let agents = mesh.list();
    expect(agents.some((a) => a.name === 'V1')).toBe(true);

    // Update manifest on disk to V2
    const manifestV2 = makeManifest({ name: 'V2' });
    await writeManifest(agentDir, manifestV2);

    // Second discover — should sync V2 into DB

    await collectCandidates(mesh.discover([projects])); // drain
    agents = mesh.list();
    expect(agents.some((a) => a.name === 'V2')).toBe(true);

    mesh.close();
  });

  it('records the walked root as scanRoot and preserves it across syncFromDisk', async () => {
    const base = await makeTempDir();
    const projects = path.join(base, 'projects');
    const agentDir = path.join(projects, 'my-agent');
    await fs.mkdir(agentDir, { recursive: true });
    await writeManifest(agentDir, makeManifest({ name: 'rooted' }));

    // defaultScanRoot deliberately differs from the walked root.
    const mesh = new MeshCore({ db, defaultScanRoot: base });
    await collectCandidates(mesh.discover([projects])); // drain

    const registry = new AgentRegistry(db);
    expect(registry.getByPath(agentDir)?.scanRoot).toBe(projects);

    // syncFromDisk has no scan context — it must keep the recorded root
    // instead of clobbering it with defaultScanRoot.
    await mesh.syncFromDisk(agentDir);
    expect(registry.getByPath(agentDir)?.scanRoot).toBe(projects);

    mesh.close();
  });

  it('handles moved folder (same ID, different path)', async () => {
    const base = await makeTempDir();
    const projects = path.join(base, 'projects');

    // Create agent at old path
    const oldDir = path.join(projects, 'old-location');
    await fs.mkdir(oldDir, { recursive: true });
    const manifest = makeManifest({ name: 'movable-agent' });
    await writeManifest(oldDir, manifest);

    const mesh = new MeshCore({ db, defaultScanRoot: base });

    // First discover — auto-imports at old path

    await collectCandidates(mesh.discover([projects])); // drain
    expect(mesh.list()).toHaveLength(1);

    // Move agent to new path
    const newDir = path.join(projects, 'new-location');
    await fs.mkdir(newDir, { recursive: true });
    await writeManifest(newDir, manifest);
    // Remove old manifest
    await fs.rm(path.join(oldDir, '.dork'), { recursive: true, force: true });

    // Second discover — should update path via upsert

    await collectCandidates(mesh.discover([projects])); // drain
    const agents = mesh.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('movable-agent');

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// Denial filtering
// ---------------------------------------------------------------------------

describe('denial filtering', () => {
  it('discover skips denied paths', async () => {
    const base = await makeTempDir();
    const projects = path.join(base, 'projects');

    const { projectA, projectB } = await setupProjects(projects);
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    await mesh.deny(projectA, 'not needed');

    const candidates = await collectCandidates(mesh.discover([projects]));

    expect(candidates.every((c) => c.path !== projectA)).toBe(true);
    expect(candidates.some((c) => c.path === projectB)).toBe(true);

    mesh.close();
  });

  it('undeny re-enables a previously denied path for discovery', async () => {
    const base = await makeTempDir();
    const projects = path.join(base, 'projects');
    const { projectA } = await setupProjects(projects);
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    await mesh.deny(projectA);
    await mesh.undeny(projectA);

    const candidates = await collectCandidates(mesh.discover([projects]));
    expect(candidates.some((c) => c.path === projectA)).toBe(true);

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// Manual registration
// ---------------------------------------------------------------------------

describe('registerByPath', () => {
  it('registers an agent directly without prior discovery', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'my-project');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });

    const manifest = await mesh.registerByPath(projectDir, {
      name: 'manual-agent',
      runtime: 'claude-code',
      capabilities: ['testing'],
    });

    expect(manifest.name).toBe('manual-agent');
    expect(manifest.runtime).toBe('claude-code');
    expect(manifest.capabilities).toContain('testing');
    expect(manifest.namespace).toBe('my-project');

    const agents = mesh.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(manifest.id);

    mesh.close();
  });

  it('carries a display name onto the manifest, the file, and the registry row', async () => {
    // It was the one identity field the builder dropped, so an agent
    // registered with both a slug and a display name had only the slug to show
    // a person anywhere (DOR-2054).
    const base = await makeTempDir();
    const projectDir = path.join(base, 'named-project');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });

    const manifest = await mesh.registerByPath(projectDir, {
      name: 'dorkos-cloud',
      displayName: 'DorkOS Cloud',
      runtime: 'claude-code',
    });

    expect(manifest.displayName).toBe('DorkOS Cloud');

    const onDisk = JSON.parse(
      await fs.readFile(path.join(projectDir, '.dork', 'agent.json'), 'utf-8')
    ) as AgentManifest;
    expect(onDisk.displayName).toBe('DorkOS Cloud');
    expect(mesh.list()[0].displayName).toBe('DorkOS Cloud');

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// The seeded face (DOR-949)
// ---------------------------------------------------------------------------

describe('agent face at registration', () => {
  it('gives a registerByPath agent a face from the curated sets', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'faceless-project');
    await fs.mkdir(projectDir, { recursive: true });
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    const manifest = await mesh.registerByPath(projectDir, {
      name: 'manual-agent',
      runtime: 'claude-code',
    });

    expect({ color: manifest.color, icon: manifest.icon }).toEqual(seedAgentFace(manifest.id));
    expect(AGENT_COLOR_PRESETS.map((preset) => preset.hex)).toContain(manifest.color);
    expect(AGENT_EMOJI_SET).toContain(manifest.icon);

    // On disk and in the registry row too — the manifest is the source of
    // truth (ADR-0043) and the row is what every listing surface reads.
    const onDisk = JSON.parse(
      await fs.readFile(path.join(projectDir, '.dork', 'agent.json'), 'utf-8')
    ) as AgentManifest;
    expect({ color: onDisk.color, icon: onDisk.icon }).toEqual(seedAgentFace(manifest.id));
    expect(mesh.list()[0].icon).toBe(manifest.icon);

    mesh.close();
  });

  it('gives a discovered-then-registered agent a face, and keeps an overridden one', async () => {
    const base = await makeTempDir();
    const projects = path.join(base, 'projects');
    const { projectA } = await setupProjects(projects);
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    const candidates = await collectCandidates(mesh.discover([projects]));
    const candidate = candidates.find((c) => c.path === projectA);
    const manifest = await mesh.register(candidate!);

    expect({ color: manifest.color, icon: manifest.icon }).toEqual(seedAgentFace(manifest.id));

    // The override arm of the same seam: an explicit face wins over the seed,
    // and the display name rides with it. `register` dropped `displayName` on
    // the floor exactly as `registerByPath` did (DOR-2054), so it is pinned
    // here beside the two fields that always worked.
    const other = candidates.find((c) => c.path !== projectA);
    const overridden = await mesh.register(other!, {
      icon: '🦕',
      color: '#123456',
      displayName: 'The Other One',
    });
    expect(overridden.icon).toBe('🦕');
    expect(overridden.color).toBe('#123456');
    expect(overridden.displayName).toBe('The Other One');

    const onDisk = JSON.parse(
      await fs.readFile(path.join(other!.path, '.dork', 'agent.json'), 'utf-8')
    ) as AgentManifest;
    expect(onDisk.displayName).toBe('The Other One');

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// RelayCore integration
// ---------------------------------------------------------------------------

describe('RelayCore integration', () => {
  it('calls registerEndpoint on registration', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'project');
    await fs.mkdir(projectDir, { recursive: true });

    const mockRelayCore = {
      registerEndpoint: vi.fn().mockResolvedValue({ hash: 'abc', subject: 'test' }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
      addAccessRule: vi.fn(),
      removeAccessRule: vi.fn(),
      listAccessRules: vi.fn().mockReturnValue([]),
    };

    const mesh = new MeshCore({ db, relayCore: mockRelayCore as never, defaultScanRoot: base });
    const manifest = await mesh.registerByPath(projectDir, {
      name: 'relay-agent',
      runtime: 'claude-code',
    });

    expect(mockRelayCore.registerEndpoint).toHaveBeenCalledOnce();
    const [subject] = mockRelayCore.registerEndpoint.mock.calls[0] as [string];
    expect(subject).toContain('relay.agent.');
    expect(subject).toContain(manifest.id);

    mesh.close();
  });

  it('calls unregisterEndpoint on unregistration', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'project');
    await fs.mkdir(projectDir, { recursive: true });

    const mockRelayCore = {
      registerEndpoint: vi.fn().mockResolvedValue({ hash: 'abc', subject: 'test' }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
      addAccessRule: vi.fn(),
      removeAccessRule: vi.fn(),
      listAccessRules: vi.fn().mockReturnValue([]),
    };

    const mesh = new MeshCore({ db, relayCore: mockRelayCore as never, defaultScanRoot: base });
    const manifest = await mesh.registerByPath(projectDir, {
      name: 'relay-agent',
      runtime: 'claude-code',
    });

    await mesh.unregister(manifest.id);

    expect(mockRelayCore.unregisterEndpoint).toHaveBeenCalledOnce();

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// register() compensation
// ---------------------------------------------------------------------------

describe('register() compensation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes manifest file when DB upsert fails', async () => {
    const base = await makeTempDir();
    const projects = path.join(base, 'projects');
    const { projectA } = await setupProjects(projects);
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    // Discover to get a candidate
    const candidates = await collectCandidates(mesh.discover([projects]));
    const candidate = candidates.find((c) => c.path === projectA);
    expect(candidate).toBeDefined();

    // Spy on removeManifest and make upsert throw
    const removeSpy = vi.spyOn(manifestModule, 'removeManifest').mockResolvedValue(undefined);
    vi.spyOn(AgentRegistry.prototype, 'upsert').mockImplementation(() => {
      throw new Error('DB error');
    });

    await expect(mesh.register(candidate!)).rejects.toThrow('DB error');
    expect(removeSpy).toHaveBeenCalledWith(candidate!.path);

    mesh.close();
  });

  it('removes DB entry when Relay registration fails', async () => {
    const base = await makeTempDir();
    const projects = path.join(base, 'projects');
    const { projectA } = await setupProjects(projects);

    const mockRelayCore = {
      registerEndpoint: vi.fn().mockRejectedValue(new Error('Relay error')),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
      addAccessRule: vi.fn(),
      removeAccessRule: vi.fn(),
      listAccessRules: vi.fn().mockReturnValue([]),
    };

    const mesh = new MeshCore({ db, relayCore: mockRelayCore as never, defaultScanRoot: base });

    const candidates = await collectCandidates(mesh.discover([projects]));
    const candidate = candidates.find((c) => c.path === projectA);
    expect(candidate).toBeDefined();

    const removeSpy = vi.spyOn(AgentRegistry.prototype, 'remove');

    await expect(mesh.register(candidate!)).rejects.toThrow('Relay error');
    expect(removeSpy).toHaveBeenCalled();

    // Agent should not be in registry after compensation
    expect(mesh.list()).toHaveLength(0);

    mesh.close();
  });

  it('succeeds on re-registration at same path', async () => {
    const base = await makeTempDir();
    const projects = path.join(base, 'projects');
    const { projectA } = await setupProjects(projects);
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    const candidates = await collectCandidates(mesh.discover([projects]));
    const candidate = candidates.find((c) => c.path === projectA);
    expect(candidate).toBeDefined();

    // First registration
    await mesh.register(candidate!);
    // Second registration at same path should not crash
    await expect(mesh.register(candidate!)).resolves.toBeDefined();

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// registerByPath() compensation
// ---------------------------------------------------------------------------

describe('registerByPath() compensation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes the DB entry and the manifest file, and re-throws, when Relay registration fails', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'my-project');
    await fs.mkdir(projectDir, { recursive: true });

    const mockRelayCore = {
      registerEndpoint: vi.fn().mockRejectedValue(new Error('Relay error')),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
      addAccessRule: vi.fn(),
      removeAccessRule: vi.fn(),
      listAccessRules: vi.fn().mockReturnValue([]),
    };

    const mesh = new MeshCore({ db, relayCore: mockRelayCore as never, defaultScanRoot: base });

    const removeManifestSpy = vi
      .spyOn(manifestModule, 'removeManifest')
      .mockResolvedValue(undefined);
    const registryRemoveSpy = vi.spyOn(AgentRegistry.prototype, 'remove');

    await expect(
      mesh.registerByPath(projectDir, { name: 'failing-agent', runtime: 'claude-code' })
    ).rejects.toThrow('Relay error');

    expect(registryRemoveSpy).toHaveBeenCalled();
    expect(removeManifestSpy).toHaveBeenCalledWith(projectDir);
    expect(mesh.list()).toHaveLength(0);

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// Shared registration logic (toManifest / registerInternal)
// ---------------------------------------------------------------------------

describe('shared registration logic', () => {
  it('register() and registerByPath() both strip internal fields from returned manifest', async () => {
    const base = await makeTempDir();
    const projectA = path.join(base, 'agent-a');
    const projectB = path.join(base, 'agent-b');
    await fs.mkdir(projectA, { recursive: true });
    await fs.mkdir(projectB, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });

    const candidate: DiscoveryCandidate = {
      path: projectA,
      hints: {
        suggestedName: 'Agent A',
        detectedRuntime: 'claude-code',
        description: 'Test agent',
        inferredCapabilities: ['code'],
      },
      strategy: 'test',
      discoveredAt: '2026-02-24T00:00:00.000Z',
    };
    const fromDiscover = await mesh.register(candidate);

    expect(fromDiscover).not.toHaveProperty('projectPath');
    expect(fromDiscover).not.toHaveProperty('scanRoot');
    expect(fromDiscover.name).toBe('Agent A');

    const fromPath = await mesh.registerByPath(projectB, {
      name: 'Agent B',
      runtime: 'claude-code',
    });

    expect(fromPath).not.toHaveProperty('projectPath');
    expect(fromPath).not.toHaveProperty('scanRoot');
    expect(fromPath.name).toBe('Agent B');

    mesh.close();
  });
});
