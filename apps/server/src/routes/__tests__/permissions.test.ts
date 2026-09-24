/**
 * The permission routes (spec `agent-permissions` D10), and above all the bars
 * in front of every write: an agent — resolved or not — is refused, so is the
 * holder of an approval token, and with login on so is a per-user API key. Only
 * a person changes what agents may do.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

import { APPROVAL_TOKEN_HEADER } from '../../services/core/capabilities/index.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import { createPermissionsRouter } from '../permissions.js';
import {
  TWO_AGENTS,
  createPermissionWorld,
} from '../../services/core/permissions/__tests__/permission-fixtures.js';

const DORKBOT = {
  agentPath: '/agents/dorkbot',
  displayName: 'DorkBot',
  tierCeiling: 'destructive' as const,
  createdAt: new Date().toISOString(),
};

describe('permission routes', () => {
  const target = swappableServer();

  /** An app around the real router over an in-memory world. */
  function build(
    options: {
      loginEnabled?: boolean;
      agentIdentity?: boolean;
      user?: { userId: string; credential: 'cookie' | 'api-key' };
    } = {}
  ): { app: Server; world: ReturnType<typeof createPermissionWorld> } {
    const world = createPermissionWorld({ preset: 'full', agents: TWO_AGENTS });
    const built = express();
    built.use(express.json());
    built.use((_req, res, next) => {
      if (options.agentIdentity) res.locals.agentIdentity = DORKBOT;
      if (options.user) res.locals.user = options.user;
      next();
    });
    built.use(
      '/api',
      createPermissionsRouter({
        permissions: world.service,
        activity: world.activity,
        isLoginEnabled: () => options.loginEnabled === true,
      })
    );
    return { app: target.mount(built), world };
  }

  /** Every mutating route, with a body that would be accepted from a person. */
  const WRITES = [
    {
      method: 'put',
      path: '/api/permissions/preset',
      body: { preset: 'careful', surface: 'settings' },
    },
    {
      method: 'patch',
      path: '/api/permissions/defaults',
      body: { areas: { rooms: 'ask' }, surface: 'settings' },
    },
    {
      method: 'patch',
      path: '/api/agents/agent-test/permissions',
      body: { areas: { rooms: 'allowed' }, surface: 'agent-page' },
    },
  ] as const;

  /** Send one write. */
  function send(app: Server, write: (typeof WRITES)[number], headers: Record<string, string> = {}) {
    const req =
      write.method === 'put' ? request(app).put(write.path) : request(app).patch(write.path);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req.send(write.body);
  }

  describe('who may write', () => {
    it.each(WRITES)(
      'refuses an agent presenting its header, even unresolved: $method $path',
      async (write) => {
        const { app, world } = build();
        const res = await send(app, write, { [AGENT_IDENTITY_HEADER]: 'dork_unverifiable' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe(
          'Only a person can change permissions. Agents can ask the person.'
        );
        expect(world.events).toEqual([]);
      }
    );

    it.each(WRITES)('refuses a resolved agent identity: $method $path', async (write) => {
      const { app, world } = build({ agentIdentity: true });
      const res = await send(app, write);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
      expect(world.events).toEqual([]);
    });

    it.each(WRITES)('refuses the holder of an approval token: $method $path', async (write) => {
      const { app } = build();
      const res = await send(app, write, { [APPROVAL_TOKEN_HEADER]: 'tok' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('REQUESTER_CANNOT_DECIDE');
    });

    it.each(WRITES)('with login on, refuses a per-user API key: $method $path', async (write) => {
      const { app } = build({
        loginEnabled: true,
        user: { userId: 'user_program', credential: 'api-key' },
      });
      const res = await send(app, write);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('operator_cookie_required');
    });

    it.each(WRITES)(
      'allows a login-off person and records local-trust: $method $path',
      async (write) => {
        const { app, world } = build();
        const res = await send(app, write);
        expect(res.status).toBe(200);
        expect(world.events).toHaveLength(1);
        expect(world.events[0]).toMatchObject({ actorLabel: 'Someone on this computer' });
        expect(world.events[0]!.metadata).toMatchObject({ attribution: 'local-trust' });
      }
    );

    it('allows a signed-in person with a session cookie, and says so', async () => {
      const { app, world } = build({
        loginEnabled: true,
        user: { userId: 'user_owner', credential: 'cookie' },
      });
      const res = await send(app, WRITES[1]);
      expect(res.status).toBe(200);
      expect(world.events[0]!.metadata).toMatchObject({ attribution: 'signed-in' });
    });
  });

  describe('what a write may say', () => {
    it('refuses Allowed on a floor area with 400 FLOOR_NEVER_ALLOWED', async () => {
      const { app } = build();
      const res = await request(app)
        .patch('/api/permissions/defaults')
        .send({ areas: { reach: 'allowed' }, surface: 'settings' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('FLOOR_NEVER_ALLOWED');
    });

    it('refuses an unknown area and an unknown action with 400', async () => {
      const { app } = build();
      const area = await request(app)
        .patch('/api/permissions/defaults')
        .send({ areas: { galaxy: 'ask' }, surface: 'settings' });
      const action = await request(app)
        .patch('/api/agents/agent-test/permissions')
        .send({ actions: { 'nope.verb': 'ask' }, surface: 'agent-page' });
      expect(area.status).toBe(400);
      expect(area.body.code).toBe('UNKNOWN_AREA');
      expect(action.status).toBe(400);
      expect(action.body.code).toBe('UNKNOWN_ACTION');
    });

    it('writes one event naming every agent a default change brought along', async () => {
      const { app, world } = build();
      const res = await request(app)
        .patch('/api/permissions/defaults')
        .send({
          areas: { rooms: 'ask' },
          applyToAgents: ['agent-auditor'],
          surface: 'settings',
        });
      expect(res.status).toBe(200);
      expect(world.agentArea('agent-auditor', 'rooms')).toBeUndefined();
      expect(world.events).toHaveLength(1);
      const changes = (world.events[0]!.metadata as { changes: { target: { kind: string } }[] })
        .changes;
      expect(changes.map((c) => c.target.kind)).toEqual(['default', 'agent']);
    });
  });

  describe('reads', () => {
    it('lists the default layer and the agents that differ', async () => {
      const { app } = build();
      const res = await request(app).get('/api/permissions');
      expect(res.status).toBe(200);
      expect(res.body.preset).toBe('full');
      expect(res.body.exceptions).toEqual([
        {
          agentId: 'agent-auditor',
          agentName: 'security-auditor',
          area: 'rooms',
          state: 'blocked',
        },
      ]);
    });

    it("reads one agent's permissions, and 404s an unknown one", async () => {
      const { app } = build();
      const ok = await request(app).get('/api/agents/agent-auditor/permissions');
      const missing = await request(app).get('/api/agents/nobody/permissions');
      expect(ok.status).toBe(200);
      expect(ok.body.agentName).toBe('security-auditor');
      expect(missing.status).toBe(404);
    });

    it('reads the history, per agent', async () => {
      const { app } = build();
      await request(app)
        .patch('/api/agents/agent-test/permissions')
        .send({ areas: { rooms: 'ask' }, surface: 'agent-page' });
      const res = await request(app).get('/api/permissions/history?agentId=agent-test');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].summary).toBe('Test Bot: Rooms Ask');
    });
  });
});
