import { describe, it, expect } from 'vitest';
import { PERMISSION_AREA_IDS } from '../permission-ids.js';
import { countAgentsFollowing, describeAffectedAgents } from '../affected-agents.js';
import type { PermissionException } from '../permission-api-schemas.js';

/** An overview with `agentCount` agents and these exceptions. */
function overview(
  agentCount: number,
  exceptions: PermissionException[],
  followingAgentIds: string[] = []
) {
  return {
    agentCount,
    exceptions,
    filesAndCommands: {
      stop: 'act' as const,
      presetStop: 'act' as const,
      runtimes: [],
      exceptions: [],
      followingAgentIds,
    },
  };
}

/** One agent's own setting. */
function own(agentId: string, area: PermissionException['area'], action?: string) {
  return {
    agentId,
    agentName: agentId,
    area,
    state: 'blocked' as const,
    ...(action ? { action } : {}),
  };
}

describe('countAgentsFollowing', () => {
  it('an area reaches every agent without its own setting for that area', () => {
    const view = overview(10, [own('a', 'rooms'), own('b', 'tasks')]);
    expect(countAgentsFollowing(view, { kind: 'area', area: 'rooms' })).toBe(9);
  });

  it('an agent with only a single action of its own in the area still follows the area', () => {
    const view = overview(10, [own('a', 'rooms', 'rooms.create')]);
    expect(countAgentsFollowing(view, { kind: 'area', area: 'rooms' })).toBe(10);
  });

  it('an action reaches neither an agent with that action nor one with its area of its own', () => {
    const view = overview(10, [
      own('a', 'rooms', 'rooms.create'),
      own('b', 'rooms'),
      own('c', 'rooms', 'rooms.merge'),
      // Both at once is still one agent.
      own('a', 'rooms'),
    ]);
    expect(
      countAgentsFollowing(view, { kind: 'action', action: 'rooms.create', area: 'rooms' })
    ).toBe(8);
  });

  it('the preset reaches every agent that has not set every area of its own', () => {
    const everything = PERMISSION_AREA_IDS.map((area) => own('a', area));
    const view = overview(3, [...everything, own('b', 'rooms')]);
    expect(countAgentsFollowing(view, { kind: 'preset' })).toBe(2);
  });

  it('the preset still reaches an agent with every area set when its stop follows the preset', () => {
    const everything = PERMISSION_AREA_IDS.map((area) => own('a', area));
    // The preset moves the global stop, and `a` follows it.
    expect(countAgentsFollowing(overview(3, everything, ['a']), { kind: 'preset' })).toBe(3);
    expect(countAgentsFollowing(overview(3, everything, []), { kind: 'preset' })).toBe(2);
  });

  it('Files & commands is the server’s count', () => {
    expect(countAgentsFollowing(overview(10, [], ['a', 'b', 'c', 'd']), { kind: 'files' })).toBe(4);
  });
});

describe('describeAffectedAgents', () => {
  it('says one agent and many agents', () => {
    expect(describeAffectedAgents(1)).toBe('affects 1 agent');
    expect(describeAffectedAgents(33)).toBe('affects 33 agents');
  });
});
