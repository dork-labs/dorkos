import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { AgentRegistry } from '../agent-registry.js';
import type { AgentRegistryEntry } from '../agent-registry.js';
import { ACTIVE_THRESHOLD_MINUTES, INACTIVE_THRESHOLD_MINUTES } from '../health.js';

/** Helper: create an ISO timestamp `minutes` before now. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    workspace: { mode: 'home' },
    id: '01JKABC00001',
    name: 'backend',
    description: 'Backend service agent',
    runtime: 'claude-code',
    capabilities: ['code-review', 'refactoring'],
    behavior: { responseMode: 'always' },
    personaEnabled: true,
    mcpServers: [],
    registeredAt: new Date().toISOString(),
    registeredBy: 'user',
    projectPath: '/home/user/projects/backend',
    namespace: '',
    scanRoot: '',
    ...overrides,
  };
}

let db: Db;
let registry: AgentRegistry;

beforeEach(() => {
  db = createTestDb();
  registry = new AgentRegistry(db);
});

// ---------------------------------------------------------------------------
// Insert and Get
// ---------------------------------------------------------------------------

describe('insert and get', () => {
  it('round-trips an agent entry by id', () => {
    // A non-default behavior, so a write that dropped it could not pass on the column default.
    const entry = makeEntry({ behavior: { responseMode: 'mention-only' } });
    registry.upsert(entry);

    const result = registry.get(entry.id);
    expect(result).toBeDefined();
    expect(result!.id).toBe(entry.id);
    expect(result!.name).toBe(entry.name);
    expect(result!.description).toBe(entry.description);
    expect(result!.runtime).toBe(entry.runtime);
    expect(result!.capabilities).toEqual(entry.capabilities);
    expect(result!.behavior).toEqual(entry.behavior);
    expect(result!.registeredAt).toBe(entry.registeredAt);
    expect(result!.registeredBy).toBe(entry.registeredBy);
    expect(result!.projectPath).toBe(entry.projectPath);
  });

  it('mirrors reportsTo and createdBy, and clears reportsTo on update', () => {
    // The reports-to chain is walked from this mirror (spec `heartbeats` §4.1).
    registry.upsert(makeEntry({ reportsTo: '01MANAGER', createdBy: 'install:abc' }));
    expect(registry.get('01JKABC00001')).toMatchObject({
      reportsTo: '01MANAGER',
      createdBy: 'install:abc',
    });

    registry.update('01JKABC00001', { reportsTo: null });
    const after = registry.get('01JKABC00001');
    expect(after?.reportsTo).toBeUndefined();
    expect(after?.createdBy).toBe('install:abc');
  });
});

// ---------------------------------------------------------------------------
// getByPath
// ---------------------------------------------------------------------------

describe('getByPath', () => {
  it('returns the correct agent for a project path', () => {
    const entry = makeEntry();
    registry.upsert(entry);

    const result = registry.getByPath(entry.projectPath);
    expect(result).toBeDefined();
    expect(result!.id).toBe(entry.id);
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('list', () => {
  it('returns all agents ordered by registered_at DESC', () => {
    const older = makeEntry({
      id: '01JKABC00001',
      projectPath: '/projects/older',
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = makeEntry({
      id: '01JKABC00002',
      projectPath: '/projects/newer',
      registeredAt: '2026-02-01T00:00:00.000Z',
    });

    registry.upsert(older);
    registry.upsert(newer);

    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe(newer.id);
    expect(all[1].id).toBe(older.id);
  });

  it('filters by runtime', () => {
    registry.upsert(makeEntry({ id: '01A', projectPath: '/p/a', runtime: 'claude-code' }));
    registry.upsert(makeEntry({ id: '01B', projectPath: '/p/b', runtime: 'cursor' }));

    const filtered = registry.list({ runtime: 'claude-code' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].runtime).toBe('claude-code');
  });

  it('filters by capability', () => {
    registry.upsert(
      makeEntry({ id: '01A', projectPath: '/p/a', capabilities: ['code-review', 'testing'] })
    );
    registry.upsert(makeEntry({ id: '01B', projectPath: '/p/b', capabilities: ['deployment'] }));

    const filtered = registry.list({ capability: 'code-review' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('01A');
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('update', () => {
  it('modifies mutable fields and returns true', () => {
    registry.upsert(makeEntry());

    const updated = registry.update('01JKABC00001', {
      name: 'updated-backend',
      description: 'Updated description',
      capabilities: ['new-cap'],
    });

    expect(updated).toBe(true);

    const result = registry.get('01JKABC00001');
    expect(result!.name).toBe('updated-backend');
    expect(result!.description).toBe('Updated description');
    expect(result!.capabilities).toEqual(['new-cap']);
  });

  it('persists namespace, scanRoot and behavior changes', () => {
    registry.upsert(
      makeEntry({ id: 'a1', projectPath: '/p/a1', namespace: 'old', scanRoot: '/old' })
    );
    registry.update('a1', {
      namespace: 'new',
      scanRoot: '/new',
      behavior: { responseMode: 'mention-only' },
    });
    const entry = registry.get('a1');
    expect(entry?.namespace).toBe('new');
    expect(entry?.scanRoot).toBe('/new');
    expect(entry?.behavior.responseMode).toBe('mention-only');
  });
});

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

describe('remove', () => {
  it('deletes the agent and returns true', () => {
    registry.upsert(makeEntry());
    expect(registry.remove('01JKABC00001')).toBe(true);
    expect(registry.get('01JKABC00001')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

describe('upsert()', () => {
  it('inserts new agent when no conflict exists', () => {
    registry.upsert(makeEntry({ id: 'agent-1', projectPath: '/path/a' }));
    expect(registry.get('agent-1')).toBeDefined();
  });

  it('updates existing agent when same ID re-registered', () => {
    registry.upsert(makeEntry({ id: 'agent-1', name: 'V1', projectPath: '/path/a' }));
    registry.upsert(makeEntry({ id: 'agent-1', name: 'V2', projectPath: '/path/a' }));
    expect(registry.get('agent-1')?.name).toBe('V2');
    expect(registry.list()).toHaveLength(1);
  });

  it('writes nothing when the same agent is registered again (DOR-2900)', async () => {
    // The reconciler re-reads every manifest every five minutes.
    const { agents } = await import('@dorkos/db');
    const { eq } = await import('drizzle-orm');
    const stamp = () => db.select().from(agents).where(eq(agents.id, 'agent-1')).get()!.updatedAt;
    registry.upsert(makeEntry({ id: 'agent-1', projectPath: '/path/a' }));
    const first = stamp();
    await new Promise((resolve) => setTimeout(resolve, 5));

    registry.upsert(makeEntry({ id: 'agent-1', projectPath: '/path/a' }));
    expect(stamp()).toBe(first);

    registry.upsert(makeEntry({ id: 'agent-1', name: 'renamed', projectPath: '/path/a' }));
    expect(stamp()).not.toBe(first);
    expect(registry.get('agent-1')?.name).toBe('renamed');
  });

  it.each<[string, Partial<AgentRegistryEntry>]>([
    ['model', { model: 'opus' }],
    ['account', { account: 'claude3' }],
    ['capabilities', { capabilities: ['code-review'] }],
    ['isSystem', { isSystem: true }],
    ['personaEnabled', { personaEnabled: false }],
    ['description', { description: 'Something else' }],
  ])('still writes a change to %s', (_column, change) => {
    registry.upsert(makeEntry({ id: 'agent-1', projectPath: '/path/a' }));
    registry.upsert(makeEntry({ id: 'agent-1', projectPath: '/path/a', ...change }));
    expect(registry.get('agent-1')).toMatchObject(change);
  });

  it('still clears unreachable when an unchanged agent registers again', () => {
    registry.upsert(makeEntry({ id: 'agent-1', projectPath: '/path/a' }));
    registry.markUnreachable('agent-1');
    registry.upsert(makeEntry({ id: 'agent-1', projectPath: '/path/a' }));
    expect(registry.getAggregateStats().unreachableCount).toBe(0);
  });

  it('replaces stale entry when different ID registered at same path', () => {
    registry.upsert(makeEntry({ id: 'old-id', projectPath: '/same/path' }));
    registry.upsert(makeEntry({ id: 'new-id', projectPath: '/same/path' }));
    expect(registry.get('old-id')).toBeUndefined();
    expect(registry.get('new-id')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// rowToEntry round-trip
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Health Tracking
// ---------------------------------------------------------------------------

describe('health tracking', () => {
  it('updateHealth() sets last_seen_at and last_seen_event', () => {
    registry.upsert(makeEntry());
    const now = new Date().toISOString();
    const updated = registry.updateHealth('01JKABC00001', now, 'heartbeat');
    expect(updated).toBe(true);
    const entry = registry.getWithHealth('01JKABC00001');
    expect(entry!.lastSeenAt).toBe(now);
    expect(entry!.lastSeenEvent).toBe('heartbeat');
  });

  it('getWithHealth() computes active status for recent timestamp', () => {
    registry.upsert(makeEntry());
    registry.updateHealth('01JKABC00001', minutesAgo(ACTIVE_THRESHOLD_MINUTES / 2), 'message');
    const entry = registry.getWithHealth('01JKABC00001');
    expect(entry!.healthStatus).toBe('active');
  });

  it('getWithHealth() computes inactive status beyond active threshold', () => {
    registry.upsert(makeEntry());
    const midpoint = (ACTIVE_THRESHOLD_MINUTES + INACTIVE_THRESHOLD_MINUTES) / 2;
    registry.updateHealth('01JKABC00001', minutesAgo(midpoint), 'message');
    const entry = registry.getWithHealth('01JKABC00001');
    expect(entry!.healthStatus).toBe('inactive');
  });

  it('getAggregateStats() returns correct counts', () => {
    const agent1 = makeEntry({ id: 'agent1', projectPath: '/p/1' });
    const agent2 = makeEntry({ id: 'agent2', projectPath: '/p/2' });
    const agent3 = makeEntry({ id: 'agent3', projectPath: '/p/3' });
    registry.upsert(agent1);
    registry.upsert(agent2);
    registry.upsert(agent3);
    registry.updateHealth('agent1', minutesAgo(1), 'recent'); // active
    const midpoint = (ACTIVE_THRESHOLD_MINUTES + INACTIVE_THRESHOLD_MINUTES) / 2;
    registry.updateHealth('agent2', minutesAgo(midpoint), 'old'); // inactive
    // agent3 has no last_seen_at -> stale
    const stats = registry.getAggregateStats();
    expect(stats.totalAgents).toBe(3);
    expect(stats.activeCount).toBe(1);
    expect(stats.inactiveCount).toBe(1);
    expect(stats.staleCount).toBe(1);
    expect(stats.unreachableCount).toBe(0);
  });

  it('getAggregateStats() counts unreachable agents separately', () => {
    registry.upsert(makeEntry({ id: 'a1', projectPath: '/p/1' }));
    registry.upsert(makeEntry({ id: 'a2', projectPath: '/p/2' }));
    registry.upsert(makeEntry({ id: 'a3', projectPath: '/p/3' }));
    registry.updateHealth('a1', minutesAgo(1), 'recent'); // active
    registry.markUnreachable('a2');
    registry.markUnreachable('a3');
    const stats = registry.getAggregateStats();
    expect(stats.totalAgents).toBe(3);
    expect(stats.activeCount).toBe(1);
    expect(stats.unreachableCount).toBe(2);
    expect(stats.staleCount).toBe(0);
  });

  it('listWithHealth() reports unreachable agents as unreachable, not active/stale', () => {
    registry.upsert(makeEntry({ id: 'a1', projectPath: '/p/1' }));
    registry.upsert(makeEntry({ id: 'a2', projectPath: '/p/2' }));
    // a1 was seen recently but its path is gone — status column wins
    registry.updateHealth('a1', minutesAgo(1), 'heartbeat');
    registry.markUnreachable('a1');

    const byId = new Map(registry.listWithHealth().map((e) => [e.id, e]));
    expect(byId.get('a1')!.healthStatus).toBe('unreachable');
    expect(byId.get('a2')!.healthStatus).toBe('stale');

    // Consistency with the aggregate view exposed via /api/mesh/status
    const stats = registry.getAggregateStats();
    expect(stats.unreachableCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Anti-regression: Drizzle migration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// markUnreachable
// ---------------------------------------------------------------------------

describe('markUnreachable()', () => {
  it('sets status to unreachable and updates timestamp', () => {
    registry.upsert(makeEntry({ id: 'a1', projectPath: '/p/a1' }));
    const result = registry.markUnreachable('a1');
    expect(result).toBe(true);
    const unreachable = registry.listUnreachable();
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0].id).toBe('a1');
  });
});

// ---------------------------------------------------------------------------
// markReachable
// ---------------------------------------------------------------------------

describe('markReachable()', () => {
  it('clears unreachable status so the agent is no longer a removal candidate', () => {
    registry.upsert(makeEntry({ id: 'a1', projectPath: '/p/a1' }));
    registry.markUnreachable('a1');
    expect(registry.listUnreachable()).toHaveLength(1);

    const result = registry.markReachable('a1');
    expect(result).toBe(true);
    expect(registry.listUnreachable()).toHaveLength(0);
    const future = new Date(Date.now() + 100000).toISOString();
    expect(registry.listUnreachableBefore(future)).toHaveLength(0);
  });

  it('restores health computation from lastSeenAt', () => {
    registry.upsert(makeEntry({ id: 'a1', projectPath: '/p/a1' }));
    registry.updateHealth('a1', minutesAgo(1), 'heartbeat');
    registry.markUnreachable('a1');
    expect(registry.getWithHealth('a1')!.healthStatus).toBe('unreachable');

    registry.markReachable('a1');
    expect(registry.getWithHealth('a1')!.healthStatus).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// listUnreachableBefore
// ---------------------------------------------------------------------------

describe('listUnreachableBefore()', () => {
  it('returns only unreachable agents with updatedAt before cutoff', () => {
    registry.upsert(makeEntry({ id: 'a1', projectPath: '/p/a1' }));
    registry.upsert(makeEntry({ id: 'a2', projectPath: '/p/a2' }));
    registry.markUnreachable('a1');
    registry.markUnreachable('a2');
    // Cutoff in the future — both should be returned
    const future = new Date(Date.now() + 100000).toISOString();
    const expired = registry.listUnreachableBefore(future);
    expect(expired).toHaveLength(2);
  });

  it('excludes active agents and recently-unreachable agents', () => {
    registry.upsert(makeEntry({ id: 'active-agent', projectPath: '/p/active' }));
    registry.upsert(makeEntry({ id: 'unreachable-agent', projectPath: '/p/unreachable' }));
    registry.markUnreachable('unreachable-agent');
    // Cutoff in the past — recently-unreachable agent should NOT be returned
    const past = new Date(Date.now() - 100000).toISOString();
    const expired = registry.listUnreachableBefore(past);
    expect(expired).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Agent Identity Fields (persona, personaEnabled, color, icon)
// ---------------------------------------------------------------------------

describe('agent identity fields', () => {
  it('upsert stores persona, personaEnabled, color, icon from manifest', () => {
    registry.upsert(
      makeEntry({
        id: 'identity-agent',
        projectPath: '/p/identity',
        persona: 'You are backend-bot.',
        personaEnabled: true,
        color: '#6366f1',
        icon: '🤖',
      })
    );

    const result = registry.get('identity-agent');
    expect(result).toBeDefined();
    expect(result!.persona).toBe('You are backend-bot.');
    expect(result!.personaEnabled).toBe(true);
    expect(result!.color).toBe('#6366f1');
    expect(result!.icon).toBe('🤖');
  });

  it('update persists identity field changes', () => {
    registry.upsert(makeEntry({ id: 'update-agent', projectPath: '/p/update' }));
    registry.update('update-agent', {
      persona: 'New persona text',
      personaEnabled: false,
      color: '#ef4444',
      icon: '🎯',
    });
    const result = registry.get('update-agent');
    expect(result!.persona).toBe('New persona text');
    expect(result!.personaEnabled).toBe(false);
    expect(result!.color).toBe('#ef4444');
    expect(result!.icon).toBe('🎯');
  });

  it('update clears identity fields when set to undefined/null', () => {
    registry.upsert(
      makeEntry({
        id: 'clear-agent',
        projectPath: '/p/clear',
        persona: 'old persona',
        color: '#000',
        icon: '🎉',
      })
    );
    registry.update('clear-agent', {
      persona: undefined,
      color: undefined,
      icon: undefined,
    });
    const result = registry.get('clear-agent');
    expect(result!.persona).toBeUndefined();
    expect(result!.color).toBeUndefined();
    expect(result!.icon).toBeUndefined();
  });

  it('upsert on conflict updates identity fields', () => {
    registry.upsert(
      makeEntry({
        id: 'conflict-agent',
        projectPath: '/p/conflict',
        persona: 'V1 persona',
        color: '#000',
      })
    );
    registry.upsert(
      makeEntry({
        id: 'conflict-agent',
        projectPath: '/p/conflict',
        persona: 'V2 persona',
        color: '#fff',
        icon: '🚀',
      })
    );
    const result = registry.get('conflict-agent');
    expect(result!.persona).toBe('V2 persona');
    expect(result!.color).toBe('#fff');
    expect(result!.icon).toBe('🚀');
  });
});

// ---------------------------------------------------------------------------
// Execution defaults (spec `execution-defaults` E2)
// ---------------------------------------------------------------------------

describe('execution defaults on the cache', () => {
  it("round-trips an agent's model and effort, so a list can answer for them", () => {
    // The Settings exceptions strip names every agent that differs from the
    // server default. It reads the agent LIST — which is this cache — so a
    // column that stopped at the manifest would make that view impossible
    // without opening every agent.json on disk.
    registry.upsert(makeEntry({ model: 'sonnet', effort: 'low' }));

    expect(registry.get('01JKABC00001')?.model).toBe('sonnet');
    expect(registry.get('01JKABC00001')?.effort).toBe('low');
    expect(registry.list()[0].model).toBe('sonnet');
    expect(registry.list()[0].effort).toBe('low');
  });

  it('clears them when an update drops them', () => {
    registry.upsert(makeEntry({ model: 'sonnet', effort: 'low' }));
    registry.update('01JKABC00001', { model: undefined, effort: undefined });
    expect(registry.get('01JKABC00001')?.model).toBeUndefined();
    expect(registry.get('01JKABC00001')?.effort).toBeUndefined();
  });

  it('reads an unrecognized stored effort as no preference rather than passing it on', () => {
    // A rung a later release drops, or a hand-edited row. "No preference" is the
    // safe answer; handing a word no adapter knows to a runtime is not.
    registry.upsert(makeEntry({ effort: 'high' }));
    db.run?.(`UPDATE agents SET effort = 'ludicrous' WHERE id = '01JKABC00001'`);
    expect(registry.get('01JKABC00001')?.effort).toBeUndefined();
  });
});
