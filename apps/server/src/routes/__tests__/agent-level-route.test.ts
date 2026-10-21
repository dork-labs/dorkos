/**
 * `GET /api/agents/:id/level`, the profile's Level row (Security, 2026-10-20):
 * read-only, answered from the reader it is handed, 404 for no such agent, and
 * no write path of any kind.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Server } from 'node:http';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { AgentLevelResponse } from '@dorkos/shared/permissions';

import { createPermissionsRoutes } from '../permissions.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import {
  TWO_AGENTS,
  createPermissionWorld,
} from '../../services/core/permissions/__tests__/permission-fixtures.js';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));

const CAPPED: AgentLevelResponse = {
  effective: 'ask',
  effectiveMode: 'default',
  declared: 'autonomy',
  cappedByPerson: true,
};

describe('GET /api/agents/:id/level', () => {
  const target = swappableServer();

  /** The real routes behind the `/api` chain, with or without a level reader. */
  function build(readAgentLevel?: (id: string) => Promise<AgentLevelResponse | null>): Server {
    const world = createPermissionWorld({ preset: 'full', agents: TWO_AGENTS });
    return target.mount(
      honoGroupListener({
        path: '/api',
        routes: createPermissionsRoutes({
          permissions: world.service,
          activity: world.activity,
          isLoginEnabled: () => false,
          ...(readAgentLevel ? { readAgentLevel } : {}),
        }),
      })
    );
  }

  it('answers what the reader resolves for the agent', async () => {
    const reader = vi.fn(async (id: string) => (id === 'agent-test' ? CAPPED : null));
    const res = await request(build(reader)).get('/api/agents/agent-test/level');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CAPPED);
    expect(reader).toHaveBeenCalledWith('agent-test');
  });

  it('answers 404 for an id no agent has', async () => {
    const res = await request(build(async () => null)).get('/api/agents/nobody/level');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('UNKNOWN_AGENT');
  });

  it.each(['put', 'patch', 'post', 'delete'] as const)('has no %s', async (method) => {
    const res = await request(build(async () => CAPPED))
      [method]('/api/agents/agent-test/level')
      .send({ effective: 'autonomy' });
    expect(res.status).toBe(404);
  });

  it('is not served without a reader', async () => {
    const res = await request(build()).get('/api/agents/agent-test/level');
    expect(res.status).toBe(404);
  });
});
