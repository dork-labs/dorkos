import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcile } from '../reconciler.js';
import type { AgentRegistry, AgentRegistryEntry } from '../agent-registry.js';
import type { RelayBridge } from '../relay-bridge.js';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import * as fsPromises from 'node:fs/promises';
import * as manifestModule from '../manifest.js';

vi.mock('node:fs/promises');
vi.mock('../manifest.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    id: '01JKABC00001',
    name: 'backend',
    description: 'Backend service agent',
    runtime: 'claude-code',
    capabilities: ['code-review'],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: new Date().toISOString(),
    registeredBy: 'user',
    projectPath: '/home/user/projects/backend',
    namespace: 'default',
    scanRoot: '',
    ...overrides,
  };
}

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: '01JKABC00001',
    name: 'backend',
    description: 'Backend service agent',
    runtime: 'claude-code',
    capabilities: ['code-review'],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: new Date().toISOString(),
    registeredBy: 'user',
    ...overrides,
  };
}

type MockRegistry = {
  [K in keyof AgentRegistry]: ReturnType<typeof vi.fn>;
};

type MockRelayBridge = {
  [K in keyof RelayBridge]: ReturnType<typeof vi.fn>;
};

function createMockRegistry(): MockRegistry {
  return {
    list: vi.fn().mockReturnValue([]),
    listUnreachable: vi.fn().mockReturnValue([]),
    listUnreachableBefore: vi.fn().mockReturnValue([]),
    markUnreachable: vi.fn().mockReturnValue(true),
    update: vi.fn().mockReturnValue(true),
    remove: vi.fn().mockReturnValue(true),
    get: vi.fn(),
    getByPath: vi.fn(),
    upsert: vi.fn(),
    listWithHealth: vi.fn().mockReturnValue([]),
    getWithHealth: vi.fn(),
    updateHealth: vi.fn().mockReturnValue(true),
    getAggregateStats: vi.fn(),
    listByNamespace: vi.fn().mockReturnValue([]),
  };
}

function createMockRelayBridge(): MockRelayBridge {
  return {
    registerAgent: vi.fn().mockResolvedValue(null),
    unregisterAgent: vi.fn().mockResolvedValue(undefined),
    cleanupNamespaceRules: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconcile()', () => {
  let registry: ReturnType<typeof createMockRegistry>;
  let relayBridge: ReturnType<typeof createMockRelayBridge>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = createMockRegistry();
    relayBridge = createMockRelayBridge();
  });

  it('marks agents with missing paths as unreachable', async () => {
    registry.list.mockReturnValue([makeEntry({ id: 'a1', projectPath: '/gone' })]);
    vi.mocked(fsPromises.access).mockRejectedValue(new Error('ENOENT'));

    const result = await reconcile(registry as unknown as AgentRegistry, relayBridge as unknown as RelayBridge, '/root');
    expect(result.unreachable).toBe(1);
    expect(registry.markUnreachable).toHaveBeenCalledWith('a1');
  });

  it('does not re-mark already unreachable agents', async () => {
    const entry = makeEntry({ id: 'a1', projectPath: '/gone' });
    registry.list.mockReturnValue([entry]);
    registry.listUnreachable.mockReturnValue([entry]);
    vi.mocked(fsPromises.access).mockRejectedValue(new Error('ENOENT'));

    const result = await reconcile(registry as unknown as AgentRegistry, relayBridge as unknown as RelayBridge, '/root');
    expect(result.unreachable).toBe(0);
    expect(registry.markUnreachable).not.toHaveBeenCalled();
  });

  it('syncs updated manifest fields to DB', async () => {
    registry.list.mockReturnValue([makeEntry({ id: 'a1', name: 'Old', projectPath: '/root/proj/backend', scanRoot: '/root/proj' })]);
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(manifestModule.readManifest).mockResolvedValue(
      makeManifest({ id: 'a1', name: 'New' }),
    );

    const result = await reconcile(registry as unknown as AgentRegistry, relayBridge as unknown as RelayBridge, '/root');
    expect(result.synced).toBe(1);
    expect(registry.update).toHaveBeenCalledWith('a1', expect.objectContaining({ name: 'New' }));
  });

  it('does not sync when manifest matches entry', async () => {
    const entry = makeEntry({ id: 'a1', projectPath: '/exists' });
    registry.list.mockReturnValue([entry]);
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(manifestModule.readManifest).mockResolvedValue(
      makeManifest({
        id: 'a1',
        name: entry.name,
        description: entry.description,
        runtime: entry.runtime,
        capabilities: entry.capabilities,
        behavior: entry.behavior,
        budget: entry.budget,
      }),
    );

    const result = await reconcile(registry as unknown as AgentRegistry, relayBridge as unknown as RelayBridge, '/root');
    expect(result.synced).toBe(0);
    expect(registry.update).not.toHaveBeenCalled();
  });

  it('auto-removes unreachable agents past 24h grace period', async () => {
    registry.list.mockReturnValue([]);
    const oldEntry = makeEntry({ id: 'old', namespace: 'ns1' });
    registry.listUnreachableBefore.mockReturnValue([oldEntry]);

    const result = await reconcile(registry as unknown as AgentRegistry, relayBridge as unknown as RelayBridge, '/root');
    expect(result.removed).toBe(1);
    expect(relayBridge.unregisterAgent).toHaveBeenCalledWith(
      'relay.agent.ns1.old',
      'old',
      oldEntry.name,
    );
    expect(registry.remove).toHaveBeenCalledWith('old');
  });

  it('skips agents with corrupt/unparseable manifests', async () => {
    registry.list.mockReturnValue([makeEntry({ id: 'a1', projectPath: '/exists' })]);
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(manifestModule.readManifest).mockResolvedValue(null);

    const result = await reconcile(registry as unknown as AgentRegistry, relayBridge as unknown as RelayBridge, '/root');
    expect(result.synced).toBe(0);
    expect(result.unreachable).toBe(0);
  });

  it('handles empty registry gracefully', async () => {
    registry.list.mockReturnValue([]);
    registry.listUnreachableBefore.mockReturnValue([]);

    const result = await reconcile(registry as unknown as AgentRegistry, relayBridge as unknown as RelayBridge, '/root');
    expect(result).toEqual({ synced: 0, unreachable: 0, removed: 0, discovered: 0 });
  });
});
