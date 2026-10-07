/**
 * The Files & commands row (spec `agent-permissions` D5, D16): a preset writes
 * its trust stop through the autonomy consent door, "N changes" counts the stops
 * that differ from the preset's, and an agent can have a stop of its own.
 * Runs the real service over the in-memory fixture world.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionChangedMetadata, PermissionPreset } from '@dorkos/shared/permissions';

import { personWriter } from '../permission-history.js';
import { TWO_AGENTS, createPermissionWorld } from './permission-fixtures.js';

const LOCAL = personWriter('local-trust');

describe('choosing a preset sets the Files & commands stop', () => {
  it.each([
    ['careful', 'ask'],
    ['balanced', 'act'],
    ['full', 'autonomy'],
  ] as const)('%s sets the global stop to %s', async (preset, stop) => {
    const world = createPermissionWorld({ trustStop: null });
    await world.service.setPreset(
      { preset: preset as PermissionPreset, surface: 'settings' },
      LOCAL
    );
    expect(world.stops.global).toBe(stop);
    const meta = world.events[0]!.metadata as unknown as PermissionChangedMetadata;
    expect(meta.changes).toContainEqual({
      target: { kind: 'default' },
      key: { kind: 'files' },
      before: null,
      after: stop,
    });
  });

  // The Full-autonomy acknowledgement is retired (ADR 261006-225605, DOR-2739):
  // choosing Full power is a choice like any other, recorded in the history.
  it('writes Full power straight away, with nothing to acknowledge first', async () => {
    const world = createPermissionWorld({ preset: 'careful', trustStop: 'ask' });
    await world.service.setPreset({ preset: 'full', surface: 'settings' }, LOCAL);
    expect(world.config.preset).toBe('full');
    expect(world.stops.global).toBe('autonomy');
    expect(world.events).toHaveLength(1);
  });

  it('leaves per-runtime stops alone, and snapshots the stop it replaced', async () => {
    const world = createPermissionWorld({
      trustStop: 'act',
      runtimeStops: { codex: 'autonomy' },
    });
    await world.service.setPreset({ preset: 'careful', surface: 'settings' }, LOCAL);
    expect(world.stops.perRuntime.codex).toBe('autonomy');
    const meta = world.events[0]!.metadata as unknown as PermissionChangedMetadata;
    expect(meta.presetSnapshot?.trustStop).toBe('act');
  });
});

describe('"N changes" counts the stops that differ from the preset', () => {
  it('counts default changes, a different global stop, and each differing runtime stop', async () => {
    const world = createPermissionWorld({
      preset: 'full',
      defaults: { areas: { rooms: 'ask' }, actions: { 'rooms.merge': 'blocked' } },
      trustStop: 'act',
      runtimeStops: { codex: 'ask', opencode: 'autonomy' },
    });
    const overview = await world.service.getOverview();
    // 2 defaults + the global stop (act, not autonomy) + codex (ask); opencode
    // matches Full power's stop, so it is not a change.
    expect(overview.changeCount).toBe(4);
    expect(overview.filesAndCommands).toMatchObject({
      stop: 'act',
      presetStop: 'autonomy',
      runtimes: [
        { runtime: 'codex', stop: 'ask' },
        { runtime: 'opencode', stop: 'autonomy' },
      ],
    });
  });

  it('counts an unset global stop under a chosen preset as a change', async () => {
    // A preset recorded by an upgrade, or a stop cleared later: new sessions do
    // not start where the preset says, so the picker must not read "no changes".
    const world = createPermissionWorld({ preset: 'careful', trustStop: null });
    const overview = await world.service.getOverview();
    expect(overview.changeCount).toBe(1);
  });

  it('counts nothing when every stop matches the preset', async () => {
    const world = createPermissionWorld({ preset: 'balanced', trustStop: 'act' });
    expect((await world.service.getOverview()).changeCount).toBe(0);
  });

  it('counts no stop as a change on an undecided install, which has no preset stop', async () => {
    const world = createPermissionWorld({ preset: null, trustStop: 'autonomy' });
    const overview = await world.service.getOverview();
    expect(overview.changeCount).toBe(0);
    expect(overview.filesAndCommands.presetStop).toBeNull();
  });
});

describe("an agent's own Files & commands stop", () => {
  it('stores it, records one event, and reports it resolved with its source', async () => {
    const world = createPermissionWorld({ preset: 'balanced', agents: TWO_AGENTS });
    await world.service.setAgent(
      'agent-test',
      { filesAndCommands: 'ask', surface: 'agent-page' },
      LOCAL
    );
    expect(world.agents.get('agent-test')?.permissions).toEqual({ filesAndCommands: 'ask' });
    const meta = world.events[0]!.metadata as unknown as PermissionChangedMetadata;
    expect(meta.changes).toEqual([
      expect.objectContaining({ key: { kind: 'files' }, before: null, after: 'ask' }),
    ]);
    const view = await world.service.getAgent('agent-test');
    // The stop names the change that set it; what it would inherit has none.
    expect(view.filesAndCommands).toEqual({
      stop: 'ask',
      source: 'agent',
      inherited: { stop: 'act', source: 'default' },
      lastChange: expect.objectContaining({ surface: 'agent-page', eventId: world.events[0]!.id }),
    });
  });

  it('gives an agent Full autonomy straight away, with nothing to acknowledge first', async () => {
    const world = createPermissionWorld({ agents: TWO_AGENTS });
    await world.service.setAgent(
      'agent-test',
      { filesAndCommands: 'autonomy', surface: 'agent-page' },
      LOCAL
    );
    expect(world.agents.get('agent-test')?.permissions?.filesAndCommands).toBe('autonomy');
  });

  it("goes back to the default on null, keeping the agent's other settings", async () => {
    const world = createPermissionWorld({ agents: TWO_AGENTS });
    await world.service.setAgent(
      'agent-auditor',
      { filesAndCommands: 'ask', surface: 'agent-page' },
      LOCAL
    );
    await world.service.setAgent(
      'agent-auditor',
      { filesAndCommands: null, surface: 'agent-page' },
      LOCAL
    );
    expect(world.agents.get('agent-auditor')?.permissions).toEqual({
      areas: { rooms: 'blocked' },
    });
  });

  it('is listed as an exception on the default layer', async () => {
    const world = createPermissionWorld({ agents: TWO_AGENTS });
    await world.service.setAgent(
      'agent-test',
      { filesAndCommands: 'ask', surface: 'agent-page' },
      LOCAL
    );
    const overview = await world.service.getOverview();
    expect(overview.filesAndCommands.exceptions).toEqual([
      {
        agentId: 'agent-test',
        agentName: 'Test Bot',
        stop: 'ask',
        lastChange: expect.objectContaining({ surface: 'agent-page' }),
      },
    ]);
  });
});
