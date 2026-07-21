import { describe, it, expect, vi } from 'vitest';
import { TopologyManager } from '../topology.js';
import type { AgentRegistryEntry } from '../agent-registry.js';
import type { NamespaceRule, NamespaceRuleStoreLike } from '../namespace-rule-store.js';

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

/** In-memory fake of the Mesh namespace-rule store for topology unit tests. */
function makeFakeRuleStore(initial: NamespaceRule[] = []): NamespaceRuleStoreLike {
  const rules: NamespaceRule[] = [...initial];
  return {
    list: () => rules.map((r) => ({ ...r })),
    has: (s, t) => rules.some((r) => r.sourceNamespace === s && r.targetNamespace === t),
    add: (s, t) => {
      if (!rules.some((r) => r.sourceNamespace === s && r.targetNamespace === t)) {
        rules.push({ sourceNamespace: s, targetNamespace: t });
      }
    },
    remove: (s, t) => {
      const i = rules.findIndex((r) => r.sourceNamespace === s && r.targetNamespace === t);
      if (i >= 0) rules.splice(i, 1);
    },
  };
}

/** Construct a TopologyManager with a fresh fake rule store (mesh #16). */
function makeTopology(
  registry: unknown,
  relay?: unknown,
  store: NamespaceRuleStoreLike = makeFakeRuleStore()
): TopologyManager {
  return new TopologyManager(
    registry as never,
    makeMockRelayBridge() as never,
    store,
    relay as never
  );
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
      const tm = makeTopology(registry, relay);

      const view = tm.getTopology('ns-a');

      expect(view.callerNamespace).toBe('ns-a');
      expect(view.namespaces).toHaveLength(1);
      expect(view.namespaces[0]!.namespace).toBe('ns-a');
      expect(view.namespaces[0]!.agentCount).toBe(2);
    });

    it('returns all namespaces for admin view (*)', () => {
      const registry = makeMockRegistry([agentA1, agentB1, agentC1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      const view = tm.getTopology('*');

      expect(view.callerNamespace).toBe('*');
      expect(view.namespaces).toHaveLength(3);
      const nsNames = view.namespaces.map((ns) => ns.namespace).sort();
      expect(nsNames).toEqual(['ns-a', 'ns-b', 'ns-c']);
    });

    it('includes cross-namespace agents after allowCrossNamespace', () => {
      const registry = makeMockRegistry([agentA1, agentB1, agentC1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      tm.allowCrossNamespace('ns-a', 'ns-b');

      const view = tm.getTopology('ns-a');

      expect(view.namespaces).toHaveLength(2);
      const nsNames = view.namespaces.map((ns) => ns.namespace).sort();
      expect(nsNames).toEqual(['ns-a', 'ns-b']);
    });

    it('hides namespace again after denyCrossNamespace', () => {
      const registry = makeMockRegistry([agentA1, agentB1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      tm.allowCrossNamespace('ns-a', 'ns-b');
      // Verify ns-b is now visible
      expect(tm.getTopology('ns-a').namespaces).toHaveLength(2);

      tm.denyCrossNamespace('ns-a', 'ns-b');

      const view = tm.getTopology('ns-a');
      expect(view.namespaces).toHaveLength(1);
      expect(view.namespaces[0]!.namespace).toBe('ns-a');
    });

    it('keeps projectPath but strips scanRoot from agent manifests', () => {
      const registry = makeMockRegistry([agentA1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      const view = tm.getTopology('ns-a');
      const agent = view.namespaces[0]!.agents[0]!;

      expect(agent).toHaveProperty('projectPath', '/p/a1');
      expect(agent).not.toHaveProperty('scanRoot');
      expect(agent.id).toBe('A1');
      expect(agent.name).toBe('agent-a1');
    });

    it('returns empty namespaces when caller has no agents', () => {
      const registry = makeMockRegistry([agentA1, agentB1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      const view = tm.getTopology('ns-unknown');

      expect(view.namespaces).toHaveLength(0);
    });

    it('includes access rules involving accessible namespaces', () => {
      const registry = makeMockRegistry([agentA1, agentB1, agentC1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      tm.allowCrossNamespace('ns-a', 'ns-b');
      tm.allowCrossNamespace('ns-b', 'ns-c');

      const view = tm.getTopology('ns-a');

      // ns-a can see ns-a and ns-b, so rules involving ns-a or ns-b are returned
      const ruleDescs = view.accessRules.map((r) => `${r.sourceNamespace}->${r.targetNamespace}`);
      expect(ruleDescs).toContain('ns-a->ns-b');
      // ns-b->ns-c involves ns-b which is accessible, so it should be included
      expect(ruleDescs).toContain('ns-b->ns-c');
    });

    it('admin view returns all explicit cross-namespace rules', () => {
      const registry = makeMockRegistry([agentA1, agentB1, agentC1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      tm.allowCrossNamespace('ns-a', 'ns-b');
      tm.allowCrossNamespace('ns-b', 'ns-c');

      const view = tm.getTopology('*');
      const explicitRules = view.accessRules.filter((r) => r.origin === 'explicit');

      expect(explicitRules).toHaveLength(2);
    });

    // -------------------------------------------------------------------------
    // DOR-336 — default (bridge-written) rules must be surfaced, not just
    // explicit allowCrossNamespace grants
    // -------------------------------------------------------------------------

    it('surfaces the bridge-written default same-namespace allow rule per namespace', () => {
      const registry = makeMockRegistry([agentA1, agentB1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      const view = tm.getTopology('*');

      expect(view.accessRules).toContainEqual({
        sourceNamespace: 'ns-a',
        targetNamespace: 'ns-a',
        action: 'allow',
        origin: 'default',
      });
      expect(view.accessRules).toContainEqual({
        sourceNamespace: 'ns-b',
        targetNamespace: 'ns-b',
        action: 'allow',
        origin: 'default',
      });
    });

    it('surfaces the bridge-written catch-all cross-namespace deny rule per namespace', () => {
      const registry = makeMockRegistry([agentA1, agentB1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      const view = tm.getTopology('*');

      expect(view.accessRules).toContainEqual({
        sourceNamespace: 'ns-a',
        targetNamespace: '*',
        action: 'deny',
        origin: 'default',
      });
      expect(view.accessRules).toContainEqual({
        sourceNamespace: 'ns-b',
        targetNamespace: '*',
        action: 'deny',
        origin: 'default',
      });
    });

    it('surfaces a system agent namespace as bidirectional allow, not a false deny', () => {
      // DorkBot (isSystem: true) exists in every install. RelayBridge.registerAgent()
      // writes a bidirectional allow at priority 200 for a system agent's namespace,
      // which outranks (and, for the forward direction, shares the exact same Relay
      // pattern as) the standard catch-all deny at priority 10 — so that deny is never
      // actually enforced for the system namespace. Surfacing it anyway would repeat
      // the DOR-336 bug class: a topology row that's confidently false.
      const dorkbot = makeEntry({
        id: 'DORKBOT01',
        name: 'DorkBot',
        namespace: 'system',
        projectPath: '/dork/agents/dorkbot',
        isSystem: true,
      });
      const registry = makeMockRegistry([dorkbot, agentA1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      const view = tm.getTopology('*');
      const systemRules = view.accessRules.filter(
        (r) =>
          r.origin === 'default' &&
          (r.sourceNamespace === 'system' || r.targetNamespace === 'system')
      );

      expect(systemRules).toContainEqual({
        sourceNamespace: 'system',
        targetNamespace: 'system',
        action: 'allow',
        origin: 'default',
      });
      expect(systemRules).toContainEqual({
        sourceNamespace: 'system',
        targetNamespace: '*',
        action: 'allow',
        origin: 'default',
      });
      expect(systemRules).toContainEqual({
        sourceNamespace: '*',
        targetNamespace: 'system',
        action: 'allow',
        origin: 'default',
      });
      // The catch-all deny is shadowed by the same-pattern allow above it and must
      // not appear — it would misreport the system namespace as blocked.
      expect(systemRules).not.toContainEqual(
        expect.objectContaining({ sourceNamespace: 'system', action: 'deny' })
      );

      // A non-system namespace elsewhere in the same view keeps its own, real deny.
      expect(view.accessRules).toContainEqual({
        sourceNamespace: 'ns-a',
        targetNamespace: '*',
        action: 'deny',
        origin: 'default',
      });
    });

    it('surfaces default rules alongside explicit grants, not instead of them', () => {
      const registry = makeMockRegistry([agentA1, agentB1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      tm.allowCrossNamespace('ns-a', 'ns-b');

      const view = tm.getTopology('*');

      expect(view.accessRules).toContainEqual({
        sourceNamespace: 'ns-a',
        targetNamespace: 'ns-b',
        action: 'allow',
        origin: 'explicit',
      });
      expect(view.accessRules).toContainEqual({
        sourceNamespace: 'ns-a',
        targetNamespace: 'ns-a',
        action: 'allow',
        origin: 'default',
      });
    });

    it('does not synthesize default rules when Relay is unavailable', () => {
      const registry = makeMockRegistry([agentA1]);
      const tm = makeTopology(registry, undefined);

      const view = tm.getTopology('*');

      expect(view.accessRules).toEqual([]);
    });

    it('scopes default rules to namespaces visible in a non-admin view', () => {
      const registry = makeMockRegistry([agentA1, agentB1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      const view = tm.getTopology('ns-a');
      const defaultSourceNamespaces = new Set(
        view.accessRules.filter((r) => r.origin === 'default').map((r) => r.sourceNamespace)
      );

      // ns-b is not visible from ns-a's view, so it must not get default rules either.
      expect(defaultSourceNamespaces).toEqual(new Set(['ns-a']));
    });
  });

  // ---------------------------------------------------------------------------
  // getAgentAccess
  // ---------------------------------------------------------------------------

  describe('getAgentAccess', () => {
    it('returns agents in accessible namespaces (excluding self)', () => {
      const registry = makeMockRegistry([agentA1, agentA2, agentB1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      const reachable = tm.getAgentAccess('A1');

      expect(reachable).toBeDefined();
      // A1 is in ns-a, can reach A2 (same ns) but not B1 (different ns)
      expect(reachable!.map((a) => a.id)).toEqual(['A2']);
    });

    it('includes cross-namespace agents after allowCrossNamespace', () => {
      const registry = makeMockRegistry([agentA1, agentB1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      tm.allowCrossNamespace('ns-a', 'ns-b');

      const reachable = tm.getAgentAccess('A1');

      expect(reachable).toBeDefined();
      expect(reachable!.map((a) => a.id)).toEqual(['B1']);
    });

    it('returns undefined for nonexistent agent', () => {
      const registry = makeMockRegistry([agentA1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

      const result = tm.getAgentAccess('nonexistent');

      expect(result).toBeUndefined();
    });

    it('does not include the agent itself in results', () => {
      const registry = makeMockRegistry([agentA1]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(registry, relay);

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
      const tm = makeTopology(makeMockRegistry(), relay);

      tm.allowCrossNamespace('ns-a', 'ns-b');

      expect(relay.addAccessRule).toHaveBeenCalledWith({
        from: 'relay.agent.ns-a.*',
        to: 'relay.agent.ns-b.*',
        action: 'allow',
        priority: 50,
      });
    });

    it('is a no-op when relayCore is undefined', () => {
      const tm = makeTopology(makeMockRegistry(), undefined);

      // Should not throw
      tm.allowCrossNamespace('ns-a', 'ns-b');
    });
  });

  describe('denyCrossNamespace', () => {
    it('calls relayCore.removeAccessRule for the source->target pattern', () => {
      const relay = makeMockRelayCore();
      const tm = makeTopology(makeMockRegistry(), relay);

      tm.denyCrossNamespace('ns-a', 'ns-b');

      expect(relay.removeAccessRule).toHaveBeenCalledWith(
        'relay.agent.ns-a.*',
        'relay.agent.ns-b.*'
      );
    });

    it('is a no-op when relayCore is undefined', () => {
      const tm = makeTopology(makeMockRegistry(), undefined);

      // Should not throw
      tm.denyCrossNamespace('ns-a', 'ns-b');
    });
  });

  // ---------------------------------------------------------------------------
  // listCrossNamespaceRules
  // ---------------------------------------------------------------------------

  describe('listCrossNamespaceRules', () => {
    it('reads rules from the Mesh store, never from Relay rule strings', () => {
      // The store is the sole source. Relay's rule strings are deliberately
      // set to something the OLD regex would have surfaced; topology must ignore
      // them entirely and reflect only the store.
      const store = makeFakeRuleStore([{ sourceNamespace: 'ns-a', targetNamespace: 'ns-b' }]);
      const relay = makeMockRelayCore([
        { from: 'relay.agent.ns-x.*', to: 'relay.agent.ns-y.*', action: 'allow', priority: 50 },
      ]);
      const tm = makeTopology(makeMockRegistry(), relay, store);

      const rules = tm.listCrossNamespaceRules();

      expect(rules).toEqual([
        { sourceNamespace: 'ns-a', targetNamespace: 'ns-b', action: 'allow', origin: 'explicit' },
      ]);
    });

    it('returns empty array when the store has no rules', () => {
      const tm = makeTopology(makeMockRegistry(), makeMockRelayCore());
      expect(tm.listCrossNamespaceRules()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // syncNamespaceRulesFromRelay — seed migration + projection (mesh #16)
  // ---------------------------------------------------------------------------

  describe('syncNamespaceRulesFromRelay', () => {
    it('seeds the store from existing Relay cross-namespace allow rules on first boot', () => {
      const store = makeFakeRuleStore();
      const relay = makeMockRelayCore([
        // Same-namespace allow — NOT a cross-namespace rule, must be skipped.
        { from: 'relay.agent.ns-a.*', to: 'relay.agent.ns-a.*', action: 'allow', priority: 100 },
        // A user cross-namespace allow — must be seeded.
        { from: 'relay.agent.ns-a.*', to: 'relay.agent.ns-b.*', action: 'allow', priority: 50 },
        // Catch-all cross-namespace deny — must be skipped.
        { from: 'relay.agent.ns-a.*', to: 'relay.agent.>', action: 'deny', priority: 10 },
        // System-agent (DorkBot) BIDIRECTIONAL bridge allows — provisioning-time
        // constants, not user rules: the `relay.agent.>` side does not match the
        // per-namespace pattern, so neither direction may leak into the store.
        { from: 'relay.agent.dorkbot-ns.*', to: 'relay.agent.>', action: 'allow', priority: 200 },
        { from: 'relay.agent.>', to: 'relay.agent.dorkbot-ns.*', action: 'allow', priority: 200 },
      ]);
      const tm = makeTopology(makeMockRegistry(), relay, store);

      tm.syncNamespaceRulesFromRelay();

      // Only the user cross-namespace allow is seeded — the system-agent bridge
      // rules are excluded in BOTH directions (scoping regression guard).
      expect(store.list()).toEqual([{ sourceNamespace: 'ns-a', targetNamespace: 'ns-b' }]);
    });

    it('does not re-seed when the store already has rules', () => {
      const store = makeFakeRuleStore([{ sourceNamespace: 'ns-c', targetNamespace: 'ns-d' }]);
      const relay = makeMockRelayCore([
        { from: 'relay.agent.ns-a.*', to: 'relay.agent.ns-b.*', action: 'allow', priority: 50 },
      ]);
      const tm = makeTopology(makeMockRegistry(), relay, store);

      tm.syncNamespaceRulesFromRelay();

      // The pre-existing store rule is preserved; the Relay-only rule is NOT imported.
      expect(store.list()).toEqual([{ sourceNamespace: 'ns-c', targetNamespace: 'ns-d' }]);
    });

    it('projects every store rule back into Relay (idempotent enforcement)', () => {
      const store = makeFakeRuleStore([{ sourceNamespace: 'ns-c', targetNamespace: 'ns-d' }]);
      const relay = makeMockRelayCore();
      const tm = makeTopology(makeMockRegistry(), relay, store);

      tm.syncNamespaceRulesFromRelay();

      expect(relay.addAccessRule).toHaveBeenCalledWith({
        from: 'relay.agent.ns-c.*',
        to: 'relay.agent.ns-d.*',
        action: 'allow',
        priority: 50,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // No Relay scenario
  // ---------------------------------------------------------------------------

  describe('without RelayCore', () => {
    it('getTopology returns only caller own namespace', () => {
      const registry = makeMockRegistry([agentA1, agentB1]);
      const tm = makeTopology(registry, undefined);

      const view = tm.getTopology('ns-a');

      expect(view.namespaces).toHaveLength(1);
      expect(view.namespaces[0]!.namespace).toBe('ns-a');
    });

    it('getTopology returns empty access rules', () => {
      const registry = makeMockRegistry([agentA1]);
      const tm = makeTopology(registry, undefined);

      const view = tm.getTopology('ns-a');

      expect(view.accessRules).toEqual([]);
    });

    it('getAgentAccess returns only same-namespace agents', () => {
      const registry = makeMockRegistry([agentA1, agentA2, agentB1]);
      const tm = makeTopology(registry, undefined);

      const reachable = tm.getAgentAccess('A1');

      expect(reachable).toBeDefined();
      expect(reachable!.map((a) => a.id)).toEqual(['A2']);
    });
  });
});
