/**
 * From Wi-Fi a permission write may lower what agents may do, never raise it
 * (DOR-3037): Careful, Ask and Blocked land; Trusted, Allowed, putting a
 * setting back to a looser default, bringing agents along and Undo are
 * refused with `NOT_FROM_WIFI`. At this computer nothing changes.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createPermissionsRoutes } from '../permissions.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { NOT_FROM_WIFI } from '../../services/core/auth/sessions/wifi-level.js';
import {
  WIFI_RAISE_REFUSAL,
  WIFI_UNDO_REFUSAL,
} from '../../services/core/auth/sessions/wifi-raise-guard.js';
import {
  TWO_AGENTS,
  createPermissionWorld,
} from '../../services/core/permissions/__tests__/permission-fixtures.js';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));

const target = swappableServer();
const REFUSED = { error: WIFI_RAISE_REFUSAL, code: NOT_FROM_WIFI };

/** The real routes over an in-memory world on Full power, reached from Wi-Fi on `x-test-via`. */
function build(): { app: Server; world: ReturnType<typeof createPermissionWorld> } {
  const world = createPermissionWorld({ preset: 'full', agents: TWO_AGENTS });
  const built = honoGroupListener(
    {
      path: '/api',
      routes: createPermissionsRoutes({
        permissions: world.service,
        activity: world.activity,
        isLoginEnabled: () => false,
      }),
    },
    {
      before: async (c, next) => {
        if (c.req.header('x-test-via') === 'wifi') {
          markIngress(c.env.incoming, 'wifi');
          c.set('user', { userId: 'owner', credential: 'cookie' });
        }
        await next();
      },
    }
  );
  return { app: target.mount(built), world };
}

describe('the preset from Wi-Fi', () => {
  it('takes Careful', async () => {
    const { app } = build();
    const res = await request(app)
      .put('/api/permissions/preset')
      .set('x-test-via', 'wifi')
      .send({ preset: 'careful', surface: 'settings' });
    expect(res.status).toBe(200);
  });

  it('refuses Trusted, and Careful that brings agents along', async () => {
    const { app, world } = build();
    const trusted = await request(app)
      .put('/api/permissions/preset')
      .set('x-test-via', 'wifi')
      .send({ preset: 'trusted', surface: 'settings' });
    expect(trusted.status).toBe(403);
    expect(trusted.body).toEqual(REFUSED);
    const along = await request(app)
      .put('/api/permissions/preset')
      .set('x-test-via', 'wifi')
      .send({ preset: 'careful', applyToAgents: ['agent-test'], surface: 'settings' });
    expect(along.status).toBe(403);
    expect(world.events).toEqual([]);
  });

  it('takes Trusted at this computer', async () => {
    const { app } = build();
    const res = await request(app)
      .put('/api/permissions/preset')
      .send({ preset: 'trusted', surface: 'settings' });
    expect(res.status).toBe(200);
  });
});

describe('everyone’s defaults from Wi-Fi', () => {
  it('takes a tighter area, and refuses loosening it back or removing the change', async () => {
    const { app } = build();
    const tighten = await request(app)
      .patch('/api/permissions/defaults')
      .set('x-test-via', 'wifi')
      .send({ areas: { rooms: 'blocked' }, surface: 'settings' });
    expect(tighten.status).toBe(200);

    const loosen = await request(app)
      .patch('/api/permissions/defaults')
      .set('x-test-via', 'wifi')
      .send({ areas: { rooms: 'allowed' }, surface: 'settings' });
    expect(loosen.status).toBe(403);
    expect(loosen.body).toEqual(REFUSED);

    const removed = await request(app)
      .patch('/api/permissions/defaults')
      .set('x-test-via', 'wifi')
      .send({ areas: { rooms: null }, surface: 'settings' });
    expect(removed.status).toBe(403);

    const here = await request(app)
      .patch('/api/permissions/defaults')
      .send({ areas: { rooms: 'allowed' }, surface: 'settings' });
    expect(here.status).toBe(200);
  });
});

describe('one agent’s permissions from Wi-Fi', () => {
  it('takes Blocked and Ask first, and refuses Allowed and Full autonomy back', async () => {
    const { app } = build();
    const path = '/api/agents/agent-test/permissions';
    const block = await request(app)
      .patch(path)
      .set('x-test-via', 'wifi')
      .send({ areas: { rooms: 'blocked' }, filesAndCommands: 'ask', surface: 'agent-page' });
    expect(block.status).toBe(200);

    const allow = await request(app)
      .patch(path)
      .set('x-test-via', 'wifi')
      .send({ areas: { rooms: 'allowed' }, surface: 'agent-page' });
    expect(allow.status).toBe(403);
    expect(allow.body).toEqual(REFUSED);

    const autonomy = await request(app)
      .patch(path)
      .set('x-test-via', 'wifi')
      .send({ filesAndCommands: 'autonomy', surface: 'agent-page' });
    expect(autonomy.status).toBe(403);
  });
});

describe('Undo from Wi-Fi', () => {
  it('is refused, whichever way it would go', async () => {
    const { app } = build();
    const res = await request(app)
      .post('/api/permissions/history/evt-1/undo')
      .set('x-test-via', 'wifi')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: WIFI_UNDO_REFUSAL, code: NOT_FROM_WIFI });
  });
});
