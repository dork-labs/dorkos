import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createTestDb } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';
import { MeshCore } from '../mesh-core.js';
import { AgentRegistry } from '../agent-registry.js';
import { writeManifest } from '../manifest.js';
import * as manifestModule from '../manifest.js';
import * as reconcilerModule from '../reconciler.js';
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _c of mesh.discover([projects])) { /* drain */ }
    let agents = mesh.list();
    expect(agents.some((a) => a.name === 'V1')).toBe(true);

    // Update manifest on disk to V2
    const manifestV2 = makeManifest({ name: 'V2' });
    await writeManifest(agentDir, manifestV2);

    // Second discover — should sync V2 into DB
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _c of mesh.discover([projects])) { /* drain */ }
    agents = mesh.list();
    expect(agents.some((a) => a.name === 'V2')).toBe(true);

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _c of mesh.discover([projects])) { /* drain */ }
    expect(mesh.list()).toHaveLength(1);

    // Move agent to new path
    const newDir = path.join(projects, 'new-location');
    await fs.mkdir(newDir, { recursive: true });
    await writeManifest(newDir, manifest);
    // Remove old manifest
    await fs.rm(path.join(oldDir, '.dork'), { recursive: true, force: true });

    // Second discover — should update path via upsert
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _c of mesh.discover([projects])) { /* drain */ }
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
    const candidates = [];
    for await (const c of mesh.discover([projects])) {
      candidates.push(c);
    }
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

    const candidates = [];
    for await (const c of mesh.discover([projects])) {
      candidates.push(c);
    }
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

    const candidates = [];
    for await (const c of mesh.discover([projects])) {
      candidates.push(c);
    }
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
// Reconciliation
// ---------------------------------------------------------------------------

describe('reconciliation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconcileOnStartup() delegates to reconcile()', async () => {
    const base = await makeTempDir();
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    const spy = vi.spyOn(reconcilerModule, 'reconcile').mockResolvedValue({
      synced: 1,
      unreachable: 2,
      removed: 0,
      discovered: 0,
    });

    const result = await mesh.reconcileOnStartup();

    expect(spy).toHaveBeenCalledOnce();
    expect(result.synced).toBe(1);
    expect(result.unreachable).toBe(2);

    mesh.close();
  });

  it('startPeriodicReconciliation() sets up an interval and stopPeriodicReconciliation() clears it', async () => {
    const base = await makeTempDir();
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    const spy = vi.spyOn(reconcilerModule, 'reconcile').mockResolvedValue({
      synced: 0,
      unreachable: 0,
      removed: 0,
      discovered: 0,
    });

    // Use fake timers
    vi.useFakeTimers();

    mesh.startPeriodicReconciliation(1000);

    // Should not have fired yet
    expect(spy).not.toHaveBeenCalled();

    // Advance past one interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledOnce();

    // Advance past another interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(2);

    // Stop and verify no more calls
    mesh.stopPeriodicReconciliation();
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    mesh.close();
  });

  it('startPeriodicReconciliation() no-ops if already running', () => {
    const base = '/tmp/mesh-noop-test';
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    vi.useFakeTimers();

    mesh.startPeriodicReconciliation(1000);
    // Second call should be a no-op (no error, no double interval)
    mesh.startPeriodicReconciliation(1000);

    mesh.stopPeriodicReconciliation();
    vi.useRealTimers();
    mesh.close();
  });

  it('close() stops periodic reconciliation', () => {
    const base = '/tmp/mesh-close-test';
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    vi.useFakeTimers();

    const spy = vi.spyOn(reconcilerModule, 'reconcile').mockResolvedValue({
      synced: 0, unreachable: 0, removed: 0, discovered: 0,
    });

    mesh.startPeriodicReconciliation(1000);
    mesh.close();

    vi.advanceTimersByTime(5000);
    expect(spy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
