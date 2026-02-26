import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createTestDb } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';
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

let db: Db;

beforeEach(() => {
  tempDirs.length = 0;
  db = createTestDb();
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
  await fs.mkdir(projectA, { recursive: true });
  await fs.writeFile(path.join(projectA, 'CLAUDE.md'), '# Project A', 'utf-8');

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
    const projects = path.join(base, 'projects');

    const { projectA } = await setupProjects(projects);
    const mesh = new MeshCore({ db, defaultScanRoot: base });

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
    const projects = path.join(base, 'projects');

    const { projectA, projectB } = await setupProjects(projects);
    const mesh = new MeshCore({ db, defaultScanRoot: base });

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
    const projects = path.join(base, 'projects');

    const { projectA } = await setupProjects(projects);
    const mesh = new MeshCore({ db, defaultScanRoot: base });

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
// get and getByPath
// ---------------------------------------------------------------------------

describe('get and getByPath', () => {
  it('get returns the correct agent by ID', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'project');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });
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
    const projectDir = path.join(base, 'project');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    await mesh.registerByPath(projectDir, { name: 'path-agent', runtime: 'codex' });

    const found = mesh.getByPath(projectDir);
    expect(found).toBeDefined();
    expect(found!.name).toBe('path-agent');

    expect(mesh.getByPath('/nonexistent')).toBeUndefined();

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// Namespace wiring
// ---------------------------------------------------------------------------

describe('namespace wiring', () => {
  it('register() stores namespace derived from scanRoot + projectPath', async () => {
    const base = await makeTempDir();
    const scanRoot = path.join(base, 'scan');
    const projectDir = path.join(scanRoot, 'team-alpha', 'agent-one');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'CLAUDE.md'), '# Agent', 'utf-8');

    const mesh = new MeshCore({ db, defaultScanRoot: scanRoot });

    const candidates = [];
    for await (const c of mesh.discover([scanRoot])) {
      candidates.push(c);
    }

    const candidate = candidates.find((c) => c.path === projectDir);
    expect(candidate).toBeDefined();

    const manifest = await mesh.register(candidate!);
    expect(manifest.namespace).toBe('team-alpha');

    mesh.close();
  });

  it('register() with manifest namespace override uses the override', async () => {
    const base = await makeTempDir();
    const scanRoot = path.join(base, 'scan');
    const projectDir = path.join(scanRoot, 'team-alpha', 'agent-one');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'CLAUDE.md'), '# Agent', 'utf-8');

    const mesh = new MeshCore({ db, defaultScanRoot: scanRoot });

    const candidates = [];
    for await (const c of mesh.discover([scanRoot])) {
      candidates.push(c);
    }

    const candidate = candidates.find((c) => c.path === projectDir);
    expect(candidate).toBeDefined();

    const manifest = await mesh.register(candidate!, { namespace: 'custom-ns' });
    expect(manifest.namespace).toBe('custom-ns');

    mesh.close();
  });

  it('registerByPath() stores namespace and scanRoot', async () => {
    const base = await makeTempDir();
    const scanRoot = path.join(base, 'scan');
    const projectDir = path.join(scanRoot, 'my-ns', 'my-agent');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: scanRoot });

    const manifest = await mesh.registerByPath(projectDir, {
      name: 'ns-agent',
      runtime: 'claude-code',
    });

    expect(manifest.namespace).toBe('my-ns');

    mesh.close();
  });

  it('list({ callerNamespace }) returns only agents in that namespace', async () => {
    const base = await makeTempDir();
    const scanRoot = path.join(base, 'scan');
    const projectA = path.join(scanRoot, 'ns-a', 'agent-a');
    const projectB = path.join(scanRoot, 'ns-b', 'agent-b');
    await fs.mkdir(projectA, { recursive: true });
    await fs.mkdir(projectB, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: scanRoot });

    await mesh.registerByPath(projectA, { name: 'agent-a', runtime: 'claude-code' });
    await mesh.registerByPath(projectB, { name: 'agent-b', runtime: 'claude-code' });

    const allAgents = mesh.list();
    expect(allAgents).toHaveLength(2);

    const nsAAgents = mesh.list({ callerNamespace: 'ns-a' });
    expect(nsAAgents).toHaveLength(1);
    expect(nsAAgents[0].name).toBe('agent-a');

    const nsBAgents = mesh.list({ callerNamespace: 'ns-b' });
    expect(nsBAgents).toHaveLength(1);
    expect(nsBAgents[0].name).toBe('agent-b');

    mesh.close();
  });

  it('list() without callerNamespace returns all agents', async () => {
    const base = await makeTempDir();
    const scanRoot = path.join(base, 'scan');
    const projectA = path.join(scanRoot, 'ns-a', 'agent-a');
    const projectB = path.join(scanRoot, 'ns-b', 'agent-b');
    await fs.mkdir(projectA, { recursive: true });
    await fs.mkdir(projectB, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: scanRoot });

    await mesh.registerByPath(projectA, { name: 'agent-a', runtime: 'claude-code' });
    await mesh.registerByPath(projectB, { name: 'agent-b', runtime: 'claude-code' });

    const allAgents = mesh.list();
    expect(allAgents).toHaveLength(2);

    mesh.close();
  });

  it('list({ callerNamespace: "*" }) returns all namespaces (admin view)', async () => {
    const base = await makeTempDir();
    const scanRoot = path.join(base, 'scan');
    const projectA = path.join(scanRoot, 'ns-a', 'agent-a');
    const projectB = path.join(scanRoot, 'ns-b', 'agent-b');
    await fs.mkdir(projectA, { recursive: true });
    await fs.mkdir(projectB, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: scanRoot });

    await mesh.registerByPath(projectA, { name: 'agent-a', runtime: 'claude-code' });
    await mesh.registerByPath(projectB, { name: 'agent-b', runtime: 'claude-code' });

    const adminAgents = mesh.list({ callerNamespace: '*' });
    expect(adminAgents).toHaveLength(2);

    mesh.close();
  });

  it('unregister() cleans up namespace rules when last agent removed', async () => {
    const base = await makeTempDir();
    const scanRoot = path.join(base, 'scan');
    const projectDir = path.join(scanRoot, 'my-ns', 'agent');
    await fs.mkdir(projectDir, { recursive: true });

    const mockRelayCore = {
      registerEndpoint: vi.fn().mockResolvedValue({ hash: 'abc', subject: 'test' }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
      addAccessRule: vi.fn(),
      removeAccessRule: vi.fn(),
      listAccessRules: vi.fn().mockReturnValue([]),
    };

    const mesh = new MeshCore({
      db,
      relayCore: mockRelayCore as never,
      defaultScanRoot: scanRoot,
    });

    const manifest = await mesh.registerByPath(projectDir, {
      name: 'lonely-agent',
      runtime: 'claude-code',
    });

    await mesh.unregister(manifest.id);

    // removeAccessRule should be called for namespace cleanup (same-ns allow + cross-ns deny)
    expect(mockRelayCore.removeAccessRule).toHaveBeenCalledTimes(2);

    mesh.close();
  });

  it('unregister() does NOT clean up rules when other agents remain in namespace', async () => {
    const base = await makeTempDir();
    const scanRoot = path.join(base, 'scan');
    const projectA = path.join(scanRoot, 'my-ns', 'agent-a');
    const projectB = path.join(scanRoot, 'my-ns', 'agent-b');
    await fs.mkdir(projectA, { recursive: true });
    await fs.mkdir(projectB, { recursive: true });

    const mockRelayCore = {
      registerEndpoint: vi.fn().mockResolvedValue({ hash: 'abc', subject: 'test' }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
      addAccessRule: vi.fn(),
      removeAccessRule: vi.fn(),
      listAccessRules: vi.fn().mockReturnValue([]),
    };

    const mesh = new MeshCore({
      db,
      relayCore: mockRelayCore as never,
      defaultScanRoot: scanRoot,
    });

    const manifestA = await mesh.registerByPath(projectA, { name: 'agent-a', runtime: 'claude-code' });
    await mesh.registerByPath(projectB, { name: 'agent-b', runtime: 'claude-code' });

    await mesh.unregister(manifestA.id);

    // removeAccessRule should NOT be called since agent-b still in namespace
    expect(mockRelayCore.removeAccessRule).not.toHaveBeenCalled();

    mesh.close();
  });
});
