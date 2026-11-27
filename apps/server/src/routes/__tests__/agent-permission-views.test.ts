/**
 * One agent's permissions and its level (`GET /api/agents/:agentId/permissions`,
 * `GET /api/agents/:agentId/level`), served by the capability mount (DOR-4978):
 * read-only, answered from the readers boot hands over, `agent_not_found` for
 * no such agent, no write path for a level, and readable by whoever could read
 * them before, an agent included. And the permission history
 * (`GET /api/permissions/history`), a page at a time (DOR-4982).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { AgentLevelResponse } from '@dorkos/shared/permissions';
import { INVALID_CURSOR_DETAIL } from '@dorkos/shared/paging';

import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { ApiEnv } from '../../http/api-chain.js';
import type { AgentIdentity } from '../../services/core/agent-identity/agent-identity-service.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import {
  permissionViewsDomain,
  setAgentPermissionViews,
} from '../../services/core/permissions/agent-permission-views.js';
import { personWriter } from '../../services/core/permissions/index.js';
import {
  TWO_AGENTS,
  createPermissionWorld,
} from '../../services/core/permissions/__tests__/permission-fixtures.js';

const CAPPED: AgentLevelResponse = {
  effective: 'ask',
  effectiveMode: 'default',
  declared: 'autonomy',
  cappedByPerson: true,
};

/** The test bot, as the chain would have resolved its token. */
const AS_TEST_BOT: AgentIdentity = {
  agentPath: '/agents/test-bot',
  displayName: 'Test Bot',
  createdAt: '2026-11-25T00:00:00.000Z',
};

const target = swappableServer();
let reader: ReturnType<typeof vi.fn<(id: string) => Promise<AgentLevelResponse | null>>>;
let world: ReturnType<typeof createPermissionWorld>;

/** The mount over the two reads, standing in for the chain having resolved `identity`. */
function build(identity?: AgentIdentity): Server {
  const before: MiddlewareHandler<ApiEnv> = async (c, next) => {
    if (identity) c.set('agentIdentity', identity);
    await next();
  };
  return target.mount(honoGroupListener(capabilityGroup(permissionViewsDomain), { before }));
}

beforeEach(() => {
  initConfigManager(mkdtempSync(join(tmpdir(), 'permission-views-')));
  world = createPermissionWorld({ preset: 'full', agents: TWO_AGENTS });
  reader = vi.fn(async (id: string) => (id === 'agent-test' ? CAPPED : null));
  setAgentPermissionViews({
    permissions: world.service,
    readLevel: reader,
    activity: world.activity,
  });
});

afterEach(() => setAgentPermissionViews(undefined));

describe('GET /api/agents/:agentId/level', () => {
  it('answers what the reader resolves for the agent', async () => {
    const res = await request(build()).get('/api/agents/agent-test/level');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CAPPED);
    expect(reader).toHaveBeenCalledWith('agent-test');
  });

  it('answers 404 for an id no agent has', async () => {
    const res = await request(build()).get('/api/agents/nobody/level');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'agent_not_found', detail: 'No agent with that id.' });
  });

  it.each(['put', 'patch', 'post', 'delete'] as const)('has no %s', async (method) => {
    const res = await request(build())
      [method]('/api/agents/agent-test/level')
      .send({ effective: 'autonomy' });
    expect(res.status).toBe(404);
  });

  it('says DorkOS is still starting before boot hands the reader over', async () => {
    setAgentPermissionViews(undefined);
    const res = await request(build()).get('/api/agents/agent-test/level');
    expect(res.status).toBe(503);
  });
});

describe('GET /api/agents/:agentId/permissions', () => {
  it('answers one agent’s resolved permissions', async () => {
    const res = await request(build()).get('/api/agents/agent-auditor/permissions');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ agentId: 'agent-auditor', agentName: 'security-auditor' });
  });

  it('answers 404 for an id no agent has', async () => {
    const res = await request(build()).get('/api/agents/nobody/permissions');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'agent_not_found', detail: 'No agent with that id.' });
  });
});

describe('an agent reads any agent’s, as the hand routes let it', () => {
  it('reads another agent’s permissions and level', async () => {
    const server = build(AS_TEST_BOT);
    const permissions = await request(server).get('/api/agents/agent-auditor/permissions');
    expect(permissions.status).toBe(200);
    expect(permissions.body.agentId).toBe('agent-auditor');
    const level = await request(server).get('/api/agents/agent-test/level');
    expect(level.body).toEqual(CAPPED);
  });
});

describe('GET /api/permissions/history', () => {
  /** Three changes to one agent, then one to the other, oldest first. */
  async function fourChanges() {
    const writer = personWriter('local-trust');
    for (const state of ['ask', 'blocked', 'allowed'] as const) {
      await world.service.setAgent(
        'agent-test',
        { areas: { rooms: state }, surface: 'agent-page' },
        writer
      );
    }
    await world.service.setAgent(
      'agent-auditor',
      { areas: { rooms: 'ask' }, surface: 'agent-page' },
      writer
    );
  }

  it('reads one agent’s changes, newest first', async () => {
    await fourChanges();
    const res = await request(build()).get('/api/permissions/history?agentId=agent-test');
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { summary: string }) => e.summary)).toEqual([
      'Test Bot: Rooms Allowed',
      'Test Bot: Rooms Blocked',
      'Test Bot: Rooms Ask',
    ]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('gives every page in the order one long page has, and stops on the last', async () => {
    await fourChanges();
    const whole = await request(build()).get('/api/permissions/history');
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string> = { limit: '1', ...(cursor ? { cursor } : {}) };
      const page = await request(build()).get('/api/permissions/history').query(query);
      expect(page.status).toBe(200);
      ids.push(...page.body.entries.map((e: { id: string }) => e.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(ids).toEqual(whole.body.entries.map((e: { id: string }) => e.id));
    expect(ids).toHaveLength(4);
  });

  it('refuses a cursor it did not give, rather than starting again', async () => {
    const res = await request(build()).get('/api/permissions/history?cursor=yesterday');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_request', detail: INVALID_CURSOR_DETAIL });
  });
});
