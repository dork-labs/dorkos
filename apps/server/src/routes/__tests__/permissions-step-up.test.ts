/**
 * Raising what agents may do, and an Undo, wait for the owner to confirm it's them
 * (DOR-4355); lowering answers at once. Wi-Fi keeps its own refusal
 * (permissions-wifi.test.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPermissionsRoutes } from '../permissions.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';
import {
  TWO_AGENTS,
  createPermissionWorld,
} from '../../services/core/permissions/__tests__/permission-fixtures.js';

/** A stand-in that reads through to whatever `current()` is now, so each test gets its own world. */
function live<T extends object>(current: () => T): T {
  return new Proxy({} as T, {
    get: (_target, key) => {
      const value = Reflect.get(current(), key);
      return typeof value === 'function' ? value.bind(current()) : value;
    },
  });
}

/** Reads the overview slowly when `slow.on`, so two requests both read before either writes. */
const slow = { on: false };

describe('permission raise confirmation', () => {
  let world = createPermissionWorld({ preset: 'careful', agents: TWO_AGENTS });
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api',
      routes: createPermissionsRoutes({
        permissions: live(() => {
          const service = world.service;
          if (!slow.on) return service;
          return Object.assign(Object.create(service) as typeof service, {
            getOverview: async () => {
              const overview = await service.getOverview();
              await new Promise((resolve) => setTimeout(resolve, 30));
              return overview;
            },
          });
        }),
        activity: live(() => world.activity),
        isLoginEnabled: () => true,
      }),
    },
  ]);
  beforeEach(() => {
    slow.on = false;
    world = createPermissionWorld({ preset: 'careful', agents: TWO_AGENTS });
  });

  // Each request judges the move against what it read; one made meanwhile is refused.
  it.each(['own-tunnel', 'wifi'] as const)(
    'keeps a Blocked when two Careful moves from %s arrive at once',
    async (via) => {
      world = createPermissionWorld({
        preset: 'trusted',
        defaults: { areas: { messages: 'blocked' }, actions: {} },
        agents: TWO_AGENTS,
      });
      slow.on = true;
      const body = { preset: 'careful', surface: 'settings' };
      const answers = await Promise.all([
        owner.call('put', '/api/permissions/preset', via).send(body),
        owner.call('put', '/api/permissions/preset', via).send(body),
      ]);
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
      const overview = await world.service.getOverview();
      expect(overview.areas.find((area) => area.id === 'messages')!.resolved.state).toBe('blocked');
    }
  );

  it.each([
    ['the preset', 'put', '/api/permissions/preset', { preset: 'trusted', surface: 'settings' }],
    [
      'everyone’s defaults',
      'patch',
      '/api/permissions/defaults',
      { areas: { rooms: 'allowed' }, surface: 'settings' },
    ],
    [
      'one agent',
      'patch',
      '/api/agents/agent-test/permissions',
      { filesAndCommands: 'autonomy', surface: 'agent-page' },
    ],
  ] as const)('holds raising %s until the owner confirms', async (_label, method, path, body) => {
    const held = await owner.call(method, path, 'own-tunnel').send(body);
    expect(held.status).toBe(428);
    expect(world.events).toEqual([]);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(world.events).toEqual([]);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(world.events.length).toBeGreaterThan(0);
  });

  // Careful by name can still loosen: it replaces the person's own changes with its table.
  it.each([
    ['choosing Careful again clears a Blocked', 'careful', { messages: 'blocked' }],
    ['moving into Careful drops an Ask Careful allows', 'trusted', { messages: 'ask' }],
  ] as const)('holds Careful when %s', async (_label, preset, areas) => {
    world = createPermissionWorld({
      preset,
      defaults: { areas: { ...areas }, actions: {} },
      agents: TWO_AGENTS,
    });
    const held = await owner
      .call('put', '/api/permissions/preset', 'own-tunnel')
      .send({ preset: 'careful', surface: 'settings' });
    expect(held.status).toBe(428);
    expect(world.events).toEqual([]);
  });

  it('answers Careful at once when it keeps every Blocked and loosens nothing', async () => {
    world = createPermissionWorld({
      preset: 'trusted',
      defaults: { areas: { messages: 'blocked' }, actions: {} },
      agents: TWO_AGENTS,
    });
    const res = await owner
      .call('put', '/api/permissions/preset', 'own-tunnel')
      .send({ preset: 'careful', surface: 'settings' });
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
  });

  it('holds a raise at this computer too', async () => {
    const held = await owner
      .call('put', '/api/permissions/preset')
      .send({ preset: 'trusted', surface: 'settings' });
    expect(held.status).toBe(428);
    expect(world.events).toEqual([]);
  });

  it('answers lowering at once', async () => {
    const res = await owner
      .call('patch', '/api/permissions/defaults', 'own-tunnel')
      .send({ areas: { rooms: 'blocked' }, surface: 'settings' });
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
    expect(world.events).toHaveLength(1);
  });

  it('holds an Undo, which may put back a looser setting', async () => {
    await owner
      .call('patch', '/api/permissions/defaults')
      .send({ areas: { rooms: 'blocked' }, surface: 'settings' });
    const eventId = world.events[0]!.id;
    const held = await owner
      .call('post', `/api/permissions/history/${eventId}/undo`, 'own-tunnel')
      .send({});
    expect(held.status).toBe(428);
    expect(world.events).toHaveLength(1);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(world.events).toHaveLength(2);
  });
});
