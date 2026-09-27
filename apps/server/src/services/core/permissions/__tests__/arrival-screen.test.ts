/**
 * A newly arrived agent's own settings file never widens what it may do
 * (spec `agent-permissions`, fix round for D1). Whatever path registered the
 * folder, the settings it carried are kept only where they are at least as
 * strict as the defaults; the rest is dropped from the file, with one history
 * line saying so. An agent DorkOS has already seen is left alone.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionChangedMetadata } from '@dorkos/shared/permissions';

import { ARRIVAL_NOTE, ARRIVAL_WRITE_FAILED_NOTE } from '../permission-service.js';
import { isAlwaysOffered } from '../../approvals/index.js';
import { createPermissionWorld, type FixtureAgent } from './permission-fixtures.js';

const WIDE: FixtureAgent = {
  id: 'agent-new',
  name: 'newcomer',
  projectPath: '/agents/newcomer',
  permissions: {
    areas: { rooms: 'allowed', tasks: 'blocked' },
    actions: { 'rooms.merge': 'allowed' },
    filesAndCommands: 'autonomy',
  },
};

describe('screening an arriving agent', () => {
  it('keeps only what is strictly stricter than the defaults, and records one line', async () => {
    const world = createPermissionWorld({ preset: 'careful', trustStop: 'ask', agents: [WIDE] });

    const { changes, written } = await world.service.screenArrivedAgent('agent-new');

    expect(written).toBe(true);
    // Careful asks for Tasks, so Blocked is stricter and stays.
    expect(world.agents.get('agent-new')?.permissions).toEqual({ areas: { tasks: 'blocked' } });
    expect(changes.map((c) => c.key)).toEqual([
      { kind: 'area', area: 'rooms' },
      { kind: 'action', action: 'rooms.merge', area: 'rooms' },
      { kind: 'files' },
    ]);
    expect(world.events).toHaveLength(1);
    const meta = world.events[0]!.metadata as unknown as PermissionChangedMetadata & {
      note?: string;
    };
    expect(meta.note).toBe(ARRIVAL_NOTE);
    expect(world.events[0]!.actorLabel).toBe('DorkOS');
  });

  it('drops a setting equal to the default, so the agent inherits it', async () => {
    const world = createPermissionWorld({
      preset: 'careful',
      trustStop: 'ask',
      agents: [{ ...WIDE, permissions: { areas: { rooms: 'ask' }, filesAndCommands: 'ask' } }],
    });
    const { changes } = await world.service.screenArrivedAgent('agent-new');
    expect(changes.map((c) => c.key.kind)).toEqual(['area', 'files']);
    expect(world.agents.get('agent-new')?.permissions).toBeUndefined();
  });

  it('keeps only Ask first for Files & commands when nobody set a stop for everyone', async () => {
    const world = createPermissionWorld({
      preset: 'full',
      trustStop: null,
      agents: [{ ...WIDE, permissions: { filesAndCommands: 'act' } }],
    });
    await world.service.screenArrivedAgent('agent-new');
    expect(world.agents.get('agent-new')?.permissions).toBeUndefined();
  });

  it('says so, and reports the write as not done, when the file cannot be written', async () => {
    const world = createPermissionWorld({
      preset: 'careful',
      trustStop: 'ask',
      agents: [WIDE],
      writeFails: true,
    });
    await expect(world.service.screenArrivedAgent('agent-new')).rejects.toThrow(/EACCES/);
    expect(world.events).toHaveLength(1);
    expect(world.events[0]!.metadata).toMatchObject({ note: ARRIVAL_WRITE_FAILED_NOTE });
  });
});

describe('an action that always shows what it would change', () => {
  it('cannot be set to Allowed, for everyone or for one agent', async () => {
    const world = createPermissionWorld({ agents: [WIDE] });
    const writer = {
      attribution: 'local-trust' as const,
      actorType: 'user' as const,
      actorLabel: 'Someone on this computer',
    };
    await expect(
      world.service.setDefaults(
        { actions: { 'operator.update_agent_execution': 'allowed' }, surface: 'settings' },
        writer
      )
    ).rejects.toMatchObject({ code: 'ALWAYS_ASKS' });
    await expect(
      world.service.setAgent(
        'agent-new',
        { actions: { 'operator.update_agent_execution': 'allowed' }, surface: 'agent-page' },
        writer
      )
    ).rejects.toMatchObject({ code: 'ALWAYS_ASKS' });
  });

  it('shows Ask with its reason when an Allowed is stored anyway', async () => {
    const world = createPermissionWorld({
      preset: 'full',
      agents: [
        { ...WIDE, permissions: { actions: { 'operator.update_agent_execution': 'allowed' } } },
      ],
    });
    const view = await world.service.getAgent('agent-new');
    const action = view.areas
      .find((a) => a.id === 'agents')!
      .actions.find((a) => a.id === 'operator.update_agent_execution')!;
    expect(action).toMatchObject({
      alwaysAsks: true,
      resolved: { state: 'ask', source: 'always-asks' },
    });
  });
});

describe('which cards offer Always allow', () => {
  const card = {
    requestedByPath: '/agents/newcomer',
    area: 'agents',
    authorityBindingDigest: null,
  };
  it('offers it on an ordinary card', () => {
    expect(isAlwaysOffered({ ...card, detail: null })).toBe(true);
  });
  it('never on a card that shows what would change', () => {
    expect(isAlwaysOffered({ ...card, detail: 'Model: a → b' })).toBe(false);
  });
});
