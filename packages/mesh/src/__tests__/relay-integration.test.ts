import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createTestDb } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';
import { MeshCore } from '../mesh-core.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-relay-int-'));
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

interface MockAccessRule {
  from: string;
  to: string;
  action: 'allow' | 'deny';
  priority: number;
}

function makeMockRelayCore(initialRules: MockAccessRule[] = []) {
  const rules = [...initialRules];
  return {
    addAccessRule: vi.fn((rule: MockAccessRule) => {
      const idx = rules.findIndex((r) => r.from === rule.from && r.to === rule.to);
      if (idx >= 0) {
        rules[idx] = rule;
      } else {
        rules.push(rule);
      }
    }),
    removeAccessRule: vi.fn((from: string, to: string) => {
      const idx = rules.findIndex((r) => r.from === from && r.to === to);
      if (idx >= 0) rules.splice(idx, 1);
    }),
    listAccessRules: vi.fn(() => [...rules]),
    registerEndpoint: vi.fn(),
    unregisterEndpoint: vi.fn(),
  };
}

async function makeProjectDir(base: string, name: string): Promise<string> {
  const projectDir = path.join(base, name);
  await fs.mkdir(path.join(projectDir, '.claude'), { recursive: true });
  await fs.writeFile(path.join(projectDir, '.claude', 'CLAUDE.md'), `# ${name}`, 'utf-8');
  return projectDir;
}

// ---------------------------------------------------------------------------
// Integration tests: TopologyManager wired through MeshCore
// ---------------------------------------------------------------------------

