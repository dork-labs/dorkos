/**
 * The session-level running list (spec `warm-process-lifecycle` D8, FB-18):
 * the status names background work, not only counts it, and the name survives
 * the turn that started it.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  SessionStateProjector,
  SUBAGENT_SILENCE_TIMEOUT_MS,
  type RawSessionEvent,
} from '../../session-state-projector.js';
import { RunningTaskDetails, setLiveTaskProbe, startedTaskFacts } from '../running-tasks.js';

function update(fields: Record<string, unknown>): RawSessionEvent {
  return { type: 'subagent_update', status: 'running', ...fields } as RawSessionEvent;
}

describe('the status running list', () => {
  it('names a background shell and a Monitor through turn_end, until each ends', () => {
    const p = new SessionStateProjector('rl-1');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest(
      update({
        taskId: 'sh',
        taskType: 'bash',
        command: 'pnpm test',
        description: 'Run the tests',
        startedAt: 1000,
      })
    );
    p.ingest(update({ taskId: 'mon', taskType: 'other', description: 'Watch the deploy' }));
    p.ingest({ type: 'turn_end' } as RawSessionEvent);

    expect(p.getStatus().lifecycle).toBe('idle');
    expect(p.getStatus().runningSubagents).toEqual([
      {
        taskId: 'sh',
        taskType: 'bash',
        command: 'pnpm test',
        description: 'Run the tests',
        startedAt: 1000,
      },
      { taskId: 'mon', taskType: 'other', description: 'Watch the deploy' },
    ]);
    expect(p.getStatus().runningSubagentCount).toBe(2);

    p.ingest(update({ taskId: 'sh', status: 'complete' }));
    expect(p.getStatus().runningSubagents).toEqual([
      { taskId: 'mon', taskType: 'other', description: 'Watch the deploy' },
    ]);
    expect(p.getStatus().runningSubagentCount).toBe(1);
  });

  it('keeps what a start said when a progress report names none of it', () => {
    const p = new SessionStateProjector('rl-2');
    p.ingest(update({ taskId: 'a', taskType: 'agent', description: 'Review the branch' }));
    p.ingest(update({ taskId: 'a', toolUses: 4 }));

    expect(p.getStatus().runningSubagents).toEqual([
      { taskId: 'a', taskType: 'agent', description: 'Review the branch' },
    ]);
  });

  it('leaves housekeeping out of the list, as it does the count', () => {
    const p = new SessionStateProjector('rl-3');
    p.ingest(update({ taskId: 'chore', ambient: true, taskType: 'other' }));
    p.ingest(update({ taskId: 'real', taskType: 'bash' }));

    expect(p.getStatus().runningSubagents?.map((t) => t.taskId)).toEqual(['real']);
    expect(p.getStatus().runningSubagentCount).toBe(1);
  });

  it('says nothing until any background work is reported', () => {
    expect(new SessionStateProjector('rl-4').getStatus().runningSubagents).toBeUndefined();
  });

  it('empties when DorkOS tears the turn down', () => {
    const p = new SessionStateProjector('rl-5');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest(update({ taskId: 'sh', taskType: 'bash' }));
    p.markInterrupted();

    expect(p.getStatus().runningSubagents).toEqual([]);
    expect(p.getStatus().runningSubagentCount).toBe(0);
  });
});

describe('startedTaskFacts', () => {
  it('reads the kind, command and start, and leaves out what is absent or malformed', () => {
    expect(startedTaskFacts({ taskType: 'other', command: 'tail -f', startedAt: 5 })).toEqual({
      taskType: 'other',
      command: 'tail -f',
      startedAt: 5,
    });
    expect(startedTaskFacts({ taskType: 'robot', command: '', startedAt: 'x' })).toEqual({});
  });
});

describe('RunningTaskDetails', () => {
  it('names an id it never saw start by its id alone', () => {
    const details = new RunningTaskDetails();
    expect(details.list(['ghost'], new Set())).toEqual([{ taskId: 'ghost' }]);
  });

  it('forgets an ended task', () => {
    const details = new RunningTaskDetails();
    details.note({ taskId: 'a', taskType: 'bash' });
    details.forget('a');
    expect(details.list(['a'], new Set())).toEqual([{ taskId: 'a' }]);
  });
});

// DOR-2065: a Monitor or a `tail -f` shell may send no progress at all. The
// silence clock must not retire one its runtime still reports running.
describe('the silence sweep', () => {
  afterEach(() => {
    setLiveTaskProbe(() => []);
    vi.useRealTimers();
  });

  it('keeps a quiet task the runtime still runs, and retires one it does not', () => {
    vi.useFakeTimers();
    const live = new Set(['mon']);
    setLiveTaskProbe((sessionId) => (sessionId === 'quiet-1' ? [...live] : []));
    const p = new SessionStateProjector('quiet-1');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest(update({ taskId: 'mon', taskType: 'other', description: 'Watch the deploy' }));
    p.ingest(update({ taskId: 'lost', taskType: 'bash' }));
    p.ingest({ type: 'turn_end' } as RawSessionEvent);

    vi.advanceTimersByTime(SUBAGENT_SILENCE_TIMEOUT_MS + 1);
    expect(p.getStatus().runningSubagents?.map((t) => t.taskId)).toEqual(['mon']);

    // Once the runtime stops naming it, the next sweep retires it.
    live.clear();
    vi.advanceTimersByTime(SUBAGENT_SILENCE_TIMEOUT_MS + 1);
    expect(p.getStatus().runningSubagents).toEqual([]);
    expect(p.getStatus().runningSubagentCount).toBe(0);
  });
});
