import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TopologyManager } from '../topology.js';
import type { AgentRegistryEntry } from '../agent-registry.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    id: '01JKABC00001',
    name: 'test-agent',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: '2026-02-24T00:00:00.000Z',
    registeredBy: 'test',
    projectPath: '/projects/agent-a',
    namespace: 'ns-a',
    scanRoot: '/projects',
    ...overrides,
  };
}

function makeMockRegistry(entries: AgentRegistryEntry[] = []) {
  return {
    list: vi.fn().mockReturnValue(entries),
    get: vi.fn((id: string) => entries.find((e) => e.id === id)),
    listByNamespace: vi.fn((ns: string) => entries.filter((e) => e.namespace === ns)),
    insert: vi.fn(),
    remove: vi.fn(),
    getByPath: vi.fn(),
    update: vi.fn(),
    close: vi.fn(),
    database: {} as never,
    updateHealth: vi.fn(),
    getWithHealth: vi.fn(),
    listWithHealth: vi.fn(),
    getAggregateStats: vi.fn(),
  };
}

function makeMockRelayBridge() {
  return {
    registerAgent: vi.fn().mockResolvedValue('relay.agent.ns.id'),
    unregisterAgent: vi.fn().mockResolvedValue(undefined),
    cleanupNamespaceRules: vi.fn(),
  };
}

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
      // Replace existing rule with same from/to
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
    // Stubs for other RelayCore methods
    registerEndpoint: vi.fn(),
    unregisterEndpoint: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const agentA1 = makeEntry({ id: 'A1', name: 'agent-a1', namespace: 'ns-a', projectPath: '/p/a1' });
const agentA2 = makeEntry({ id: 'A2', name: 'agent-a2', namespace: 'ns-a', projectPath: '/p/a2' });
const agentB1 = makeEntry({ id: 'B1', name: 'agent-b1', namespace: 'ns-b', projectPath: '/p/b1' });
const agentC1 = makeEntry({ id: 'C1', name: 'agent-c1', namespace: 'ns-c', projectPath: '/p/c1' });

// ---------------------------------------------------------------------------
// getTopology
// ---------------------------------------------------------------------------

