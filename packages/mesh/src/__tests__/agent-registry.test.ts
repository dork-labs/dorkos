import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';
import { AgentRegistry } from '../agent-registry.js';
import type { AgentRegistryEntry } from '../agent-registry.js';
import { DenialList } from '../denial-list.js';
import { computeHealthStatus } from '../health.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    id: '01JKABC00001',
    name: 'backend',
    description: 'Backend service agent',
    runtime: 'claude-code',
    capabilities: ['code-review', 'refactoring'],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
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
    const entry = makeEntry();
    registry.upsert(entry);

    const result = registry.get(entry.id);
    expect(result).toBeDefined();
    expect(result!.id).toBe(entry.id);
    expect(result!.name).toBe(entry.name);
    expect(result!.description).toBe(entry.description);
    expect(result!.runtime).toBe(entry.runtime);
    expect(result!.capabilities).toEqual(entry.capabilities);
    expect(result!.behavior).toEqual(entry.behavior);
    expect(result!.budget).toEqual(entry.budget);
    expect(result!.registeredAt).toBe(entry.registeredAt);
    expect(result!.registeredBy).toBe(entry.registeredBy);
    expect(result!.projectPath).toBe(entry.projectPath);
  });

  it('returns undefined for non-existent id', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
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

  it('returns undefined for non-existent path', () => {
    expect(registry.getByPath('/nonexistent/path')).toBeUndefined();
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
      makeEntry({ id: '01A', projectPath: '/p/a', capabilities: ['code-review', 'testing'] }),
    );
    registry.upsert(
      makeEntry({ id: '01B', projectPath: '/p/b', capabilities: ['deployment'] }),
    );

    const filtered = registry.list({ capability: 'code-review' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('01A');
  });

  it('returns empty array when no agents exist', () => {
    expect(registry.list()).toEqual([]);
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

  it('returns false for non-existent id', () => {
    expect(registry.update('nonexistent', { name: 'new' })).toBe(false);
  });

  it('persists namespace and scanRoot changes', () => {
    registry.upsert(makeEntry({ id: 'a1', projectPath: '/p/a1', namespace: 'old', scanRoot: '/old' }));
    registry.update('a1', { namespace: 'new', scanRoot: '/new' });
    const entry = registry.get('a1');
    expect(entry?.namespace).toBe('new');
    expect(entry?.scanRoot).toBe('/new');
  });

  it('persists behavior and budget changes', () => {
    registry.upsert(makeEntry({ id: 'a1', projectPath: '/p/a1' }));
    registry.update('a1', {
      behavior: { responseMode: 'on-mention' },
      budget: { maxHopsPerMessage: 1, maxCallsPerHour: 10 },
    });
    const entry = registry.get('a1');
    expect(entry?.behavior.responseMode).toBe('on-mention');
    expect(entry?.budget.maxCallsPerHour).toBe(10);
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

  it('returns false for non-existent id', () => {
    expect(registry.remove('nonexistent')).toBe(false);
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

  it('replaces stale entry when different ID registered at same path', () => {
    registry.upsert(makeEntry({ id: 'old-id', projectPath: '/same/path' }));
    registry.upsert(makeEntry({ id: 'new-id', projectPath: '/same/path' }));
    expect(registry.get('old-id')).toBeUndefined();
    expect(registry.get('new-id')).toBeDefined();
  });

  it('persists behavior_json and budget_json from entry', () => {
    const behavior = { responseMode: 'on-mention' as const };
    const budget = { maxHopsPerMessage: 3, maxCallsPerHour: 50 };
    registry.upsert(makeEntry({ id: 'agent-1', projectPath: '/path/a', behavior, budget }));
    const entry = registry.get('agent-1');
    expect(entry?.behavior).toEqual(behavior);
    expect(entry?.budget).toEqual(budget);
  });

  it('persists scan_root from entry', () => {
    registry.upsert(makeEntry({ id: 'agent-1', projectPath: '/path/a', scanRoot: '/projects' }));
    expect(registry.get('agent-1')?.scanRoot).toBe('/projects');
  });
});

// ---------------------------------------------------------------------------
// rowToEntry round-trip
// ---------------------------------------------------------------------------

describe('rowToEntry()', () => {
  it('parses behavior_json from DB column', () => {
    const behavior = { responseMode: 'on-mention' as const };
    registry.upsert(makeEntry({ id: 'a1', projectPath: '/p/a1', behavior }));
    const entry = registry.get('a1');
    expect(entry?.behavior).toEqual(behavior);
  });

  it('parses budget_json from DB column', () => {
    const budget = { maxHopsPerMessage: 10, maxCallsPerHour: 200 };
    registry.upsert(makeEntry({ id: 'a1', projectPath: '/p/a1', budget }));
    const entry = registry.get('a1');
    expect(entry?.budget).toEqual(budget);
  });

  it('reads scanRoot from DB column', () => {
    registry.upsert(makeEntry({ id: 'a1', projectPath: '/p/a1', scanRoot: '/my/root' }));
    expect(registry.get('a1')?.scanRoot).toBe('/my/root');
  });
});

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
    const recentTime = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    registry.updateHealth('01JKABC00001', recentTime, 'message');
    const entry = registry.getWithHealth('01JKABC00001');
    expect(entry!.healthStatus).toBe('active');
  });

  it('getWithHealth() computes inactive status for 10-minute-old timestamp', () => {
    registry.upsert(makeEntry());
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    registry.updateHealth('01JKABC00001', tenMinAgo, 'message');
    const entry = registry.getWithHealth('01JKABC00001');
    expect(entry!.healthStatus).toBe('inactive');
  });

  it('getWithHealth() computes stale status for 60-minute-old timestamp', () => {
    registry.upsert(makeEntry());
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    registry.updateHealth('01JKABC00001', oneHourAgo, 'old_event');
    const entry = registry.getWithHealth('01JKABC00001');
    expect(entry!.healthStatus).toBe('stale');
  });

  it('getWithHealth() computes stale for null last_seen_at', () => {
    registry.upsert(makeEntry());
    const entry = registry.getWithHealth('01JKABC00001');
    expect(entry!.lastSeenAt).toBeNull();
    expect(entry!.healthStatus).toBe('stale');
  });

  it('getAggregateStats() returns correct counts', () => {
    const agent1 = makeEntry({ id: 'agent1', projectPath: '/p/1' });
    const agent2 = makeEntry({ id: 'agent2', projectPath: '/p/2' });
    const agent3 = makeEntry({ id: 'agent3', projectPath: '/p/3' });
    registry.upsert(agent1);
    registry.upsert(agent2);
    registry.upsert(agent3);
    registry.updateHealth('agent1', new Date().toISOString(), 'recent'); // active
    registry.updateHealth('agent2', new Date(Date.now() - 10 * 60 * 1000).toISOString(), 'old'); // inactive
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
    registry.updateHealth('a1', new Date().toISOString(), 'recent'); // active
    registry.markUnreachable('a2');
    registry.markUnreachable('a3');
    const stats = registry.getAggregateStats();
    expect(stats.totalAgents).toBe(3);
    expect(stats.activeCount).toBe(1);
    expect(stats.unreachableCount).toBe(2);
    expect(stats.staleCount).toBe(0);
  });

  it('listWithHealth() includes healthStatus for all agents', () => {
    registry.upsert(makeEntry());
    registry.updateHealth('01JKABC00001', new Date().toISOString(), 'test');
    const entries = registry.listWithHealth();
    expect(entries.length).toBe(1);
    expect(entries[0]!.healthStatus).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Anti-regression: Drizzle migration
// ---------------------------------------------------------------------------

describe('anti-regression: Drizzle migration', () => {
  it('does not store manifest_json column', () => {
    // Use the raw SQLite client to inspect table schema
    const columns = db.$client.pragma('table_info(agents)') as Array<{
      name: string;
    }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).not.toContain('manifest_json');
    // Verify key structured columns exist instead
    expect(columnNames).toContain('name');
    expect(columnNames).toContain('runtime');
    expect(columnNames).toContain('capabilities_json');
    expect(columnNames).toContain('project_path');
  });

  it('computes health status in TypeScript via computeHealthStatus()', () => {
    registry.upsert(makeEntry());

    // Active: < 5 min ago
    const recentTime = new Date(Date.now() - 60 * 1000).toISOString();
    registry.updateHealth('01JKABC00001', recentTime, 'heartbeat');
    const active = registry.getWithHealth('01JKABC00001');
    expect(active!.healthStatus).toBe('active');
    expect(computeHealthStatus(recentTime)).toBe('active');

    // Inactive: 5-30 min ago
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    registry.updateHealth('01JKABC00001', tenMinAgo, 'heartbeat');
    const inactive = registry.getWithHealth('01JKABC00001');
    expect(inactive!.healthStatus).toBe('inactive');
    expect(computeHealthStatus(tenMinAgo)).toBe('inactive');

    // Stale: > 30 min ago
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    registry.updateHealth('01JKABC00001', oneHourAgo, 'heartbeat');
    const stale = registry.getWithHealth('01JKABC00001');
    expect(stale!.healthStatus).toBe('stale');
    expect(computeHealthStatus(oneHourAgo)).toBe('stale');

    // Null lastSeenAt: stale
    expect(computeHealthStatus(null)).toBe('stale');
  });

  it('stores all IDs as ULIDs', () => {
    const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

    // Agent ID from makeEntry uses a short test ID; verify real ULID-style IDs
    // work through insert/get. The denial list generates real ULIDs.
    const denialList = new DenialList(db);
    denialList.deny('/tmp/test-anti-regression-ulid', 'claude-code', 'test', 'user');

    const denials = denialList.list();
    expect(denials).toHaveLength(1);

    // Read the raw denial row to check the auto-generated ULID id
    const rawRows = db.$client
      .prepare('SELECT id FROM agent_denials')
      .all() as Array<{ id: string }>;
    expect(rawRows[0].id).toMatch(ulidPattern);
  });

  it('stores timestamps as ISO 8601 strings', () => {
    const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

    registry.upsert(makeEntry());
    const entry = registry.get('01JKABC00001');
    expect(entry).toBeDefined();
    expect(entry!.registeredAt).toMatch(isoPattern);

    // Verify raw row timestamps are ISO strings (not Julian day numbers)
    const rawRows = db.$client
      .prepare('SELECT registered_at, updated_at FROM agents WHERE id = ?')
      .all('01JKABC00001') as Array<{ registered_at: string; updated_at: string }>;
    expect(rawRows[0].registered_at).toMatch(isoPattern);
    expect(rawRows[0].updated_at).toMatch(isoPattern);

    // Verify denial timestamps too
    const denialList = new DenialList(db);
    denialList.deny('/tmp/test-anti-regression-ts', 'claude-code', 'test', 'user');
    const denialRows = db.$client
      .prepare('SELECT created_at FROM agent_denials')
      .all() as Array<{ created_at: string }>;
    expect(denialRows[0].created_at).toMatch(isoPattern);
  });
});

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

  it('returns false for non-existent agent', () => {
    expect(registry.markUnreachable('nonexistent')).toBe(false);
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
