/**
 * Undo from the permission history (spec `agent-permissions` D14, task 4.1):
 * the inverse write as a new audited change, the conflict path, bulk changes,
 * preset switches, and the rules an Undo can never break.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionChangedMetadata } from '@dorkos/shared/permissions';

import {
  listPermissionHistory,
  personWriter,
  recordPermissionChange,
} from '../permission-history.js';
import { TWO_AGENTS, createPermissionWorld } from './permission-fixtures.js';

const LOCAL = personWriter('local-trust');

/** The metadata of one recorded event. */
function metaOf(event: { metadata: Record<string, unknown> | null } | undefined) {
  return event!.metadata as unknown as PermissionChangedMetadata;
}

describe('PermissionService.undo', () => {
  it('writes the inverse as a NEW change, recorded with surface undo and undoOf', async () => {
    const world = createPermissionWorld({ preset: 'careful' });
    await world.service.setDefaults({ areas: { rooms: 'allowed' }, surface: 'settings' }, LOCAL);
    const changed = world.events[0]!;

    const result = await world.service.undo(changed.id, {}, LOCAL);

    expect(world.config.defaults.areas).toEqual({});
    expect(result).toEqual({
      changes: [
        {
          target: { kind: 'default' },
          key: { kind: 'area', area: 'rooms' },
          before: 'allowed',
          after: null,
        },
      ],
      skipped: [],
    });
    expect(world.events).toHaveLength(2);
    expect(world.events[1]).toMatchObject({
      eventType: 'permission.changed',
      actorLabel: 'Someone on this computer',
      summary: 'Undo: Rooms set back to the preset for everyone',
    });
    expect(metaOf(world.events[1])).toMatchObject({ surface: 'undo', undoOf: changed.id });
  });

  it('refuses a key that changed since (409 UNDO_CONFLICT), naming it, and writes nothing', async () => {
    const world = createPermissionWorld({ preset: 'careful' });
    await world.service.setDefaults({ areas: { rooms: 'allowed' }, surface: 'settings' }, LOCAL);
    const first = world.events[0]!.id;
    await world.service.setDefaults({ areas: { rooms: 'blocked' }, surface: 'cli' }, LOCAL);

    await expect(world.service.undo(first, {}, LOCAL)).rejects.toMatchObject({
      code: 'UNDO_CONFLICT',
      status: 409,
      details: {
        conflicts: [
          {
            change: expect.objectContaining({ before: null, after: 'allowed' }),
            current: 'blocked',
            reason: 'changed-since',
          },
        ],
      },
    });
    expect(world.config.defaults.areas).toEqual({ rooms: 'blocked' });
    expect(world.events).toHaveLength(2);
  });

  it('sets a key that changed since back anyway with force', async () => {
    const world = createPermissionWorld({ preset: 'careful' });
    await world.service.setDefaults({ areas: { rooms: 'ask' }, surface: 'settings' }, LOCAL);
    const first = world.events[0]!.id;
    await world.service.setDefaults({ areas: { rooms: 'blocked' }, surface: 'cli' }, LOCAL);

    const result = await world.service.undo(first, { force: true }, LOCAL);

    expect(world.config.defaults.areas).toEqual({});
    expect(result.skipped).toEqual([]);
    expect(result.changes).toEqual([expect.objectContaining({ before: 'blocked', after: null })]);
  });

  it('undoes a bulk change for every target that still matches, and reports the rest', async () => {
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
    const bulk = world.events[0]!.id;
    // Since then, security-auditor was set on its own again.
    await world.service.setAgent(
      'agent-auditor',
      { areas: { rooms: 'ask' }, surface: 'agent-page' },
      LOCAL
    );

    const result = await world.service.undo(bulk, {}, LOCAL);

    // The default and third go back; security-auditor keeps its newer setting.
    expect(world.config.defaults.areas).toEqual({});
    expect(world.agentArea('agent-third', 'rooms')).toBe('ask');
    expect(world.agentArea('agent-auditor', 'rooms')).toBe('ask');
    expect(result.changes).toHaveLength(2);
    expect(result.skipped).toEqual([
      {
        change: expect.objectContaining({
          target: expect.objectContaining({ agentId: 'agent-auditor' }),
          before: 'blocked',
          after: null,
        }),
        current: 'ask',
        reason: 'changed-since',
      },
    ]);
    // One new event for the whole Undo.
    expect(world.events).toHaveLength(3);
    expect(metaOf(world.events[2]).changes).toHaveLength(2);
  });

  it('refuses a bulk change where nothing still matches', async () => {
    const world = createPermissionWorld({ preset: 'careful', agents: TWO_AGENTS });
    await world.service.setDefaults(
      { areas: { rooms: 'allowed' }, applyToAgents: ['agent-auditor'], surface: 'settings' },
      LOCAL
    );
    const bulk = world.events[0]!.id;
    await world.service.setDefaults({ areas: { rooms: 'ask' }, surface: 'settings' }, LOCAL);
    await world.service.setAgent(
      'agent-auditor',
      { areas: { rooms: 'ask' }, surface: 'agent-page' },
      LOCAL
    );

    await expect(world.service.undo(bulk, {}, LOCAL)).rejects.toMatchObject({
      code: 'UNDO_CONFLICT',
    });
  });

  it('puts a preset switch back as one unit: preset, cleared changes and the stop', async () => {
    const world = createPermissionWorld({
      preset: 'balanced',
      defaults: { areas: { rooms: 'blocked' }, actions: { 'rooms.merge': 'ask' } },
      trustStop: 'act',
      autonomyAcknowledged: true,
    });
    await world.service.setPreset({ preset: 'full', surface: 'settings' }, LOCAL);
    expect(world.stops.global).toBe('autonomy');
    const switched = world.events[0]!.id;
    // A default the switch never touched, changed afterwards, is left alone.
    await world.service.setDefaults({ areas: { tasks: 'blocked' }, surface: 'settings' }, LOCAL);

    await world.service.undo(switched, {}, LOCAL);

    expect(world.config.preset).toBe('balanced');
    expect(world.config.defaults).toEqual({
      areas: { rooms: 'blocked', tasks: 'blocked' },
      actions: { 'rooms.merge': 'ask' },
    });
    expect(world.stops.global).toBe('act');
    // The Undo is itself a preset switch, so its own Undo moves them together.
    expect(metaOf(world.events.at(-1)).presetSnapshot).toEqual({
      preset: 'full',
      defaults: { areas: { tasks: 'blocked' }, actions: {} },
      trustStop: 'autonomy',
    });
  });

  it('refuses a preset switch whose preset moved on, whole', async () => {
    const world = createPermissionWorld({ preset: 'balanced', autonomyAcknowledged: true });
    await world.service.setPreset({ preset: 'full', surface: 'settings' }, LOCAL);
    const switched = world.events[0]!.id;
    await world.service.setPreset({ preset: 'careful', surface: 'settings' }, LOCAL);

    await expect(world.service.undo(switched, {}, LOCAL)).rejects.toMatchObject({
      code: 'UNDO_CONFLICT',
    });
    expect(world.config.preset).toBe('careful');
  });

  it('asks for the Full autonomy acknowledgement (428) before writing anything', async () => {
    // The stop was Full autonomy with no acknowledgement on file (set outside
    // the app), and a switch to Balanced moved it to Act.
    const world = createPermissionWorld({ preset: 'full', trustStop: 'autonomy' });
    await world.service.setPreset({ preset: 'balanced', surface: 'settings' }, LOCAL);
    const switched = world.events[0]!.id;

    await expect(world.service.undo(switched, {}, LOCAL)).rejects.toMatchObject({
      code: 'AUTONOMY_ACK_REQUIRED',
      status: 428,
    });
    expect(world.config.preset).toBe('balanced');
    expect(world.stops.global).toBe('act');

    await world.service.undo(switched, { acknowledgeAutonomy: true }, LOCAL);
    expect(world.config.preset).toBe('full');
    expect(world.stops.global).toBe('autonomy');
    expect(world.autonomy.acknowledgedAt).not.toBeNull();
  });

  it('never writes Allowed in a locked area, force or not, and says so', async () => {
    const world = createPermissionWorld({
      agents: [{ ...TWO_AGENTS[1]!, permissions: { areas: { reach: 'ask', rooms: 'ask' } } }],
    });
    // A change DorkOS noticed rather than made: the file had said Allowed.
    await recordPermissionChange(world.activity, {
      changes: [
        {
          target: {
            kind: 'agent',
            agentId: 'agent-test',
            agentPath: '/agents/test-bot',
            agentName: 'Test Bot',
          },
          key: { kind: 'area', area: 'reach' },
          before: 'allowed',
          after: 'ask',
        },
        {
          target: {
            kind: 'agent',
            agentId: 'agent-test',
            agentPath: '/agents/test-bot',
            agentName: 'Test Bot',
          },
          key: { kind: 'area', area: 'rooms' },
          before: null,
          after: 'ask',
        },
      ],
      surface: 'file-edit',
      writer: { attribution: 'outside', actorType: 'system', actorLabel: 'Outside DorkOS' },
    });

    const result = await world.service.undo(world.events[0]!.id, { force: true }, LOCAL);

    expect(world.agentArea('agent-test', 'reach')).toBe('ask');
    expect(world.agentArea('agent-test', 'rooms')).toBeUndefined();
    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'floor', current: 'ask' })]);
  });

  it('never sets an action that always asks back to Allowed', async () => {
    const world = createPermissionWorld({
      agents: [
        {
          ...TWO_AGENTS[1]!,
          permissions: { actions: { 'operator.update_agent_execution': 'ask' } },
        },
      ],
    });
    // A file edit DorkOS noticed: the file had said Allowed.
    await recordPermissionChange(world.activity, {
      changes: [
        {
          target: {
            kind: 'agent',
            agentId: 'agent-test',
            agentPath: '/agents/test-bot',
            agentName: 'Test Bot',
          },
          key: { kind: 'action', action: 'operator.update_agent_execution', area: 'agents' },
          before: 'allowed',
          after: 'ask',
        },
      ],
      surface: 'file-edit',
      writer: { attribution: 'outside', actorType: 'system', actorLabel: 'Outside DorkOS' },
    });

    const result = await world.service.undo(world.events[0]!.id, { force: true }, LOCAL);

    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'floor' })]);
    expect(world.agents.get('agent-test')?.permissions?.actions).toEqual({
      'operator.update_agent_execution': 'ask',
    });
  });

  it('reports a change about an agent that no longer exists as gone', async () => {
    const world = createPermissionWorld({ agents: TWO_AGENTS });
    await world.service.setAgent(
      'agent-test',
      { areas: { rooms: 'blocked' }, surface: 'agent-page' },
      LOCAL
    );
    world.agents.delete('agent-test');

    const result = await world.service.undo(world.events[0]!.id, {}, LOCAL);

    expect(result).toEqual({
      changes: [],
      skipped: [expect.objectContaining({ reason: 'gone', current: null })],
    });
  });

  it('treats a change already undone as nothing to do, never as changed since', async () => {
    const world = createPermissionWorld({ preset: 'careful', agents: TWO_AGENTS });
    await world.service.setDefaults(
      { areas: { rooms: 'allowed' }, applyToAgents: ['agent-auditor'], surface: 'settings' },
      LOCAL
    );
    const bulk = world.events[0]!.id;
    await world.service.undo(bulk, {}, LOCAL);
    await world.service.setDefaults({ areas: { rooms: 'ask' }, surface: 'settings' }, LOCAL);

    // Single target, already back: no conflict, nothing written.
    const single = createPermissionWorld({ preset: 'careful' });
    await single.service.setDefaults({ areas: { rooms: 'ask' }, surface: 'settings' }, LOCAL);
    await single.service.undo(single.events[0]!.id, {}, LOCAL);
    await expect(single.service.undo(single.events[0]!.id, {}, LOCAL)).resolves.toEqual({
      changes: [],
      skipped: [],
    });
    expect(single.events).toHaveLength(2);

    // Bulk: the auditor is already back, so only the default (changed since)
    // is reported; the auditor is not.
    await expect(world.service.undo(bulk, {}, LOCAL)).rejects.toMatchObject({
      code: 'UNDO_CONFLICT',
      details: { conflicts: [expect.objectContaining({ current: 'ask' })] },
    });
  });

  it('runs two Undos of one change one after the other: the second finds nothing to do', async () => {
    const world = createPermissionWorld({ preset: 'careful', agents: TWO_AGENTS });
    await world.service.setAgent(
      'agent-test',
      { areas: { rooms: 'blocked' }, surface: 'agent-page' },
      LOCAL
    );
    const eventId = world.events[0]!.id;

    const [a, b] = await Promise.all([
      world.service.undo(eventId, {}, LOCAL),
      world.service.undo(eventId, {}, LOCAL),
    ]);

    expect([a.changes.length, b.changes.length].sort()).toEqual([0, 1]);
    expect(world.events).toHaveLength(2);
  });

  it('keeps both of two writes to one agent made side by side', async () => {
    const world = createPermissionWorld({ agents: TWO_AGENTS });
    await Promise.all([
      world.service.setAgent('agent-test', { areas: { rooms: 'blocked' }, surface: 'api' }, LOCAL),
      world.service.setAgent('agent-test', { areas: { tasks: 'ask' }, surface: 'api' }, LOCAL),
    ]);
    expect(world.agents.get('agent-test')?.permissions?.areas).toEqual({
      rooms: 'blocked',
      tasks: 'ask',
    });
  });

  it('undoes an Undo, which puts the change back', async () => {
    const world = createPermissionWorld({ agents: TWO_AGENTS });
    await world.service.setAgent(
      'agent-test',
      { actions: { 'rooms.create': 'allowed' }, surface: 'request-card', approvalId: 'appr-1' },
      LOCAL
    );
    await world.service.undo(world.events[0]!.id, {}, LOCAL);
    expect(world.agents.get('agent-test')?.permissions).toBeUndefined();

    await world.service.undo(world.events[1]!.id, {}, LOCAL);

    expect(world.agents.get('agent-test')?.permissions).toEqual({
      actions: { 'rooms.create': 'allowed' },
    });
  });

  it('words a Files & commands change as the stop in its history line', async () => {
    const world = createPermissionWorld({ agents: TWO_AGENTS, autonomyAcknowledged: true });
    await world.service.setAgent(
      'agent-test',
      { filesAndCommands: 'ask', surface: 'agent-page' },
      LOCAL
    );
    expect(world.events[0]!.summary).toBe('Test Bot: Files & commands Ask first');
  });

  it('restores a per-runtime Files & commands stop', async () => {
    const world = createPermissionWorld({ runtimeStops: { codex: 'ask' } });
    await recordPermissionChange(world.activity, {
      changes: [
        {
          target: { kind: 'default' },
          key: { kind: 'files', runtime: 'codex' },
          before: null,
          after: 'ask',
        },
      ],
      surface: 'api',
      writer: LOCAL,
    });

    await world.service.undo(world.events[0]!.id, {}, LOCAL);

    expect(world.stops.perRuntime.codex).toBeNull();
  });

  it('has no Undo for an answer on a request card, or a line that is not a change', async () => {
    const world = createPermissionWorld();
    const row = {
      actorId: null,
      resourceType: null,
      resourceId: null,
      resourceLabel: null,
      linkPath: null,
      category: 'permissions' as const,
    };
    await world.activity.emit({
      ...row,
      actorType: 'user',
      actorLabel: 'Someone on this computer',
      eventType: 'permission.answered',
      summary: 'allowed once',
      metadata: { action: 'rooms.create', answer: 'once' },
    });
    await world.activity.emit({
      ...row,
      actorType: 'system',
      actorLabel: 'Upgrade',
      eventType: 'permission.standing_grant_ended',
      summary: 'ended',
      metadata: null,
    });

    await expect(world.service.undo(world.events[0]!.id, {}, LOCAL)).rejects.toMatchObject({
      code: 'NOT_UNDOABLE',
      status: 409,
    });
    await expect(world.service.undo(world.events[1]!.id, {}, LOCAL)).rejects.toMatchObject({
      code: 'NOT_UNDOABLE',
    });
    await expect(world.service.undo('evt-missing', {}, LOCAL)).rejects.toMatchObject({
      code: 'UNKNOWN_EVENT',
      status: 404,
    });
  });
});

