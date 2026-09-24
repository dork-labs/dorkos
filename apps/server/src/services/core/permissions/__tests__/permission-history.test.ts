/**
 * Reading the permission history back (spec `agent-permissions` D14): newest
 * first, per agent including the bulk changes that touched it, and honest about
 * who made a login-off change.
 */
import { describe, it, expect } from 'vitest';

import { listPermissionHistory, personWriter } from '../permission-history.js';
import { TWO_AGENTS, createPermissionWorld } from './permission-fixtures.js';

const LOCAL = personWriter('local-trust');

describe('listPermissionHistory', () => {
  it('returns permission events newest first', async () => {
    const world = createPermissionWorld({ agents: TWO_AGENTS });
    await world.service.setDefaults({ areas: { rooms: 'ask' }, surface: 'settings' }, LOCAL);
    await world.service.setDefaults({ areas: { rooms: 'allowed' }, surface: 'settings' }, LOCAL);

    const history = await listPermissionHistory(world.activity, { limit: 10 });

    expect(history.items.map((i) => i.summary)).toEqual([
      'Rooms set to Allowed for everyone',
      'Rooms set to Ask for everyone',
    ]);
  });

  it('filters to one agent, including a bulk change that touched it', async () => {
    const world = createPermissionWorld({ agents: TWO_AGENTS });
    // A default change that brought the auditor along (bulk, no resourceId).
    await world.service.setDefaults(
      { areas: { rooms: 'allowed' }, applyToAgents: ['agent-auditor'], surface: 'settings' },
      LOCAL
    );
    // A change to the other agent only.
    await world.service.setAgent(
      'agent-test',
      { areas: { rooms: 'ask' }, surface: 'agent-page' },
      LOCAL
    );
    // A change to the auditor only.
    await world.service.setAgent(
      'agent-auditor',
      { areas: { rooms: 'blocked' }, surface: 'agent-page' },
      LOCAL
    );

    const history = await listPermissionHistory(world.activity, {
      agentId: 'agent-auditor',
      limit: 10,
    });

    expect(history.items).toHaveLength(2);
    expect(history.items.map((i) => i.summary)).toEqual([
      'security-auditor: Rooms Blocked',
      'Rooms set to Allowed for everyone, and 1 agent updated',
    ]);
  });

  it('says why a login-off change cannot name who made it', async () => {
    const world = createPermissionWorld();
    await world.service.setDefaults({ areas: { rooms: 'ask' }, surface: 'settings' }, LOCAL);

    const [row] = (await listPermissionHistory(world.activity, { limit: 10 })).items;

    expect(row).toMatchObject({
      actorLabel: 'Someone on this computer',
      actorDetail: "Login is off, so DorkOS can't confirm who made this change.",
    });
    expect(row!.actorLabel).not.toMatch(/\bYou\b/);
  });

  it('ignores other categories', async () => {
    const world = createPermissionWorld();
    await world.activity.emit({
      actorType: 'user',
      actorLabel: 'You',
      category: 'config',
      eventType: 'config.changed',
      summary: 'Theme changed',
      resourceType: null,
      resourceId: null,
      resourceLabel: null,
      linkPath: null,
      actorId: null,
      metadata: null,
    });
    expect((await listPermissionHistory(world.activity, { limit: 10 })).items).toEqual([]);
  });
});
