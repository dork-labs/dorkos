/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { buildTopologyElements } from '../build-topology-elements';
import type { NamespaceInfo, CrossNamespaceRule } from '@dorkos/shared/mesh-schemas';
import type { AdapterListItem } from '@dorkos/shared/transport';

// Mock namespace-colors so tests are deterministic
vi.mock('../namespace-colors', () => ({
  getNamespaceColor: (idx: number) => `color-${idx}`,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseAgent = {
  description: '',
  behavior: { responseMode: 'always' as const },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2026-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
  relayAdapters: [],
  relaySubject: null,
  pulseScheduleCount: 0,
  lastSeenAt: null,
  lastSeenEvent: null,
};

const agent1: NamespaceInfo['agents'][number] = {
  ...baseAgent,
  id: 'agent-1',
  name: 'Builder',
  runtime: 'claude-code',
  capabilities: ['code'],
  healthStatus: 'active',
  projectPath: '/projects/builder',
};

const agent2: NamespaceInfo['agents'][number] = {
  ...baseAgent,
  id: 'agent-2',
  name: 'Writer',
  runtime: 'claude-code',
  capabilities: ['docs'],
  healthStatus: 'stale',
  projectPath: '/projects/writer',
};

const singleNamespace: NamespaceInfo[] = [
  { namespace: 'default', agentCount: 2, agents: [agent1, agent2] },
];

const multiNamespace: NamespaceInfo[] = [
  { namespace: 'production', agentCount: 1, agents: [agent1] },
  { namespace: 'staging', agentCount: 1, agents: [agent2] },
];

const noRules: CrossNamespaceRule[] = [];

const accessRules: CrossNamespaceRule[] = [
  { sourceNamespace: 'staging', targetNamespace: 'production', action: 'allow' },
  { sourceNamespace: 'production', targetNamespace: 'staging', action: 'deny' },
];

function emptyCallbacks() {
  return {
    onOpenSettings: vi.fn(),
    onSelectAgent: vi.fn(),
    onOpenChat: vi.fn(),
  };
}

function emptyBindingCountByAdapter() {
  return new Map<string, number>();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildTopologyElements', () => {
  describe('empty input', () => {
    it('returns empty result when namespaces array is empty', () => {
      const result = buildTopologyElements(
        [],
        noRules,
        false,
        undefined,
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      expect(result.rawNodes).toHaveLength(0);
      expect(result.rawEdges).toHaveLength(0);
      expect(result.legendEntries).toHaveLength(0);
      expect(result.useGroups).toBe(false);
    });
  });

  describe('single namespace', () => {
    it('creates agent nodes without group wrappers', () => {
      const result = buildTopologyElements(
        singleNamespace,
        noRules,
        false,
        undefined,
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const agentNodes = result.rawNodes.filter((n) => n.type === 'agent');
      const groupNodes = result.rawNodes.filter((n) => n.type === 'namespace-group');
      expect(agentNodes).toHaveLength(2);
      expect(groupNodes).toHaveLength(0);
      expect(result.useGroups).toBe(false);
    });

    it('does not set parentId on agent nodes in single-namespace topology', () => {
      const result = buildTopologyElements(
        singleNamespace,
        noRules,
        false,
        undefined,
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      for (const node of result.rawNodes) {
        expect(node.parentId).toBeUndefined();
      }
    });

    it('produces one legend entry per namespace', () => {
      const result = buildTopologyElements(
        singleNamespace,
        noRules,
        false,
        undefined,
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      expect(result.legendEntries).toHaveLength(1);
      expect(result.legendEntries[0].namespace).toBe('default');
    });
  });

  describe('multi namespace', () => {
    it('creates namespace-group nodes for each namespace', () => {
      const result = buildTopologyElements(
        multiNamespace,
        noRules,
        false,
        undefined,
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const groupNodes = result.rawNodes.filter((n) => n.type === 'namespace-group');
      expect(groupNodes).toHaveLength(2);
      expect(result.useGroups).toBe(true);
    });

    it('sets parentId on agent nodes to their group', () => {
      const result = buildTopologyElements(
        multiNamespace,
        noRules,
        false,
        undefined,
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const prodAgent = result.rawNodes.find((n) => n.id === 'agent-1');
      expect(prodAgent?.parentId).toBe('group:production');
      expect(prodAgent?.extent).toBe('parent');
    });

    it('creates cross-namespace allow edges', () => {
      const result = buildTopologyElements(
        multiNamespace,
        accessRules,
        false,
        undefined,
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const crossEdges = result.rawEdges.filter((e) => e.type === 'cross-namespace');
      expect(crossEdges).toHaveLength(1);
      expect(crossEdges[0].source).toBe('group:staging');
      expect(crossEdges[0].target).toBe('group:production');
    });

    it('creates cross-namespace deny edges', () => {
      const result = buildTopologyElements(
        multiNamespace,
        accessRules,
        false,
        undefined,
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const denyEdges = result.rawEdges.filter((e) => e.type === 'cross-namespace-deny');
      expect(denyEdges).toHaveLength(1);
      expect(denyEdges[0].source).toBe('group:production');
      expect(denyEdges[0].target).toBe('group:staging');
    });
  });

  describe('adapter nodes', () => {
    const adapter: AdapterListItem = {
      config: { id: 'tg-1', type: 'telegram', enabled: true, config: { token: 'test', mode: 'polling' } },
      status: {
        id: 'tg-1',
        type: 'telegram',
        displayName: 'Telegram Bot',
        state: 'connected',
        messageCount: { inbound: 0, outbound: 0 },
        errorCount: 0,
      },
    };

    it('creates adapter nodes when relay is enabled', () => {
      const result = buildTopologyElements(
        singleNamespace,
        noRules,
        true,
        [adapter],
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const adapterNodes = result.rawNodes.filter((n) => n.type === 'adapter');
      expect(adapterNodes).toHaveLength(1);
      expect(adapterNodes[0].id).toBe('adapter:tg-1');
    });

    it('does not create adapter nodes when relay is disabled', () => {
      const result = buildTopologyElements(
        singleNamespace,
        noRules,
        false,
        [adapter],
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const adapterNodes = result.rawNodes.filter((n) => n.type === 'adapter');
      expect(adapterNodes).toHaveLength(0);
    });

    it('maps connected state to running', () => {
      const result = buildTopologyElements(
        singleNamespace,
        noRules,
        true,
        [adapter],
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const node = result.rawNodes.find((n) => n.id === 'adapter:tg-1');
      expect((node?.data as Record<string, unknown>).adapterStatus).toBe('running');
    });

    it('maps error state to error', () => {
      const errAdapter: AdapterListItem = { ...adapter, status: { ...adapter.status, state: 'error' } };
      const result = buildTopologyElements(
        singleNamespace,
        noRules,
        true,
        [errAdapter],
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const node = result.rawNodes.find((n) => n.id === 'adapter:tg-1');
      expect((node?.data as Record<string, unknown>).adapterStatus).toBe('error');
    });

    it('maps other states to stopped', () => {
      const stoppedAdapter: AdapterListItem = { ...adapter, status: { ...adapter.status, state: 'disconnected' } };
      const result = buildTopologyElements(
        singleNamespace,
        noRules,
        true,
        [stoppedAdapter],
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const node = result.rawNodes.find((n) => n.id === 'adapter:tg-1');
      expect((node?.data as Record<string, unknown>).adapterStatus).toBe('stopped');
    });
  });

  describe('binding edges', () => {
    const adapter: AdapterListItem = {
      config: { id: 'tg-1', type: 'telegram', enabled: true, config: { token: 'test', mode: 'polling' } },
      status: {
        id: 'tg-1',
        type: 'telegram',
        displayName: 'Telegram Bot',
        state: 'connected',
        messageCount: { inbound: 0, outbound: 0 },
        errorCount: 0,
      },
    };

    const binding = {
      id: 'bind-1',
      adapterId: 'tg-1',
      agentId: 'agent-1',
      projectPath: '/projects/builder',
      sessionStrategy: 'per-chat' as const,
      label: 'Support',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    it('creates binding edges when relay is enabled and bindings exist', () => {
      const result = buildTopologyElements(
        singleNamespace,
        noRules,
        true,
        [adapter],
        [binding],
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const bindingEdges = result.rawEdges.filter((e) => e.type === 'binding');
      expect(bindingEdges).toHaveLength(1);
      expect(bindingEdges[0].source).toBe('adapter:tg-1');
      expect(bindingEdges[0].target).toBe('agent-1');
    });

    it('skips binding edges when adapter node is missing', () => {
      const result = buildTopologyElements(
        singleNamespace,
        noRules,
        true,
        undefined, // no adapters
        [binding],
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const bindingEdges = result.rawEdges.filter((e) => e.type === 'binding');
      expect(bindingEdges).toHaveLength(0);
    });

    it('skips binding edges when agent node is missing', () => {
      const orphanBinding = { ...binding, agentId: 'nonexistent' };
      const result = buildTopologyElements(
        singleNamespace,
        noRules,
        true,
        [adapter],
        [orphanBinding],
        emptyBindingCountByAdapter(),
        vi.fn(),
        emptyCallbacks(),
      );
      const bindingEdges = result.rawEdges.filter((e) => e.type === 'binding');
      expect(bindingEdges).toHaveLength(0);
    });
  });

  describe('callbacks', () => {
    it('injects onOpenSettings callback into agent node data', () => {
      const onOpenSettings = vi.fn();
      const result = buildTopologyElements(
        singleNamespace,
        noRules,
        false,
        undefined,
        undefined,
        emptyBindingCountByAdapter(),
        vi.fn(),
        { onOpenSettings, onSelectAgent: vi.fn(), onOpenChat: vi.fn() },
      );
      const agentNode = result.rawNodes.find((n) => n.id === 'agent-1');
      const data = agentNode?.data as Record<string, unknown>;
      (data.onOpenSettings as (id: string) => void)('agent-1');
      expect(onOpenSettings).toHaveBeenCalledWith('agent-1', '/projects/builder');
    });
  });
});