describe('what the history says about Undo', () => {
  it('marks a line undone only while its Undo stands, across pages', async () => {
    const world = createPermissionWorld({ preset: 'careful' });
    await world.service.setDefaults({ areas: { rooms: 'ask' }, surface: 'settings' }, LOCAL);
    const first = world.events[0]!.id;
    await world.service.undo(first, {}, LOCAL);
    const undo = world.events[1]!.id;

    // The Undo is newer than the page asked for; it still counts.
    const older = await listPermissionHistory(world.activity, {
      before: world.events[1]!.occurredAt,
      limit: 1,
    });
    expect(older.items[0]).toMatchObject({ id: first, undoable: true, undone: true });

    // Undo the Undo: the first change is in effect again.
    await world.service.undo(undo, {}, LOCAL);
    const all = await listPermissionHistory(world.activity, { limit: 10 });
    const byId = new Map(all.items.map((item) => [item.id, item]));
    expect(byId.get(first)).toMatchObject({ undone: false });
    expect(byId.get(undo)).toMatchObject({ undone: true });
  });

  it('gives an answer on a request card no Undo', async () => {
    const world = createPermissionWorld();
    await world.activity.emit({
      actorId: null,
      resourceType: 'agent',
      resourceId: null,
      resourceLabel: null,
      linkPath: null,
      category: 'permissions',
      actorType: 'user',
      actorLabel: 'Someone on this computer',
      eventType: 'permission.answered',
      summary: 'allowed once',
      metadata: {
        action: 'rooms.create',
        area: 'rooms',
        answer: 'once',
        approvalId: 'a1',
        blockedRequest: false,
        posture: 'local-trust',
      },
    });
    const history = await listPermissionHistory(world.activity, { limit: 10 });
    expect(history.items[0]).toMatchObject({ undoable: false, undone: false });
  });
});

