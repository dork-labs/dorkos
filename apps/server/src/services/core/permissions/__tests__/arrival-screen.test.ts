/**
 * A newly arrived agent's own settings file never widens what it may do
 * (spec `agent-permissions`, fix round for D1). Whatever path registered the
 * folder, the settings it carried are kept only where they are at least as
 * strict as the defaults; the rest is dropped from the file, with one history
 * line saying so. An agent DorkOS has already seen is left alone.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionChangedMetadata } from '@dorkos/shared/permissions';

import { ARRIVAL_NOTE } from '../permission-service.js';
import { createPermissionWorld } from './permission-fixtures.js';

const WIDE = {
  id: 'agent-new',
  name: 'newcomer',
  projectPath: '/agents/newcomer',
  permissions: {
    areas: { rooms: 'allowed' as const, tasks: 'blocked' as const },
    actions: { 'rooms.merge': 'allowed' as const },
    filesAndCommands: 'autonomy' as const,
  },
};

describe('screening an arriving agent', () => {
  it('keeps stricter settings, drops wider ones, and records one line', async () => {
    const world = createPermissionWorld({ preset: 'careful', trustStop: 'ask', agents: [WIDE] });

    const changes = await world.service.screenArrivedAgent('agent-new');

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

  it('keeps a setting that only matches what everyone already has', async () => {
    const world = createPermissionWorld({
      preset: 'full',
      trustStop: 'autonomy',
      agents: [{ ...WIDE, permissions: { areas: { rooms: 'allowed' }, filesAndCommands: 'act' } }],
    });
    expect(await world.service.screenArrivedAgent('agent-new')).toEqual([]);
    expect(world.events).toEqual([]);
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

  it('leaves an agent DorkOS has already seen exactly as it is', async () => {
    const world = createPermissionWorld({
      preset: 'careful',
      trustStop: 'ask',
      agents: [WIDE],
      seen: ['agent-new'],
    });
    expect(await world.service.screenArrivedAgent('agent-new')).toEqual([]);
    expect(world.agents.get('agent-new')?.permissions).toEqual(WIDE.permissions);
  });
});
