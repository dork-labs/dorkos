/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import { agentFilterSchema, agentSortOptions } from '../lib/agent-filter-schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeAgent = (overrides: Partial<TopologyAgent> & { id: string }): TopologyAgent => ({
  id: overrides.id,
  name: overrides.name ?? `Agent ${overrides.id}`,
  description: overrides.description ?? '',
  runtime: overrides.runtime ?? 'claude-code',
  capabilities: overrides.capabilities ?? [],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  namespace: overrides.namespace,
  registeredAt: overrides.registeredAt ?? '2026-01-01T00:00:00Z',
  registeredBy: 'user',
  personaEnabled: true,
  enabledToolGroups: {},
  projectPath: overrides.projectPath ?? `/${overrides.id}`,
  healthStatus: overrides.healthStatus ?? 'active',
  relayAdapters: [],
  relaySubject: null,
  pulseScheduleCount: 0,
  lastSeenAt: overrides.lastSeenAt ?? null,
  lastSeenEvent: null,
});

const agents: TopologyAgent[] = [
  makeAgent({
    id: '1',
    name: 'Frontend Bot',
    description: 'Handles UI work',
    runtime: 'claude-code',
    capabilities: ['code', 'review'],
    healthStatus: 'active',
    namespace: 'web',
    lastSeenAt: '2026-03-26T10:00:00Z',
    registeredAt: '2026-01-15T00:00:00Z',
  }),
  makeAgent({
    id: '2',
    name: 'Backend Bot',
    description: 'API development',
    runtime: 'cursor',
    capabilities: ['code'],
    healthStatus: 'inactive',
    namespace: 'api',
    lastSeenAt: '2026-03-20T10:00:00Z',
    registeredAt: '2026-02-01T00:00:00Z',
  }),
  makeAgent({
    id: '3',
    name: 'DevOps Agent',
    description: 'CI/CD pipelines',
    runtime: 'codex',
    capabilities: ['deploy'],
    healthStatus: 'stale',
    namespace: 'infra',
    lastSeenAt: null,
    registeredAt: '2026-03-01T00:00:00Z',
  }),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentFilterSchema', () => {
  describe('text search', () => {
    it('matches by name', () => {
      const result = agentFilterSchema.applyFilters(agents, { search: 'Frontend' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('matches by description', () => {
      const result = agentFilterSchema.applyFilters(agents, { search: 'API development' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });

    it('matches by capability', () => {
      const result = agentFilterSchema.applyFilters(agents, { search: 'deploy' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('3');
    });

    it('returns all agents for empty search', () => {
      const result = agentFilterSchema.applyFilters(agents, { search: '' });
      expect(result).toHaveLength(3);
    });

    it('is case-insensitive', () => {
      const result = agentFilterSchema.applyFilters(agents, { search: 'frontend' });
      expect(result).toHaveLength(1);
    });
  });

  describe('status filter', () => {
    it('filters by single status (multi-select mode)', () => {
      const result = agentFilterSchema.applyFilters(agents, { status: ['active'] });
      expect(result).toHaveLength(1);
      expect(result[0].healthStatus).toBe('active');
    });

    it('filters by multiple statuses', () => {
      const result = agentFilterSchema.applyFilters(agents, {
        status: ['active', 'inactive'],
      });
      expect(result).toHaveLength(2);
    });

    it('returns all agents when status is empty array', () => {
      const result = agentFilterSchema.applyFilters(agents, { status: [] });
      expect(result).toHaveLength(3);
    });
  });

  describe('runtime filter', () => {
    it('filters by runtime', () => {
      const result = agentFilterSchema.applyFilters(agents, { runtime: 'cursor' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });

    it('returns all agents when runtime is empty', () => {
      const result = agentFilterSchema.applyFilters(agents, { runtime: '' });
      expect(result).toHaveLength(3);
    });
  });

  describe('combined filters', () => {
    it('applies multiple filters together', () => {
      const result = agentFilterSchema.applyFilters(agents, {
        search: 'Bot',
        status: ['active'],
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('returns empty when no agent matches all filters', () => {
      const result = agentFilterSchema.applyFilters(agents, {
        search: 'Frontend',
        status: ['inactive'],
      });
      expect(result).toHaveLength(0);
    });
  });

  describe('schema metadata', () => {
    it('has a searchValidator Zod schema', () => {
      expect(agentFilterSchema.searchValidator).toBeDefined();
      // Should parse empty object successfully
      const result = agentFilterSchema.searchValidator.safeParse({});
      expect(result.success).toBe(true);
    });

    it('reports active filter count', () => {
      expect(agentFilterSchema.activeCount({ search: 'test', status: ['active'] })).toBe(2);
      expect(agentFilterSchema.activeCount({})).toBe(0);
    });

    it('describes active filters', () => {
      const desc = agentFilterSchema.describeActive({ search: 'bot', status: ['active'] });
      expect(desc).toContain("search 'bot'");
      expect(desc).toContain('Active');
    });
  });
});

describe('agentSortOptions', () => {
  it('sorts by name ascending', () => {
    const sorted = [...agents].sort((a, b) => {
      const aVal = agentSortOptions.name.accessor(a);
      const bVal = agentSortOptions.name.accessor(b);
      if (aVal === null || bVal === null) return 0;
      return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    });
    expect(sorted.map((a) => a.id)).toEqual(['2', '3', '1']);
  });

  it('has expected sort options', () => {
    expect(Object.keys(agentSortOptions)).toEqual(['name', 'lastSeen', 'status', 'registered']);
  });

  it('lastSeen defaults to desc', () => {
    expect(agentSortOptions.lastSeen.direction).toBe('desc');
  });

  it('registered defaults to desc', () => {
    expect(agentSortOptions.registered.direction).toBe('desc');
  });
});
