import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcile } from '../reconciler.js';
import type { ReconcilerDeps } from '../reconciler.js';
import type { AgentRegistry, AgentRegistryEntry } from '../agent-registry.js';
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
    personaEnabled: true,
    ...overrides,
  };
}

type MockRegistry = {
  [K in keyof AgentRegistry]: ReturnType<typeof vi.fn>;
};

function createMockRegistry(): MockRegistry {
  return {
    list: vi.fn().mockReturnValue([]),
    listUnreachable: vi.fn().mockReturnValue([]),
    listUnreachableBefore: vi.fn().mockReturnValue([]),
    markUnreachable: vi.fn().mockReturnValue(true),
    markReachable: vi.fn().mockReturnValue(true),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconcile()', () => {
  let registry: ReturnType<typeof createMockRegistry>;
  let removeAgent: ReturnType<typeof vi.fn>;
  let deps: ReconcilerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = createMockRegistry();
    removeAgent = vi.fn().mockResolvedValue(undefined);
    deps = {
      registry: registry as unknown as AgentRegistry,
      defaultScanRoot: '/root',
      removeAgent,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
  });

  it('marks agents with missing paths as unreachable', async () => {
    registry.list.mockReturnValue([makeEntry({ id: 'a1', projectPath: '/gone' })]);
    vi.mocked(fsPromises.access).mockRejectedValue(new Error('ENOENT'));

    const result = await reconcile(deps);
    expect(result.unreachable).toBe(1);
    expect(registry.markUnreachable).toHaveBeenCalledWith('a1');
  });

  it('does not re-mark already unreachable agents', async () => {
    const entry = makeEntry({ id: 'a1', projectPath: '/gone' });
    registry.list.mockReturnValue([entry]);
    registry.listUnreachable.mockReturnValue([entry]);
    vi.mocked(fsPromises.access).mockRejectedValue(new Error('ENOENT'));

    const result = await reconcile(deps);
    expect(result.unreachable).toBe(0);
    expect(registry.markUnreachable).not.toHaveBeenCalled();
  });

  it('syncs updated manifest fields to DB', async () => {
    registry.list.mockReturnValue([
      makeEntry({
        id: 'a1',
        name: 'Old',
        projectPath: '/root/proj/backend',
        scanRoot: '/root/proj',
      }),
    ]);
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(manifestModule.readManifest).mockResolvedValue(
      makeManifest({ id: 'a1', name: 'New' })
    );

    const result = await reconcile(deps);
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
      })
    );

    const result = await reconcile(deps);
    expect(result.synced).toBe(0);
    expect(registry.update).not.toHaveBeenCalled();
  });

  it('skips agents with corrupt/unparseable manifests', async () => {
    registry.list.mockReturnValue([makeEntry({ id: 'a1', projectPath: '/exists' })]);
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(manifestModule.readManifest).mockResolvedValue(null);

    const result = await reconcile(deps);
    expect(result.synced).toBe(0);
    expect(result.unreachable).toBe(0);
  });

  it('handles empty registry gracefully', async () => {
    registry.list.mockReturnValue([]);
    registry.listUnreachableBefore.mockReturnValue([]);

    const result = await reconcile(deps);
    expect(result).toEqual({
      synced: 0,
      unreachable: 0,
      removed: 0,
      resurrected: 0,
      discovered: 0,
    });
  });

  it('syncs persona/color/icon fields from disk to DB (ADR-0043)', async () => {
    const entry = makeEntry({
      id: 'a1',
      projectPath: '/root/proj/backend',
      scanRoot: '/root/proj',
    });
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
        persona: 'You are a backend expert',
        color: '#ff0000',
        icon: 'server',
      })
    );

    const result = await reconcile(deps);
    expect(result.synced).toBe(1);
    expect(registry.update).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({
        persona: 'You are a backend expert',
        color: '#ff0000',
        icon: 'server',
      })
    );
  });

  it('does not sync when only non-compared fields differ', async () => {
    const entry = makeEntry({
      id: 'a1',
      projectPath: '/exists',
      persona: 'same persona',
      personaEnabled: true,
      color: '#000',
      icon: 'code',
    });
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
        persona: 'same persona',
        personaEnabled: true,
        color: '#000',
        icon: 'code',
      })
    );

    const result = await reconcile(deps);
    expect(result.synced).toBe(0);
    expect(registry.update).not.toHaveBeenCalled();
  });

  describe('grace-period sweep removal', () => {
    it('routes removal through the unregister cascade with the recorded entry', async () => {
      registry.list.mockReturnValue([]);
      const oldEntry = makeEntry({ id: 'old', namespace: 'ns1', projectPath: '/vanished/agent' });
      registry.listUnreachableBefore.mockReturnValue([oldEntry]);
      vi.mocked(fsPromises.access).mockRejectedValue(new Error('ENOENT'));

      const result = await reconcile(deps);

      expect(result.removed).toBe(1);
      // The cleanup hook receives the full entry — including the recorded
      // projectPath — even though the path itself is inaccessible.
      expect(removeAgent).toHaveBeenCalledOnce();
      expect(removeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'old', projectPath: '/vanished/agent' })
      );
      // The reconciler never removes directly; the cascade owns that.
      expect(registry.remove).not.toHaveBeenCalled();
    });

    it('isolates per-agent removal failures so one bad agent does not abort the sweep', async () => {
      registry.list.mockReturnValue([]);
      const bad = makeEntry({ id: 'bad', projectPath: '/gone/bad' });
      const good = makeEntry({ id: 'good', projectPath: '/gone/good' });
      registry.listUnreachableBefore.mockReturnValue([bad, good]);
      vi.mocked(fsPromises.access).mockRejectedValue(new Error('ENOENT'));
      removeAgent.mockRejectedValueOnce(new Error('relay boom'));

      const result = await reconcile(deps);

      expect(removeAgent).toHaveBeenCalledTimes(2);
      expect(removeAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'good' }));
      // Only the successful removal is counted.
      expect(result.removed).toBe(1);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ agentId: 'bad' })
      );
    });
  });

  describe('resurrection of unreachable agents', () => {
    it('clears unreachable status when a missing path comes back', async () => {
      const entry = makeEntry({ id: 'a1', projectPath: '/volume/back' });
      registry.list.mockReturnValue([entry]);
      registry.listUnreachable.mockReturnValue([entry]);
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
        })
      );

      const result = await reconcile(deps);

      expect(result.resurrected).toBe(1);
      expect(registry.markReachable).toHaveBeenCalledWith('a1');
      expect(registry.markUnreachable).not.toHaveBeenCalled();
      expect(removeAgent).not.toHaveBeenCalled();
    });

    it('does not count a resurrection when the agent was concurrently removed', async () => {
      const entry = makeEntry({ id: 'a1', projectPath: '/volume/back' });
      registry.list.mockReturnValue([entry]);
      registry.listUnreachable.mockReturnValue([entry]);
      registry.markReachable.mockReturnValue(false); // row gone by update time
      vi.mocked(fsPromises.access).mockResolvedValue(undefined);
      vi.mocked(manifestModule.readManifest).mockResolvedValue(null);

      const result = await reconcile(deps);

      expect(registry.markReachable).toHaveBeenCalledWith('a1');
      expect(result.resurrected).toBe(0);
    });

    it('does not clear status for agents that were never unreachable', async () => {
      const entry = makeEntry({ id: 'a1', projectPath: '/still/here' });
      registry.list.mockReturnValue([entry]);
      registry.listUnreachable.mockReturnValue([]);
      vi.mocked(fsPromises.access).mockResolvedValue(undefined);
      vi.mocked(manifestModule.readManifest).mockResolvedValue(null);

      const result = await reconcile(deps);

      expect(result.resurrected).toBe(0);
      expect(registry.markReachable).not.toHaveBeenCalled();
    });

    it('resurrects expired agents whose path is accessible without firing the removal cascade', async () => {
      // Volume unmounted over a weekend (>24h grace) but remounted before the
      // sweep runs: the agent must be resurrected, not removed from DB + Relay,
      // and no unregister cleanup (task schedules, watchers) may fire.
      registry.list.mockReturnValue([]);
      const expired = makeEntry({ id: 'old', namespace: 'ns1', projectPath: '/volume/agent' });
      registry.listUnreachableBefore.mockReturnValue([expired]);
      vi.mocked(fsPromises.access).mockResolvedValue(undefined);

      const result = await reconcile(deps);

      expect(result.removed).toBe(0);
      expect(result.resurrected).toBe(1);
      expect(registry.markReachable).toHaveBeenCalledWith('old');
      expect(registry.remove).not.toHaveBeenCalled();
      expect(removeAgent).not.toHaveBeenCalled();
    });

    it('removes expired agents only when the path is still inaccessible', async () => {
      registry.list.mockReturnValue([]);
      const back = makeEntry({ id: 'back', namespace: 'ns1', projectPath: '/volume/back' });
      const gone = makeEntry({ id: 'gone', namespace: 'ns1', projectPath: '/volume/gone' });
      registry.listUnreachableBefore.mockReturnValue([back, gone]);
      vi.mocked(fsPromises.access).mockImplementation(async (p) => {
        if (p === '/volume/gone') throw new Error('ENOENT');
      });

      const result = await reconcile(deps);

      expect(result.resurrected).toBe(1);
      expect(result.removed).toBe(1);
      expect(registry.markReachable).toHaveBeenCalledWith('back');
      expect(removeAgent).toHaveBeenCalledOnce();
      expect(removeAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'gone' }));
    });
  });
});
