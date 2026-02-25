import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { MeshCore } from '../mesh-core.js';
import { writeManifest } from '../manifest.js';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-core-test-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: '01JKABC00001',
    name: 'pre-registered',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: '2026-02-24T00:00:00.000Z',
    registeredBy: 'test',
    ...overrides,
  };
}

async function setupProjects(rootDir: string) {
  const projectA = path.join(rootDir, 'project-a');
  await fs.mkdir(path.join(projectA, '.claude'), { recursive: true });
  await fs.writeFile(path.join(projectA, '.claude', 'CLAUDE.md'), '# Project A', 'utf-8');

  const projectB = path.join(rootDir, 'project-b');
  await fs.mkdir(path.join(projectB, '.cursor'), { recursive: true });

  return { projectA, projectB };
}

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe('full lifecycle', () => {
  it('discover -> register -> list -> unregister', async () => {
    const base = await makeTempDir();
    const dataDir = path.join(base, 'data');
    const projects = path.join(base, 'projects');
    await fs.mkdir(dataDir, { recursive: true });

    const { projectA } = await setupProjects(projects);
    const mesh = new MeshCore({ dataDir });

    // Discover
    const candidates = [];
    for await (const c of mesh.discover([projects])) {
      candidates.push(c);
    }
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const candidateA = candidates.find((c) => c.path === projectA);
    expect(candidateA).toBeDefined();

    // Register
    const manifest = await mesh.register(candidateA!);
    expect(manifest.name).toBeTruthy();
    expect(manifest.id).toBeTruthy();

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
    const dataDir = path.join(base, 'data');
    const projects = path.join(base, 'projects');
    await fs.mkdir(dataDir, { recursive: true });

    const preRegisteredDir = path.join(projects, 'pre-registered');
    await fs.mkdir(preRegisteredDir, { recursive: true });
    await writeManifest(preRegisteredDir, makeManifest({ name: 'pre-registered-agent' }));

    const mesh = new MeshCore({ dataDir });

    const candidates = [];
    for await (const c of mesh.discover([projects])) {
      candidates.push(c);
    }

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
// Denial filtering
// ---------------------------------------------------------------------------

describe('denial filtering', () => {
  it('discover skips denied paths', async () => {
    const base = await makeTempDir();
    const dataDir = path.join(base, 'data');
    const projects = path.join(base, 'projects');
    await fs.mkdir(dataDir, { recursive: true });

    const { projectA, projectB } = await setupProjects(projects);
    const mesh = new MeshCore({ dataDir });

    await mesh.deny(projectA, 'not needed');

    const candidates = [];
    for await (const c of mesh.discover([projects])) {
      candidates.push(c);
    }

    expect(candidates.every((c) => c.path !== projectA)).toBe(true);
    expect(candidates.some((c) => c.path === projectB)).toBe(true);

    mesh.close();
  });

  it('undeny re-enables a previously denied path for discovery', async () => {
    const base = await makeTempDir();
    const dataDir = path.join(base, 'data');
    const projects = path.join(base, 'projects');
    await fs.mkdir(dataDir, { recursive: true });

    const { projectA } = await setupProjects(projects);
    const mesh = new MeshCore({ dataDir });

    await mesh.deny(projectA);

    // Undeny
    await mesh.undeny(projectA);

    const candidates = [];
    for await (const c of mesh.discover([projects])) {
      candidates.push(c);
    }

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
    const dataDir = path.join(base, 'data');
    const projectDir = path.join(base, 'my-project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    const mesh = new MeshCore({ dataDir });

    const manifest = await mesh.registerByPath(projectDir, {
      name: 'manual-agent',
      runtime: 'claude-code',
      capabilities: ['testing'],
    });

    expect(manifest.name).toBe('manual-agent');
    expect(manifest.runtime).toBe('claude-code');
    expect(manifest.capabilities).toContain('testing');

    const agents = mesh.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(manifest.id);

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// Persistence across restarts
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('agents survive MeshCore close and recreate with same dataDir', async () => {
    const base = await makeTempDir();
    const dataDir = path.join(base, 'data');
    const projectDir = path.join(base, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    // First instance
    const mesh1 = new MeshCore({ dataDir });
    await mesh1.registerByPath(projectDir, { name: 'persistent-agent', runtime: 'claude-code' });
    mesh1.close();

    // Second instance with same dataDir
    const mesh2 = new MeshCore({ dataDir });
    const agents = mesh2.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('persistent-agent');
    mesh2.close();
  });
});

// ---------------------------------------------------------------------------
// RelayCore integration
// ---------------------------------------------------------------------------

describe('RelayCore integration', () => {
  it('calls registerEndpoint on registration', async () => {
    const base = await makeTempDir();
    const dataDir = path.join(base, 'data');
    const projectDir = path.join(base, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    const mockRelayCore = {
      registerEndpoint: vi.fn().mockResolvedValue({ hash: 'abc', subject: 'test' }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
    };

    const mesh = new MeshCore({ dataDir, relayCore: mockRelayCore as never });
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
    const dataDir = path.join(base, 'data');
    const projectDir = path.join(base, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    const mockRelayCore = {
      registerEndpoint: vi.fn().mockResolvedValue({ hash: 'abc', subject: 'test' }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
    };

    const mesh = new MeshCore({ dataDir, relayCore: mockRelayCore as never });
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
// get and getByPath
// ---------------------------------------------------------------------------

describe('get and getByPath', () => {
  it('get returns the correct agent by ID', async () => {
    const base = await makeTempDir();
    const dataDir = path.join(base, 'data');
    const projectDir = path.join(base, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    const mesh = new MeshCore({ dataDir });
    const manifest = await mesh.registerByPath(projectDir, {
      name: 'my-agent',
      runtime: 'cursor',
    });

    const found = mesh.get(manifest.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('my-agent');

    expect(mesh.get('nonexistent')).toBeUndefined();

    mesh.close();
  });

  it('getByPath returns the correct agent by project path', async () => {
    const base = await makeTempDir();
    const dataDir = path.join(base, 'data');
    const projectDir = path.join(base, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    const mesh = new MeshCore({ dataDir });
    await mesh.registerByPath(projectDir, { name: 'path-agent', runtime: 'codex' });

    const found = mesh.getByPath(projectDir);
    expect(found).toBeDefined();
    expect(found!.name).toBe('path-agent');

    expect(mesh.getByPath('/nonexistent')).toBeUndefined();

    mesh.close();
  });
});
