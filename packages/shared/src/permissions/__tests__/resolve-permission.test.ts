/**
 * The resolution rule every permission surface shares. These tests run the real
 * resolver against real preset tables: a mocked resolver would only restate the
 * rule under test.
 */
import { describe, it, expect } from 'vitest';
import {
  resolvePermission,
  resolveFilesAndCommands,
  type ResolvePermissionInput,
} from '../resolve-permission.js';
import type { AgentPermissions, PermissionOverrides } from '../permission-schemas.js';

const EMPTY: PermissionOverrides = { areas: {}, actions: {} };

function input(overrides: Partial<ResolvePermissionInput> = {}): ResolvePermissionInput {
  return {
    area: 'rooms',
    actionId: 'rooms.create',
    tier: 'act',
    config: { preset: 'balanced', defaults: EMPTY },
    ...overrides,
  };
}

describe('resolvePermission precedence', () => {
  // Each layer set to a different state, so the winning layer is visible in the
  // answer. Removing the top layer each time proves the next one beats all below.
  const agent: AgentPermissions = {
    actions: { 'rooms.create': 'blocked' },
    areas: { rooms: 'ask' },
  };
  const defaults: PermissionOverrides = {
    actions: { 'rooms.create': 'allowed' },
    areas: { rooms: 'blocked' },
  };
  // Careful puts rooms at `ask`, distinct from the default-area `blocked` above.
  const config = { preset: 'careful' as const, defaults };

  it('agent action beats every layer below it', () => {
    expect(resolvePermission(input({ agent, config }))).toMatchObject({
      state: 'blocked',
      source: 'agent-action',
      layer: 'agent',
    });
  });

  it('agent area beats the default layer', () => {
    const r = resolvePermission(input({ agent: { areas: agent.areas }, config }));
    expect(r).toMatchObject({ state: 'ask', source: 'agent-area', layer: 'agent' });
  });

  it('default action beats default area and preset', () => {
    const r = resolvePermission(input({ config }));
    expect(r).toMatchObject({ state: 'allowed', source: 'default-action', layer: 'default' });
  });

  it('default area beats the preset', () => {
    const r = resolvePermission(
      input({ config: { ...config, defaults: { areas: defaults.areas, actions: {} } } })
    );
    expect(r).toMatchObject({ state: 'blocked', source: 'default-area', layer: 'default' });
  });

  it('falls back to the preset table', () => {
    const r = resolvePermission(input({ config: { preset: 'careful', defaults: EMPTY } }));
    expect(r).toMatchObject({ state: 'ask', source: 'preset', layer: 'default' });
  });

  it('inside the agent layer, the action beats the area', () => {
    const r = resolvePermission(
      input({ agent: { areas: { rooms: 'blocked' }, actions: { 'rooms.create': 'allowed' } } })
    );
    expect(r).toMatchObject({ state: 'allowed', source: 'agent-action' });
  });

  it('an unidentified caller (no agent) skips the agent layers', () => {
    const r = resolvePermission(input({ agent: undefined, config }));
    expect(r.source).toBe('default-action');
  });
});

describe('destructive rule', () => {
  // An area-level Allowed must not wave through a delete; only a person naming
  // the exact action lets it run without asking.
  it('turns an area-level Allowed on a destructive action into Ask', () => {
    for (const r of [
      resolvePermission(
        input({ tier: 'destructive', config: { preset: 'full', defaults: EMPTY } })
      ),
      resolvePermission(
        input({
          tier: 'destructive',
          config: { preset: null, defaults: { areas: { rooms: 'allowed' }, actions: {} } },
        })
      ),
      resolvePermission(input({ tier: 'destructive', agent: { areas: { rooms: 'allowed' } } })),
    ]) {
      expect(r.state).toBe('ask');
      expect(r.destructiveAsk).toBe(true);
    }
  });

  it('keeps an action-level Allowed (agent or default)', () => {
    const agentLevel = resolvePermission(
      input({ tier: 'destructive', agent: { actions: { 'rooms.create': 'allowed' } } })
    );
    const defaultLevel = resolvePermission(
      input({
        tier: 'destructive',
        config: {
          preset: 'careful',
          defaults: { areas: {}, actions: { 'rooms.create': 'allowed' } },
        },
      })
    );
    expect(agentLevel).toMatchObject({ state: 'allowed', source: 'agent-action' });
    expect(agentLevel.destructiveAsk).toBeUndefined();
    expect(defaultLevel).toMatchObject({ state: 'allowed', source: 'default-action' });
  });

  it('leaves act and observe actions alone', () => {
    for (const tier of ['act', 'observe'] as const) {
      const r = resolvePermission(input({ tier, config: { preset: 'full', defaults: EMPTY } }));
      expect(r.state).toBe('allowed');
      expect(r.destructiveAsk).toBeUndefined();
    }
  });
});

