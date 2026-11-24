import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { MeshCore } from '../mesh-core.js';
import { AgentRegistry } from '../agent-registry.js';
import { normalizeNamespace } from '../namespace-resolver.js';
import { writeManifest } from '../manifest.js';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import {
  cleanTempDirsAfterEach,
  collectCandidates,
  makeManifest,
  makeTempDir,
} from './mesh-core.fixtures.js';

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

cleanTempDirsAfterEach();

// ---------------------------------------------------------------------------
// Namespace wiring
// ---------------------------------------------------------------------------

describe('namespace wiring', () => {
  it('register() with manifest namespace override uses the override', async () => {
    const base = await makeTempDir();
    const scanRoot = path.join(base, 'scan');
    const projectDir = path.join(scanRoot, 'team-alpha', 'agent-one');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'AGENTS.md'), '# Agent', 'utf-8');

    const mesh = new MeshCore({ db, defaultScanRoot: scanRoot });

    const candidates = await collectCandidates(mesh.discover([scanRoot]));

    const candidate = candidates.find((c) => c.path === projectDir);
    expect(candidate).toBeDefined();

    const manifest = await mesh.register(candidate!, { namespace: 'custom-ns' });
    expect(manifest.namespace).toBe('custom-ns');

    mesh.close();
  });

  it('registers a project that is its own scan root under the directory basename', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'Exact Root Project');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    const manifest = await mesh.registerByPath(
      projectDir,
      { name: 'exact-root', runtime: 'codex' },
      'test',
      projectDir
    );

    expect(manifest.namespace).toBe('exact-root-project');
    expect(new AgentRegistry(db).getByPath(projectDir)?.scanRoot).toBe(projectDir);

    const onDisk = JSON.parse(
      await fs.readFile(path.join(projectDir, '.dork', 'agent.json'), 'utf-8')
    ) as AgentManifest;
    expect(onDisk.namespace).toBe('exact-root-project');

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

    // Namespace cleanup removes every default rule the namespace could hold —
    // same-ns allow, cross-ns deny, and the two system-agent rules (which match
    // nothing here, and must still be asked for so a system namespace leaves
    // nothing behind either).
    expect(mockRelayCore.removeAccessRule).toHaveBeenCalledTimes(4);

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

    const manifestA = await mesh.registerByPath(projectA, {
      name: 'agent-a',
      runtime: 'claude-code',
    });
    await mesh.registerByPath(projectB, { name: 'agent-b', runtime: 'claude-code' });

    await mesh.unregister(manifestA.id);

    // removeAccessRule should NOT be called since agent-b still in namespace
    expect(mockRelayCore.removeAccessRule).not.toHaveBeenCalled();

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// Auto-import namespace at the scan root
// ---------------------------------------------------------------------------

describe('auto-import namespace at the scan root', () => {
  it('uses the scan root basename without aborting the scan', async () => {
    const base = await makeTempDir();
    // A manifest at the scan root derives its namespace from that directory.
    await writeManifest(base, makeManifest({ id: '01ROOTAGENT', name: 'root-agent' }));

    const mesh = new MeshCore({ db, defaultScanRoot: base });

    // The scan completes (no thrown error) and emits a terminal 'complete' event.
    const events: string[] = [];
    for await (const event of mesh.discover([base])) {
      events.push(event.type);
    }
    expect(events).toContain('complete');

    const registry = new AgentRegistry(db);
    const entry = registry.getByPath(base);
    expect(entry).toBeDefined();
    expect(entry?.namespace).toBe(normalizeNamespace(path.basename(base)));

    mesh.close();
  });
});
