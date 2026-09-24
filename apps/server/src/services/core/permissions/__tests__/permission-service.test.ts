/**
 * The one owner of every permission write: what it refuses, what it writes, and
 * the single audit event each write leaves behind (spec `agent-permissions` D10,
 * D14). Runs the real service over an in-memory world, so every assertion is on
 * the state a write left behind rather than on a call a mock received.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionChangedMetadata } from '@dorkos/shared/permissions';

import { PermissionError } from '../permission-service.js';
import { personWriter, UPGRADE_WRITER } from '../permission-history.js';
import { TWO_AGENTS, createPermissionWorld } from './permission-fixtures.js';

const LOCAL = personWriter('local-trust');

/** The metadata of the one event a write left. */
function onlyEvent(events: { metadata: Record<string, unknown> | null }[]) {
  expect(events).toHaveLength(1);
  return events[0]!.metadata as unknown as PermissionChangedMetadata;
}

describe('PermissionService.setDefaults', () => {
  it('writes an area default and records one event with its before and after', async () => {
    const world = createPermissionWorld({ preset: 'careful' });

    await world.service.setDefaults({ areas: { rooms: 'allowed' }, surface: 'settings' }, LOCAL);

    expect(world.config.defaults.areas).toEqual({ rooms: 'allowed' });
    const meta = onlyEvent(world.events);
    expect(meta).toMatchObject({ surface: 'settings', attribution: 'local-trust' });
    expect(meta.changes).toEqual([
      {
        target: { kind: 'default' },
        key: { kind: 'area', area: 'rooms' },
        before: null,
        after: 'allowed',
      },
    ]);
    expect(world.events[0]).toMatchObject({
      category: 'permissions',
      eventType: 'permission.changed',
      actorLabel: 'Someone on this computer',
      summary: 'Rooms set to Allowed for everyone',
    });
  });

  it('removes a change with null', async () => {
    const world = createPermissionWorld({ defaults: { areas: { rooms: 'ask' }, actions: {} } });

    await world.service.setDefaults({ areas: { rooms: null }, surface: 'settings' }, LOCAL);

    expect(world.config.defaults.areas).toEqual({});
    expect(onlyEvent(world.events).changes[0]).toMatchObject({ before: 'ask', after: null });
  });

  it('brings the selected agents along in the SAME write, one event naming each', async () => {
    const agents = [
      ...TWO_AGENTS,
      {
        id: 'agent-third',
        name: 'third',
        projectPath: '/agents/third',
        permissions: { areas: { rooms: 'ask' as const } },
      },
    ];
    const world = createPermissionWorld({ preset: 'careful', agents });

    await world.service.setDefaults(
      {
        areas: { rooms: 'allowed' },
        applyToAgents: ['agent-auditor', 'agent-third'],
        surface: 'settings',
      },
      LOCAL
    );

    expect(world.agentArea('agent-auditor', 'rooms')).toBeUndefined();
    expect(world.agentArea('agent-third', 'rooms')).toBeUndefined();
    const meta = onlyEvent(world.events);
    expect(
      meta.changes.map((c) => (c.target.kind === 'agent' ? c.target.agentId : 'default'))
    ).toEqual(['default', 'agent-auditor', 'agent-third']);
    expect(world.events[0]!.summary).toBe(
      'Rooms set to Allowed for everyone, and 2 agents updated'
    );
    // A bulk change is not about one agent, so it carries no resourceId.
    expect(world.events[0]!.resourceId).toBeNull();
  });

  it('refuses Allowed on a floor area and on a floor-area action', async () => {
    const world = createPermissionWorld();
    await expect(
      world.service.setDefaults({ areas: { safety: 'allowed' }, surface: 'settings' }, LOCAL)
    ).rejects.toMatchObject({ code: 'FLOOR_NEVER_ALLOWED', status: 400 });
    await expect(
      world.service.setDefaults(
        { actions: { 'permissions.change': 'allowed' }, surface: 'settings' },
        LOCAL
      )
    ).rejects.toMatchObject({ code: 'FLOOR_NEVER_ALLOWED' });
    expect(world.events).toEqual([]);
  });

  it('refuses unknown areas, unknown actions, and actions with no area', async () => {
    const world = createPermissionWorld();
    await expect(
      world.service.setDefaults({ areas: { future: 'ask' }, surface: 'settings' }, LOCAL)
    ).rejects.toBeInstanceOf(PermissionError);
    await expect(
      world.service.setDefaults({ actions: { 'nope.verb': 'ask' }, surface: 'settings' }, LOCAL)
    ).rejects.toMatchObject({ code: 'UNKNOWN_ACTION' });
    await expect(
      world.service.setDefaults(
        { actions: { 'rooms.post': 'blocked' }, surface: 'settings' },
        LOCAL
      )
    ).rejects.toMatchObject({ code: 'ACTION_HAS_NO_AREA' });
  });

  it('records nothing for a write that changes nothing', async () => {
    const world = createPermissionWorld({ defaults: { areas: { rooms: 'ask' }, actions: {} } });
    await world.service.setDefaults({ areas: { rooms: 'ask' }, surface: 'settings' }, LOCAL);
    expect(world.events).toEqual([]);
  });
});

