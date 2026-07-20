/**
 * Tests for {@link rebindShapeSchedulesForAgent} (the agent-create seam of the
 * Shape schedule re-bind, spec §"Contract changes" item 3).
 *
 * The Linear Ops flow made real: a Shape schedule created global/disabled
 * (agent missing) re-targets to the agent and enables the moment a matching
 * agent is created — without re-applying the Shape. All against injected fakes.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ShapePackageManifest } from '@dorkos/marketplace';
import { MarketplacePackageManifestSchema } from '@dorkos/marketplace';
import type { ExistingSchedule, ScheduleRebind } from '../apply-shape.js';
import { rebindShapeSchedulesForAgent, type RebindAgent } from '../rebind-schedules.js';

/** Parse a partial manifest through the union so all defaults + cross-field rules apply. */
function buildManifest(overrides: Record<string, unknown> = {}): ShapePackageManifest {
  return MarketplacePackageManifestSchema.parse({
    schemaVersion: 1,
    name: 'linear-ops',
    version: '1.0.0',
    type: 'shape',
    description: 'A test shape.',
    author: 'test',
    ...overrides,
  }) as ShapePackageManifest;
}

/** A Linear-Ops-shaped manifest: one default agent matched by name + its inbox tick. */
function linearOpsManifest(scheduleOverrides: Record<string, unknown> = {}): ShapePackageManifest {
  return buildManifest({
    agents: [
      {
        ref: 'linear-tender',
        affinity: 'default',
        matchName: 'Linear Tender',
        template: { displayName: 'Linear Tender' },
      },
    ],
    schedules: [
      {
        name: 'inbox-tick',
        description: 'poll the inbox',
        prompt: 'run one tick',
        cron: '*/15 * * * *',
        agentRef: 'linear-tender',
        permissionMode: 'acceptEdits',
        ...scheduleOverrides,
      },
    ],
  });
}

/** The just-created agent that satisfies the Linear Tender entry by display name. */
const LINEAR_TENDER_AGENT: RebindAgent = {
  id: 'agent-tender',
  name: 'linear-tender',
  displayName: 'Linear Tender',
};

/** A fake schedule service backed by an in-memory list, observable via spies. */
function makeScheduleService(initial: ExistingSchedule[]) {
  const schedules = initial.map((s) => ({ ...s }));
  const rebindSchedule = vi.fn(async (name: string, rebind: ScheduleRebind) => {
    const existing = schedules.find((s) => s.name === name);
    if (existing) {
      existing.agentId = rebind.agentId;
      existing.enabled = rebind.enabled;
    }
  });
  return {
    schedules,
    rebindSchedule,
    service: {
      listSchedules: () => schedules.map((s) => ({ ...s })),
      createSchedule: vi.fn(async () => undefined),
      rebindSchedule,
    },
  };
}

describe('rebindShapeSchedulesForAgent', () => {
  it('re-binds + enables a waiting global schedule when its matching agent is created', async () => {
    const { service, rebindSchedule, schedules } = makeScheduleService([
      { name: 'inbox-tick', agentId: null, enabled: false },
    ]);

    const rebound = await rebindShapeSchedulesForAgent(LINEAR_TENDER_AGENT, {
      listShapes: () => [linearOpsManifest()],
      scheduleService: service,
    });

    expect(rebound).toEqual(['inbox-tick']);
    expect(rebindSchedule).toHaveBeenCalledTimes(1);
    expect(rebindSchedule).toHaveBeenCalledWith('inbox-tick', {
      agentId: 'agent-tender',
      enabled: true,
    });
    // The tick is now agent-bound and enabled — no re-apply needed.
    expect(schedules).toEqual([{ name: 'inbox-tick', agentId: 'agent-tender', enabled: true }]);
  });

  it('matches on the agent slug too, not only the display name', async () => {
    const { service, rebindSchedule } = makeScheduleService([
      { name: 'inbox-tick', agentId: null, enabled: false },
    ]);

    // A Shape whose entry is matched by slug, and an agent with only a slug.
    const slugMatchShape = buildManifest({
      agents: [{ ref: 'tender', affinity: 'default', matchName: 'linear-tender' }],
      schedules: [
        {
          name: 'inbox-tick',
          description: 'poll',
          prompt: 'go',
          cron: '*/15 * * * *',
          agentRef: 'tender',
          permissionMode: 'acceptEdits',
        },
      ],
    });

    const rebound = await rebindShapeSchedulesForAgent(
      { id: 'agent-x', name: 'linear-tender' },
      { listShapes: () => [slugMatchShape], scheduleService: service }
    );

    expect(rebound).toEqual(['inbox-tick']);
    expect(rebindSchedule).toHaveBeenCalledWith('inbox-tick', {
      agentId: 'agent-x',
      enabled: true,
    });
  });

  it('does nothing when the new agent does not match any Shape entry', async () => {
    const { service, rebindSchedule, schedules } = makeScheduleService([
      { name: 'inbox-tick', agentId: null, enabled: false },
    ]);

    const rebound = await rebindShapeSchedulesForAgent(
      { id: 'agent-other', name: 'other', displayName: 'Something Else' },
      { listShapes: () => [linearOpsManifest()], scheduleService: service }
    );

    expect(rebound).toEqual([]);
    expect(rebindSchedule).not.toHaveBeenCalled();
    expect(schedules).toEqual([{ name: 'inbox-tick', agentId: null, enabled: false }]);
  });

  it('leaves an already agent-bound schedule alone (respects a user disable)', async () => {
    const { service, rebindSchedule, schedules } = makeScheduleService([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: false },
    ]);

    const rebound = await rebindShapeSchedulesForAgent(LINEAR_TENDER_AGENT, {
      listShapes: () => [linearOpsManifest()],
      scheduleService: service,
    });

    expect(rebound).toEqual([]);
    expect(rebindSchedule).not.toHaveBeenCalled();
    expect(schedules).toEqual([{ name: 'inbox-tick', agentId: 'agent-tender', enabled: false }]);
  });

  it('re-binds a startDisabled schedule but keeps it disabled', async () => {
    const { service, rebindSchedule } = makeScheduleService([
      { name: 'inbox-tick', agentId: null, enabled: false },
    ]);

    const rebound = await rebindShapeSchedulesForAgent(LINEAR_TENDER_AGENT, {
      listShapes: () => [linearOpsManifest({ startDisabled: true })],
      scheduleService: service,
    });

    expect(rebound).toEqual(['inbox-tick']);
    expect(rebindSchedule).toHaveBeenCalledWith('inbox-tick', {
      agentId: 'agent-tender',
      enabled: false,
    });
  });

  it('does nothing when no schedule with that name exists yet (never created)', async () => {
    const { service, rebindSchedule } = makeScheduleService([]);

    const rebound = await rebindShapeSchedulesForAgent(LINEAR_TENDER_AGENT, {
      listShapes: () => [linearOpsManifest()],
      scheduleService: service,
    });

    expect(rebound).toEqual([]);
    expect(rebindSchedule).not.toHaveBeenCalled();
  });

  it('does nothing when no Shapes are installed', async () => {
    const { service, rebindSchedule } = makeScheduleService([
      { name: 'inbox-tick', agentId: null, enabled: false },
    ]);

    const rebound = await rebindShapeSchedulesForAgent(LINEAR_TENDER_AGENT, {
      listShapes: () => [],
      scheduleService: service,
    });

    expect(rebound).toEqual([]);
    expect(rebindSchedule).not.toHaveBeenCalled();
  });
});