describe('floor clamp', () => {
  // A floor area is never Allowed, whichever layer tried.
  const base = { area: 'permissions' as const, actionId: 'permissions.change' };
  it.each([
    ['agent action', { agent: { actions: { 'permissions.change': 'allowed' as const } } }],
    ['agent area', { agent: { areas: { permissions: 'allowed' as const } } }],
    [
      'default action',
      {
        config: {
          preset: 'full' as const,
          defaults: { areas: {}, actions: { 'permissions.change': 'allowed' as const } },
        },
      },
    ],
    [
      'default area',
      {
        config: {
          preset: 'full' as const,
          defaults: { areas: { permissions: 'allowed' as const }, actions: {} },
        },
      },
    ],
  ])('clamps Allowed from the %s layer to Ask', (_label, extra) => {
    const r = resolvePermission(input({ ...base, ...extra }));
    expect(r).toMatchObject({ state: 'ask', source: 'floor', layer: 'floor' });
  });

  it('leaves Blocked in a floor area alone', () => {
    const r = resolvePermission(input({ ...base, agent: { areas: { permissions: 'blocked' } } }));
    expect(r).toMatchObject({ state: 'blocked', source: 'agent-area' });
  });
});

describe('inactive identity', () => {
  it('beats an agent-action Allowed', () => {
    const r = resolvePermission(
      input({ inactive: true, agent: { actions: { 'rooms.create': 'allowed' } } })
    );
    expect(r).toMatchObject({ state: 'blocked', source: 'inactive', layer: 'agent' });
  });
});

describe('forward compatibility and hostile keys', () => {
  it('ignores unknown area and action keys', () => {
    const r = resolvePermission(
      input({
        agent: { areas: { future: 'allowed' }, actions: { 'future.verb': 'allowed' } },
        config: { preset: 'careful', defaults: EMPTY },
      })
    );
    expect(r).toMatchObject({ state: 'ask', source: 'preset' });
  });

  it('never reads an inherited prototype key', () => {
    const r = resolvePermission(
      input({ actionId: 'constructor', config: { preset: 'careful', defaults: EMPTY } })
    );
    expect(r.source).toBe('preset');
  });
});

describe('Unchanged (no preset chosen)', () => {
  const config = { preset: null, defaults: EMPTY };
  it('blocks Rooms management, as the old off-by-default tool group did', () => {
    expect(resolvePermission(input({ config }))).toMatchObject({
      state: 'blocked',
      source: 'unchanged',
    });
  });

  it('keeps rooms.merge running, since it was never behind that group', () => {
    const r = resolvePermission(input({ actionId: 'rooms.merge', config }));
    expect(r).toMatchObject({ state: 'allowed', source: 'unchanged' });
  });

  it('allows the non-floor areas and blocks the floor ones', () => {
    expect(resolvePermission(input({ area: 'tasks', actionId: 'x.y', config })).state).toBe(
      'allowed'
    );
    expect(resolvePermission(input({ area: 'reach', actionId: 'x.y', config })).state).toBe(
      'blocked'
    );
  });
});

describe('resolveFilesAndCommands', () => {
  // The order a trust stop is looked up in: agent, runtime, global, then the
  // runtime's own behaviour.
  it('agent beats runtime beats global', () => {
    expect(
      resolveFilesAndCommands({
        agent: { filesAndCommands: 'ask' },
        perRuntime: 'act',
        global: 'autonomy',
      })
    ).toEqual({ stop: 'ask', source: 'agent' });
    expect(resolveFilesAndCommands({ agent: {}, perRuntime: 'act', global: 'autonomy' })).toEqual({
      stop: 'act',
      source: 'runtime',
    });
    expect(resolveFilesAndCommands({ perRuntime: null, global: 'autonomy' })).toEqual({
      stop: 'autonomy',
      source: 'default',
    });
  });

  it("falls back to the runtime's own default", () => {
    expect(resolveFilesAndCommands({})).toEqual({ stop: null, source: 'runtime-own' });
  });
});