describe('PermissionService.setPreset', () => {
  it('sets the preset, clears the changes on top, and snapshots what was there', async () => {
    const world = createPermissionWorld({
      preset: null,
      defaults: { areas: { rooms: 'ask' }, actions: {} },
    });

    await world.service.setPreset({ preset: 'full', surface: 'first-run' }, LOCAL);

    expect(world.config.preset).toBe('full');
    expect(world.config.defaults).toEqual({ areas: {}, actions: {} });
    const meta = onlyEvent(world.events);
    expect(meta.surface).toBe('first-run');
    expect(meta.presetSnapshot).toEqual({
      preset: null,
      defaults: { areas: { rooms: 'ask' }, actions: {} },
      trustStop: 'act',
    });
    expect(meta.changes[0]).toEqual({
      target: { kind: 'default' },
      key: { kind: 'preset' },
      before: null,
      after: 'full',
    });
  });

  it('is idempotent: choosing the same preset again records nothing', async () => {
    const world = createPermissionWorld({ preset: 'full' });
    await world.service.setPreset({ preset: 'full', surface: 'first-run' }, LOCAL);
    expect(world.events).toEqual([]);
  });
});

describe('PermissionService.setAgent', () => {
  it('writes one agent and records an event carrying its id', async () => {
    const world = createPermissionWorld({ agents: TWO_AGENTS });

    await world.service.setAgent(
      'agent-test',
      { areas: { rooms: 'ask' }, surface: 'agent-page' },
      LOCAL
    );

    expect(world.agentArea('agent-test', 'rooms')).toBe('ask');
    expect(world.events[0]).toMatchObject({
      resourceId: 'agent-test',
      summary: 'Test Bot: Rooms Ask',
    });
  });

  it('putting the last key back to default leaves no permissions object at all', async () => {
    const world = createPermissionWorld({ agents: TWO_AGENTS });
    await world.service.setAgent(
      'agent-auditor',
      { areas: { rooms: null }, surface: 'agent-page' },
      LOCAL
    );
    expect(world.agents.get('agent-auditor')!.permissions).toBeUndefined();
  });

  it('refuses an unknown agent with 404', async () => {
    const world = createPermissionWorld();
    await expect(
      world.service.setAgent('nobody', { areas: { rooms: 'ask' }, surface: 'agent-page' }, LOCAL)
    ).rejects.toMatchObject({ code: 'UNKNOWN_AGENT', status: 404 });
  });
});

describe('PermissionService reads', () => {
  it('lists exceptions from every agent that differs', async () => {
    const world = createPermissionWorld({ preset: 'full', agents: TWO_AGENTS });

    const overview = await world.service.getOverview();

    expect(overview.exceptions).toEqual([
      { agentId: 'agent-auditor', agentName: 'security-auditor', area: 'rooms', state: 'blocked' },
    ]);
    expect(overview.agentCount).toBe(2);
    const rooms = overview.areas.find((a) => a.id === 'rooms')!;
    expect(rooms.resolved).toEqual({ state: 'allowed', source: 'preset', layer: 'default' });
    expect(rooms.actions.map((a) => a.id)).toEqual(['rooms.create', 'rooms.merge']);
  });

  it("shows an agent's own state beside what it would inherit", async () => {
    const world = createPermissionWorld({ preset: 'full', agents: TWO_AGENTS });

    const agent = await world.service.getAgent('agent-auditor');
    const rooms = agent.areas.find((a) => a.id === 'rooms')!;

    expect(rooms.resolved).toMatchObject({ state: 'blocked', source: 'agent-area' });
    expect(rooms.inherited).toMatchObject({ state: 'allowed', source: 'preset' });
  });
});

describe('attribution', () => {
  it('labels an upgrade step "Upgrade"', async () => {
    const world = createPermissionWorld();
    await world.service.setPreset({ preset: 'full', surface: 'upgrade' }, UPGRADE_WRITER);
    expect(world.events[0]).toMatchObject({ actorType: 'system', actorLabel: 'Upgrade' });
  });

  it('never labels a login-off write "You"', () => {
    expect(personWriter('local-trust').actorLabel).toBe('Someone on this computer');
    expect(personWriter('signed-in-operator', { id: 'u1', name: 'Dorian' }).actorLabel).toBe(
      'You (signed in as Dorian)'
    );
  });
});