describe('MeshCore topology integration', () => {
  let base: string;

  beforeEach(async () => {
    base = await makeTempDir();
  });

  it('agents in the same namespace are both visible', async () => {
    const projectsDir = path.join(base, 'my-project');
    const projectA = await makeProjectDir(projectsDir, 'agent-a');
    const projectB = await makeProjectDir(projectsDir, 'agent-b');

    const relayCore = makeMockRelayCore();
    const mesh = new MeshCore({
      db,
      relayCore: relayCore as never,
      defaultScanRoot: base,
    });

    try {
      await mesh.registerByPath(projectA, { name: 'agent-a', runtime: 'claude-code' }, 'test', base);
      await mesh.registerByPath(projectB, { name: 'agent-b', runtime: 'claude-code' }, 'test', base);

      // Both agents should share namespace derived from common parent
      const allAgents = mesh.list();
      expect(allAgents).toHaveLength(2);

      // Get the namespace of the first agent to query topology
      const agentA = allAgents.find((a) => a.name === 'agent-a')!;
      const ns = agentA.namespace!;

      const visible = mesh.list({ callerNamespace: ns });
      expect(visible).toHaveLength(2);
      expect(visible.map((a) => a.name).sort()).toEqual(['agent-a', 'agent-b']);
    } finally {
      mesh.close();
    }
  });

  it('agents in different namespaces are invisible to each other by default', async () => {
    const nsADir = path.join(base, 'project-alpha');
    const nsBDir = path.join(base, 'project-beta');
    const projectA = await makeProjectDir(nsADir, 'agent-a');
    const projectB = await makeProjectDir(nsBDir, 'agent-b');

    const relayCore = makeMockRelayCore();
    const mesh = new MeshCore({
      db,
      relayCore: relayCore as never,
      defaultScanRoot: base,
    });

    try {
      const manifestA = await mesh.registerByPath(
        projectA,
        { name: 'agent-a', runtime: 'claude-code' },
        'test',
        base,
      );
      const manifestB = await mesh.registerByPath(
        projectB,
        { name: 'agent-b', runtime: 'cursor' },
        'test',
        base,
      );

      // The namespaces should differ
      expect(manifestA.namespace).not.toEqual(manifestB.namespace);

      // From agent-a's namespace, only agent-a is visible
      const visibleFromA = mesh.list({ callerNamespace: manifestA.namespace! });
      expect(visibleFromA).toHaveLength(1);
      expect(visibleFromA[0]!.name).toBe('agent-a');

      // From agent-b's namespace, only agent-b is visible
      const visibleFromB = mesh.list({ callerNamespace: manifestB.namespace! });
      expect(visibleFromB).toHaveLength(1);
      expect(visibleFromB[0]!.name).toBe('agent-b');
    } finally {
      mesh.close();
    }
  });

  it('allowCrossNamespace makes cross-project agents visible', async () => {
    const nsADir = path.join(base, 'project-alpha');
    const nsBDir = path.join(base, 'project-beta');
    const projectA = await makeProjectDir(nsADir, 'agent-a');
    const projectB = await makeProjectDir(nsBDir, 'agent-b');

    const relayCore = makeMockRelayCore();
    const mesh = new MeshCore({
      db,
      relayCore: relayCore as never,
      defaultScanRoot: base,
    });

    try {
      const manifestA = await mesh.registerByPath(
        projectA,
        { name: 'agent-a', runtime: 'claude-code' },
        'test',
        base,
      );
      const manifestB = await mesh.registerByPath(
        projectB,
        { name: 'agent-b', runtime: 'cursor' },
        'test',
        base,
      );

      const nsA = manifestA.namespace!;
      const nsB = manifestB.namespace!;

      // Before: only own namespace visible
      expect(mesh.list({ callerNamespace: nsA })).toHaveLength(1);

      // Allow cross-namespace access from A -> B
      mesh.allowCrossNamespace(nsA, nsB);

      // After: agent-a can see both namespaces
      const visibleFromA = mesh.list({ callerNamespace: nsA });
      expect(visibleFromA).toHaveLength(2);
      expect(visibleFromA.map((a) => a.name).sort()).toEqual(['agent-a', 'agent-b']);

      // agent-b still can only see its own namespace (rule is directional)
      const visibleFromB = mesh.list({ callerNamespace: nsB });
      expect(visibleFromB).toHaveLength(1);
      expect(visibleFromB[0]!.name).toBe('agent-b');
    } finally {
      mesh.close();
    }
  });

  it('denyCrossNamespace hides agents again', async () => {
    const nsADir = path.join(base, 'project-alpha');
    const nsBDir = path.join(base, 'project-beta');
    const projectA = await makeProjectDir(nsADir, 'agent-a');
    const projectB = await makeProjectDir(nsBDir, 'agent-b');

    const relayCore = makeMockRelayCore();
    const mesh = new MeshCore({
      db,
      relayCore: relayCore as never,
      defaultScanRoot: base,
    });

    try {
      const manifestA = await mesh.registerByPath(
        projectA,
        { name: 'agent-a', runtime: 'claude-code' },
        'test',
        base,
      );
      const manifestB = await mesh.registerByPath(
        projectB,
        { name: 'agent-b', runtime: 'cursor' },
        'test',
        base,
      );

      const nsA = manifestA.namespace!;
      const nsB = manifestB.namespace!;

      // Allow then deny
      mesh.allowCrossNamespace(nsA, nsB);
      expect(mesh.list({ callerNamespace: nsA })).toHaveLength(2);

      mesh.denyCrossNamespace(nsA, nsB);
      expect(mesh.list({ callerNamespace: nsA })).toHaveLength(1);
      expect(mesh.list({ callerNamespace: nsA })[0]!.name).toBe('agent-a');
    } finally {
      mesh.close();
    }
  });

  it('getTopology("*") returns all namespaces', async () => {
    const nsADir = path.join(base, 'project-alpha');
    const nsBDir = path.join(base, 'project-beta');
    const projectA = await makeProjectDir(nsADir, 'agent-a');
    const projectB = await makeProjectDir(nsBDir, 'agent-b');

    const relayCore = makeMockRelayCore();
    const mesh = new MeshCore({
      db,
      relayCore: relayCore as never,
      defaultScanRoot: base,
    });

    try {
      const manifestA = await mesh.registerByPath(
        projectA,
        { name: 'agent-a', runtime: 'claude-code' },
        'test',
        base,
      );
      const manifestB = await mesh.registerByPath(
        projectB,
        { name: 'agent-b', runtime: 'cursor' },
        'test',
        base,
      );

      const view = mesh.getTopology('*');
      expect(view.callerNamespace).toBe('*');
      expect(view.namespaces).toHaveLength(2);

      const allAgentNames = view.namespaces.flatMap((ns) => ns.agents.map((a) => a.name)).sort();
      expect(allAgentNames).toEqual(['agent-a', 'agent-b']);

      // Each namespace has exactly 1 agent
      for (const ns of view.namespaces) {
        expect(ns.agentCount).toBe(1);
      }

      // Verify both namespaces are present
      const namespaceNames = view.namespaces.map((ns) => ns.namespace).sort();
      expect(namespaceNames).toContain(manifestA.namespace);
      expect(namespaceNames).toContain(manifestB.namespace);
    } finally {
      mesh.close();
    }
  });

  it('budget check integration — agents have budget fields', async () => {
    const projectDir = await makeProjectDir(base, 'budgeted-agent');

    const relayCore = makeMockRelayCore();
    const mesh = new MeshCore({
      db,
      relayCore: relayCore as never,
      defaultScanRoot: base,
    });

    try {
      const manifest = await mesh.registerByPath(
        projectDir,
        {
          name: 'budgeted-agent',
          runtime: 'claude-code',
          budget: { maxHopsPerMessage: 3, maxCallsPerHour: 50 },
        },
        'test',
        base,
      );

      // In-memory manifest preserves custom budget
      expect(manifest.budget).toEqual({ maxHopsPerMessage: 3, maxCallsPerHour: 50 });

      // After round-trip through the DB the budget falls back to defaults because
      // the Drizzle agents schema does not store per-agent budget columns.
      const view = mesh.getTopology('*');
      const agent = view.namespaces.flatMap((ns) => ns.agents).find((a) => a.name === 'budgeted-agent');
      expect(agent).toBeDefined();
      expect(agent!.budget).toEqual({ maxHopsPerMessage: 5, maxCallsPerHour: 100 });
    } finally {
      mesh.close();
    }
  });

  it('listCrossNamespaceRules reflects allow rules', async () => {
    const relayCore = makeMockRelayCore();
    const mesh = new MeshCore({
      db,
      relayCore: relayCore as never,
      defaultScanRoot: base,
    });

    try {
      // Initially no cross-namespace rules
      expect(mesh.listCrossNamespaceRules()).toEqual([]);

      // Add a cross-namespace rule
      mesh.allowCrossNamespace('ns-a', 'ns-b');

      const rules = mesh.listCrossNamespaceRules();
      expect(rules).toHaveLength(1);
      expect(rules[0]).toEqual({
        sourceNamespace: 'ns-a',
        targetNamespace: 'ns-b',
        action: 'allow',
      });

      // Deny removes the rule
      mesh.denyCrossNamespace('ns-a', 'ns-b');
      expect(mesh.listCrossNamespaceRules()).toEqual([]);
    } finally {
      mesh.close();
    }
  });

  it('getAgentAccess returns reachable agents for a given agent', async () => {
    const nsADir = path.join(base, 'project-alpha');
    const nsBDir = path.join(base, 'project-beta');
    const projectA = await makeProjectDir(nsADir, 'agent-a');
    const projectB = await makeProjectDir(nsBDir, 'agent-b');

    const relayCore = makeMockRelayCore();
    const mesh = new MeshCore({
      db,
      relayCore: relayCore as never,
      defaultScanRoot: base,
    });

    try {
      const manifestA = await mesh.registerByPath(
        projectA,
        { name: 'agent-a', runtime: 'claude-code' },
        'test',
        base,
      );
      const manifestB = await mesh.registerByPath(
        projectB,
        { name: 'agent-b', runtime: 'cursor' },
        'test',
        base,
      );

      // Without cross-namespace access, agent-a can't reach agent-b
      const accessBefore = mesh.getAgentAccess(manifestA.id);
      expect(accessBefore).toBeDefined();
      expect(accessBefore).toHaveLength(0);

      // Allow cross-namespace
      mesh.allowCrossNamespace(manifestA.namespace!, manifestB.namespace!);

      const accessAfter = mesh.getAgentAccess(manifestA.id);
      expect(accessAfter).toBeDefined();
      expect(accessAfter).toHaveLength(1);
      expect(accessAfter![0]!.name).toBe('agent-b');

      // Non-existent agent returns undefined
      expect(mesh.getAgentAccess('nonexistent')).toBeUndefined();
    } finally {
      mesh.close();
    }
  });
});
