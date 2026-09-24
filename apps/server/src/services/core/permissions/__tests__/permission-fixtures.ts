/**
 * An in-memory permission world for the permission service and route tests: a
 * config section, a handful of agents with manifest-backed overrides, and an
 * Activity log that records what was emitted. Every piece is a real value the
 * service reads and writes, so a test asserts on the state it left behind.
 */
import type {
  AgentPermissions,
  PermissionConfigInput,
  PermissionState,
} from '@dorkos/shared/permissions';
import type { ActivityItem, ListActivityQuery } from '@dorkos/shared/activity-schemas';

import { PermissionService, type PermissionActionInfo } from '../permission-service.js';

/** The actions the fixture world knows. */
const FIXTURE_ACTIONS: PermissionActionInfo[] = [
  { id: 'rooms.create', title: 'Open a room', tier: 'act', area: 'rooms' },
  { id: 'rooms.merge', title: 'Merge into main', tier: 'act', area: 'rooms' },
  { id: 'rooms.post', title: 'Post in a room', tier: 'act', area: null },
  { id: 'operator.config_patch', title: 'Change settings', tier: 'act', area: null },
  { id: 'permissions.change', title: 'Change a permission', tier: 'act', area: 'permissions' },
];

/** One agent in the fixture world. */
export interface FixtureAgent {
  id: string;
  name: string;
  displayName?: string;
  projectPath: string;
  permissions?: AgentPermissions;
}

/** A fresh fixture world. */
export function createPermissionWorld(
  options: {
    preset?: PermissionConfigInput['preset'];
    defaults?: PermissionConfigInput['defaults'];
    agents?: FixtureAgent[];
  } = {}
) {
  const config = {
    preset: options.preset ?? null,
    defaults: options.defaults ?? { areas: {}, actions: {} },
    upgradeSweptVersion: null as string | null,
  };
  const agents = new Map<string, FixtureAgent>(
    (options.agents ?? []).map((a) => [a.id, structuredClone(a)])
  );
  const events: ActivityItem[] = [];
  let clock = Date.parse('2026-09-01T00:00:00.000Z');

  const activity = {
    emit: async (event: Omit<ActivityItem, 'id' | 'occurredAt'> & { occurredAt?: string }) => {
      clock += 1000;
      events.push({
        id: `evt-${events.length + 1}`,
        occurredAt: event.occurredAt ?? new Date(clock).toISOString(),
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        actorLabel: event.actorLabel,
        category: event.category,
        eventType: event.eventType,
        resourceType: event.resourceType ?? null,
        resourceId: event.resourceId ?? null,
        resourceLabel: event.resourceLabel ?? null,
        summary: event.summary,
        linkPath: event.linkPath ?? null,
        metadata: event.metadata ?? null,
      });
    },
    list: async (query: ListActivityQuery) => {
      const cats = query.categories?.split(',');
      const rows = [...events]
        .reverse()
        .filter((e) => !cats || cats.includes(e.category))
        .filter((e) => !query.before || e.occurredAt < query.before);
      const page = rows.slice(0, query.limit);
      return {
        items: page,
        nextCursor: rows.length > query.limit ? page.at(-1)!.occurredAt : null,
      };
    },
  };

  const service = new PermissionService({
    config: {
      get: () => structuredClone(config),
      set: (next) => Object.assign(config, structuredClone(next)),
      trustStop: () => 'act',
    },
    agents: {
      list: () =>
        [...agents.values()].map((a) => ({
          id: a.id,
          name: a.name,
          ...(a.displayName ? { displayName: a.displayName } : {}),
          projectPath: a.projectPath,
        })),
      readPermissions: async (projectPath) => {
        const agent = [...agents.values()].find((a) => a.projectPath === projectPath);
        return agent?.permissions ? structuredClone(agent.permissions) : undefined;
      },
      writePermissions: async (agentId, next) => {
        const agent = agents.get(agentId)!;
        if (next) agent.permissions = structuredClone(next);
        else delete agent.permissions;
      },
    },
    actions: () => FIXTURE_ACTIONS,
    activity,
  });

  return {
    service,
    config,
    agents,
    events,
    activity,
    /** One agent's stored area state, or undefined. */
    agentArea: (id: string, area: string): PermissionState | undefined =>
      agents.get(id)?.permissions?.areas?.[area],
  };
}

/** Two agents, one of them set differently for Rooms. */
export const TWO_AGENTS: FixtureAgent[] = [
  {
    id: 'agent-auditor',
    name: 'security-auditor',
    projectPath: '/agents/security-auditor',
    permissions: { areas: { rooms: 'blocked' } },
  },
  { id: 'agent-test', name: 'test-bot', displayName: 'Test Bot', projectPath: '/agents/test-bot' },
];
