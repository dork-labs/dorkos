/**
 * The client's session-level running set names the work it counts (spec
 * `warm-process-lifecycle` D8), in parity with the server projector.
 */
import { describe, it, expect } from 'vitest';
import type { SessionEvent, SessionStatus } from '@dorkos/shared/session-stream';
import {
  applyRunningSubagent,
  rebaseRunningSubagents,
  type RunningSubagentFold,
} from '../running-subagents';

type SubagentUpdate = Extract<SessionEvent, { type: 'subagent_update' }>;

function update(fields: Partial<SubagentUpdate> & { taskId: string }): SubagentUpdate {
  return { seq: 1, type: 'subagent_update', status: 'running', ...fields } as SubagentUpdate;
}

function fold(status: Partial<SessionStatus> = {}): RunningSubagentFold {
  return {
    status: { runningSubagentCount: 0, ...status } as SessionStatus,
    runningSubagentIds: [],
    ambientSubagentIds: [],
    unnamedRunningSubagents: 0,
  };
}

describe('applyRunningSubagent', () => {
  it('names a running shell, keeps the start facts through progress, and drops it at the end', () => {
    const session = fold();
    applyRunningSubagent(
      session,
      update({ taskId: 'sh', taskType: 'bash', command: 'pnpm test', startedAt: 5 })
    );
    applyRunningSubagent(session, update({ taskId: 'sh', toolUses: 2 }));

    expect(session.status?.runningSubagents).toEqual([
      { taskId: 'sh', taskType: 'bash', command: 'pnpm test', startedAt: 5 },
    ]);
    expect(session.status?.runningSubagentCount).toBe(1);

    applyRunningSubagent(session, update({ taskId: 'sh', status: 'complete' }));
    expect(session.status?.runningSubagents).toEqual([]);
    expect(session.status?.runningSubagentCount).toBe(0);
  });

  it('keeps the same list on a progress report that names nothing new', () => {
    const session = fold();
    applyRunningSubagent(session, update({ taskId: 'a', taskType: 'agent' }));
    const before = session.status?.runningSubagents;
    applyRunningSubagent(session, update({ taskId: 'a', toolUses: 4 }));
    expect(session.status?.runningSubagents).toBe(before);
  });

  it('keeps housekeeping off the list', () => {
    const session = fold();
    applyRunningSubagent(session, update({ taskId: 'chore', ambient: true, taskType: 'other' }));

    expect(session.status?.runningSubagents).toBeUndefined();
    expect(session.ambientSubagentIds).toEqual(['chore']);
  });
});

describe('rebaseRunningSubagents', () => {
  it('names earlier-turn work from the snapshot list and books only the rest as unnamed', () => {
    const session = fold();
    rebaseRunningSubagents(
      session,
      {
        runningSubagentCount: 3,
        runningSubagents: [
          { taskId: 'old', taskType: 'other', description: 'Watch the deploy' },
          { taskId: 'now', taskType: 'agent' },
        ],
      } as SessionStatus,
      [update({ taskId: 'now', description: 'Review the branch' })]
    );

    expect(session.runningSubagentIds).toEqual(['old', 'now']);
    expect(session.unnamedRunningSubagents).toBe(1);
    expect(session.status?.runningSubagentCount).toBe(3);
    expect(session.status?.runningSubagents).toEqual([
      { taskId: 'old', taskType: 'other', description: 'Watch the deploy' },
      { taskId: 'now', taskType: 'agent', description: 'Review the branch' },
    ]);
  });

  it('lets the turn retire a task the list still names', () => {
    const session = fold();
    rebaseRunningSubagents(
      session,
      { runningSubagentCount: 1, runningSubagents: [{ taskId: 'a' }] } as SessionStatus,
      [update({ taskId: 'a', status: 'complete' })]
    );
    expect(session.runningSubagentIds).toEqual([]);
    expect(session.status?.runningSubagents).toEqual([]);
  });

  it('leaves the list absent for a server that sends none and a turn that names nothing', () => {
    const session = fold();
    rebaseRunningSubagents(session, { runningSubagentCount: 2 } as SessionStatus, []);
    expect(session.status?.runningSubagents).toBeUndefined();
    expect(session.unnamedRunningSubagents).toBe(2);
  });
});