describe('TopologyManager', () => {
  describe('getTopology', () => {
    it('returns only caller namespace agents (invisible boundary)', () => {
      const registry = makeMockRegistry([agentA1, agentA2, agentB1, agentC1]);
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, relay as never);

      const view = tm.getTopology('ns-a');

      expect(view.callerNamespace).toBe('ns-a');
      expect(view.namespaces).toHaveLength(1);
      expect(view.namespaces[0]!.namespace).toBe('ns-a');
      expect(view.namespaces[0]!.agentCount).toBe(2);
    });

    it('returns all namespaces for admin view (*)', () => {
      const registry = makeMockRegistry([agentA1, agentB1, agentC1]);
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, relay as never);

      const view = tm.getTopology('*');

      expect(view.callerNamespace).toBe('*');
      expect(view.namespaces).toHaveLength(3);
      const nsNames = view.namespaces.map((ns) => ns.namespace).sort();
      expect(nsNames).toEqual(['ns-a', 'ns-b', 'ns-c']);
    });

    it('includes cross-namespace agents after allowCrossNamespace', () => {
      const registry = makeMockRegistry([agentA1, agentB1, agentC1]);
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, relay as never);

      tm.allowCrossNamespace('ns-a', 'ns-b');

      const view = tm.getTopology('ns-a');

      expect(view.namespaces).toHaveLength(2);
      const nsNames = view.namespaces.map((ns) => ns.namespace).sort();
      expect(nsNames).toEqual(['ns-a', 'ns-b']);
    });

    it('hides namespace again after denyCrossNamespace', () => {
      const registry = makeMockRegistry([agentA1, agentB1]);
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, relay as never);

      tm.allowCrossNamespace('ns-a', 'ns-b');
      // Verify ns-b is now visible
      expect(tm.getTopology('ns-a').namespaces).toHaveLength(2);

      tm.denyCrossNamespace('ns-a', 'ns-b');

      const view = tm.getTopology('ns-a');
      expect(view.namespaces).toHaveLength(1);
      expect(view.namespaces[0]!.namespace).toBe('ns-a');
    });

    it('strips projectPath and scanRoot from agent manifests', () => {
      const registry = makeMockRegistry([agentA1]);
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, relay as never);

      const view = tm.getTopology('ns-a');
      const agent = view.namespaces[0]!.agents[0]!;

      expect(agent).not.toHaveProperty('projectPath');
      expect(agent).not.toHaveProperty('scanRoot');
      expect(agent.id).toBe('A1');
      expect(agent.name).toBe('agent-a1');
    });

    it('returns empty namespaces when caller has no agents', () => {
      const registry = makeMockRegistry([agentA1, agentB1]);
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, relay as never);

      const view = tm.getTopology('ns-unknown');

      expect(view.namespaces).toHaveLength(0);
    });

    it('includes access rules involving accessible namespaces', () => {
      const registry = makeMockRegistry([agentA1, agentB1, agentC1]);
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, relay as never);

      tm.allowCrossNamespace('ns-a', 'ns-b');
      tm.allowCrossNamespace('ns-b', 'ns-c');

      const view = tm.getTopology('ns-a');

      // ns-a can see ns-a and ns-b, so rules involving ns-a or ns-b are returned
      const ruleDescs = view.accessRules.map((r) => `${r.sourceNamespace}->${r.targetNamespace}`);
      expect(ruleDescs).toContain('ns-a->ns-b');
      // ns-b->ns-c involves ns-b which is accessible, so it should be included
      expect(ruleDescs).toContain('ns-b->ns-c');
    });

    it('admin view returns all cross-namespace rules', () => {
      const registry = makeMockRegistry([agentA1, agentB1, agentC1]);
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, relay as never);

      tm.allowCrossNamespace('ns-a', 'ns-b');
      tm.allowCrossNamespace('ns-b', 'ns-c');

      const view = tm.getTopology('*');

      expect(view.accessRules).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // getAgentAccess
  // ---------------------------------------------------------------------------

  describe('getAgentAccess', () => {
    it('returns agents in accessible namespaces (excluding self)', () => {
      const registry = makeMockRegistry([agentA1, agentA2, agentB1]);
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, relay as never);

      const reachable = tm.getAgentAccess('A1');

      expect(reachable).toBeDefined();
      // A1 is in ns-a, can reach A2 (same ns) but not B1 (different ns)
      expect(reachable!.map((a) => a.id)).toEqual(['A2']);
    });

    it('includes cross-namespace agents after allowCrossNamespace', () => {
      const registry = makeMockRegistry([agentA1, agentB1]);
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, relay as never);

      tm.allowCrossNamespace('ns-a', 'ns-b');

      const reachable = tm.getAgentAccess('A1');

      expect(reachable).toBeDefined();
      expect(reachable!.map((a) => a.id)).toEqual(['B1']);
    });

    it('returns undefined for nonexistent agent', () => {
      const registry = makeMockRegistry([agentA1]);
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, relay as never);

      const result = tm.getAgentAccess('nonexistent');

      expect(result).toBeUndefined();
    });

    it('does not include the agent itself in results', () => {
      const registry = makeMockRegistry([agentA1]);
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, relay as never);

      const reachable = tm.getAgentAccess('A1');

      expect(reachable).toBeDefined();
      expect(reachable).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // allowCrossNamespace / denyCrossNamespace
  // ---------------------------------------------------------------------------

  describe('allowCrossNamespace', () => {
    it('calls relayCore.addAccessRule with priority 50', () => {
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(makeMockRegistry() as never, makeMockRelayBridge() as never, relay as never);

      tm.allowCrossNamespace('ns-a', 'ns-b');

      expect(relay.addAccessRule).toHaveBeenCalledWith({
        from: 'relay.agent.ns-a.*',
        to: 'relay.agent.ns-b.*',
        action: 'allow',
        priority: 50,
      });
    });

    it('is a no-op when relayCore is undefined', () => {
      const tm = new TopologyManager(makeMockRegistry() as never, makeMockRelayBridge() as never, undefined);

      // Should not throw
      tm.allowCrossNamespace('ns-a', 'ns-b');
    });
  });

  describe('denyCrossNamespace', () => {
    it('calls relayCore.removeAccessRule for the source->target pattern', () => {
      const relay = makeMockRelayCore();
      const tm = new TopologyManager(makeMockRegistry() as never, makeMockRelayBridge() as never, relay as never);

      tm.denyCrossNamespace('ns-a', 'ns-b');

      expect(relay.removeAccessRule).toHaveBeenCalledWith(
        'relay.agent.ns-a.*',
        'relay.agent.ns-b.*',
      );
    });

    it('is a no-op when relayCore is undefined', () => {
      const tm = new TopologyManager(makeMockRegistry() as never, makeMockRelayBridge() as never, undefined);

      // Should not throw
      tm.denyCrossNamespace('ns-a', 'ns-b');
    });
  });

  // ---------------------------------------------------------------------------
  // listCrossNamespaceRules
  // ---------------------------------------------------------------------------

  describe('listCrossNamespaceRules', () => {
    it('returns only cross-namespace rules (not same-namespace)', () => {
      const relay = makeMockRelayCore([
        // Same-namespace allow (should be excluded)
        { from: 'relay.agent.ns-a.*', to: 'relay.agent.ns-a.*', action: 'allow', priority: 100 },
        // Cross-namespace allow (should be included)
        { from: 'relay.agent.ns-a.*', to: 'relay.agent.ns-b.*', action: 'allow', priority: 50 },
        // Cross-namespace deny catch-all (not in relay.agent.{ns}.* format for target)
        { from: 'relay.agent.ns-a.*', to: 'relay.agent.>', action: 'deny', priority: 10 },
      ]);
      const tm = new TopologyManager(makeMockRegistry() as never, makeMockRelayBridge() as never, relay as never);

      const rules = tm.listCrossNamespaceRules();

      expect(rules).toHaveLength(1);
      expect(rules[0]).toEqual({
        sourceNamespace: 'ns-a',
        targetNamespace: 'ns-b',
        action: 'allow',
      });
    });

    it('returns empty array when relayCore is undefined', () => {
      const tm = new TopologyManager(makeMockRegistry() as never, makeMockRelayBridge() as never, undefined);

      expect(tm.listCrossNamespaceRules()).toEqual([]);
    });

    it('returns empty array when there are no cross-namespace rules', () => {
      const relay = makeMockRelayCore([
        { from: 'relay.agent.ns-a.*', to: 'relay.agent.ns-a.*', action: 'allow', priority: 100 },
      ]);
      const tm = new TopologyManager(makeMockRegistry() as never, makeMockRelayBridge() as never, relay as never);

      expect(tm.listCrossNamespaceRules()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // No Relay scenario
  // ---------------------------------------------------------------------------

  describe('without RelayCore', () => {
    it('getTopology returns only caller own namespace', () => {
      const registry = makeMockRegistry([agentA1, agentB1]);
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, undefined);

      const view = tm.getTopology('ns-a');

      expect(view.namespaces).toHaveLength(1);
      expect(view.namespaces[0]!.namespace).toBe('ns-a');
    });

    it('getTopology returns empty access rules', () => {
      const registry = makeMockRegistry([agentA1]);
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, undefined);

      const view = tm.getTopology('ns-a');

      expect(view.accessRules).toEqual([]);
    });

    it('getAgentAccess returns only same-namespace agents', () => {
      const registry = makeMockRegistry([agentA1, agentA2, agentB1]);
      const tm = new TopologyManager(registry as never, makeMockRelayBridge() as never, undefined);

      const reachable = tm.getAgentAccess('A1');

      expect(reachable).toBeDefined();
      expect(reachable!.map((a) => a.id)).toEqual(['A2']);
    });
  });
});