describe('the last change behind each state (the "why?" lines)', () => {
  it('names the change that set a default, on the default layer and on an agent that follows it', async () => {
    const world = createPermissionWorld({ preset: 'full', agents: TWO_AGENTS });
    await world.service.setDefaults({ areas: { tasks: 'blocked' }, surface: 'settings' }, LOCAL);
    const eventId = world.events[0]!.id;

    const overview = await world.service.getOverview();
    const tasks = overview.areas.find((a) => a.id === 'tasks')!;
    expect(tasks.lastChange).toEqual({
      eventId,
      occurredAt: world.events[0]!.occurredAt,
      actorLabel: 'Someone on this computer',
      attribution: 'local-trust',
      surface: 'settings',
    });
    const agent = await world.service.getAgent('agent-test');
    expect(agent.areas.find((a) => a.id === 'tasks')!.lastChange?.eventId).toBe(eventId);
    // An area nobody changed has no last change to name.
    expect(overview.areas.find((a) => a.id === 'agents')!.lastChange).toBeUndefined();
  });

  it("names an agent's own change, and a newer reset over an older default change", async () => {
    const world = createPermissionWorld({ preset: 'full', agents: TWO_AGENTS });
    await world.service.setDefaults({ areas: { rooms: 'ask' }, surface: 'settings' }, LOCAL);
    await world.service.setAgent(
      'agent-test',
      { areas: { rooms: 'blocked' }, surface: 'agent-page' },
      LOCAL
    );
    const own = await world.service.getAgent('agent-test');
    expect(own.areas.find((a) => a.id === 'rooms')!.lastChange?.surface).toBe('agent-page');

    await world.service.setAgent(
      'agent-test',
      { areas: { rooms: null }, surface: 'control-center' },
      LOCAL
    );
    const reset = await world.service.getAgent('agent-test');
    // It follows the default again, and the reset is what made it so.
    expect(reset.areas.find((a) => a.id === 'rooms')!.resolved.source).toBe('default-area');
    expect(reset.areas.find((a) => a.id === 'rooms')!.lastChange?.surface).toBe('control-center');

    const overview = await world.service.getOverview();
    expect(overview.exceptions.find((e) => e.agentId === 'agent-auditor')?.lastChange).toBe(
      undefined
    );
  });

  it("never credits an agent's own area to a later default change", async () => {
    const world = createPermissionWorld({ preset: 'full', agents: TWO_AGENTS });
    await world.service.setAgent(
      'agent-test',
      { areas: { rooms: 'blocked' }, surface: 'agent-page' },
      LOCAL
    );
    await world.service.setDefaults({ areas: { rooms: 'ask' }, surface: 'cli' }, LOCAL);
    const rooms = (await world.service.getAgent('agent-test')).areas.find((a) => a.id === 'rooms')!;
    expect(rooms.resolved.source).toBe('agent-area');
    expect(rooms.lastChange?.surface).toBe('agent-page');
  });

  it("never credits an agent's own action to a later preset switch", async () => {
    const world = createPermissionWorld({
      preset: 'balanced',
      agents: TWO_AGENTS,
      autonomyAcknowledged: true,
    });
    await world.service.setAgent(
      'agent-test',
      { actions: { 'rooms.create': 'allowed' }, surface: 'request-card', approvalId: 'a1' },
      LOCAL
    );
    await world.service.setPreset({ preset: 'careful', surface: 'settings' }, LOCAL);
    const action = (await world.service.getAgent('agent-test')).areas
      .find((a) => a.id === 'rooms')!
      .actions.find((a) => a.id === 'rooms.create')!;
    expect(action.resolved.source).toBe('agent-action');
    expect(action.lastChange?.surface).toBe('request-card');
  });

  it("never credits an agent's own Files & commands stop to a later global stop change", async () => {
    const world = createPermissionWorld({
      preset: 'balanced',
      agents: TWO_AGENTS,
      autonomyAcknowledged: true,
    });
    await world.service.setAgent(
      'agent-test',
      { filesAndCommands: 'ask', surface: 'agent-page' },
      LOCAL
    );
    await world.service.setPreset({ preset: 'full', surface: 'control-center' }, LOCAL);
    const files = (await world.service.getAgent('agent-test')).filesAndCommands;
    expect(files.source).toBe('agent');
    expect(files.lastChange?.surface).toBe('agent-page');
    // What it would inherit is the global stop, which the preset just moved.
    expect(files.inherited.lastChange?.surface).toBe('control-center');
  });

  it('counts the agents that follow the Files & commands stop everyone has', async () => {
    const world = createPermissionWorld({
      agents: [
        { ...TWO_AGENTS[0]!, runtime: 'codex' },
        { ...TWO_AGENTS[1]!, permissions: { filesAndCommands: 'ask' } },
        { id: 'agent-c', name: 'c', projectPath: '/agents/c', runtime: 'claude-code' },
      ],
      runtimeStops: { codex: 'ask' },
    });

    const overview = await world.service.getOverview();

    // codex has its own stop and test-bot has its own: only agent-c follows.
    expect(overview.filesAndCommands.followingAgentIds).toEqual(['agent-c']);
  });
});
