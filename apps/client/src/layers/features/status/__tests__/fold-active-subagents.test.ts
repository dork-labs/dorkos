import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { foldActiveSubagents, partitionSubagents } from '../lib/fold-active-subagents';
import type { ActiveSubagent } from '../model/session-diagnostics';

/** A `subagent_update` frame at `seq`. */
function update(
  seq: number,
  taskId: string,
  fields: Partial<Extract<SessionEvent, { type: 'subagent_update' }>> = {}
): SessionEvent {
  return { seq, type: 'subagent_update', taskId, status: 'running', ...fields } as SessionEvent;
}

describe('foldActiveSubagents', () => {
  it('reports nothing for a turn with no subagents', () => {
    expect(foldActiveSubagents([{ seq: 1, type: 'turn_start' } as SessionEvent])).toEqual([]);
  });

  it('merges updates field-wise, keeping fields a later frame omits', () => {
    // The runtime emits partials: the start carries the description, progress the
    // tool tally, the terminal frame the summary. A wholesale replace would lose
    // the description the moment the first progress frame arrived.
    const folded = foldActiveSubagents([
      update(1, 't1', { description: 'Search the codebase', status: 'running' }),
      update(2, 't1', { toolUses: 3, lastToolName: 'Grep' }),
      update(3, 't1', { status: 'complete', summary: 'Found 4 call sites' }),
    ]);

    expect(folded).toEqual([
      {
        taskId: 't1',
        status: 'complete',
        description: 'Search the codebase',
        toolUses: 3,
        lastToolName: 'Grep',
        summary: 'Found 4 call sites',
      },
    ]);
  });

  it('keeps one row per task, in the order each first appeared', () => {
    const folded = foldActiveSubagents([
      update(1, 't1', { description: 'first' }),
      update(2, 't2', { description: 'second' }),
      update(3, 't1', { toolUses: 1 }),
    ]);
    expect(folded.map((s) => s.taskId)).toEqual(['t1', 't2']);
  });

  it('ignores every other event type in the turn', () => {
    const folded = foldActiveSubagents([
      { seq: 1, type: 'text_delta', text: 'hi' } as SessionEvent,
      update(2, 't1'),
      { seq: 3, type: 'turn_end' } as SessionEvent,
    ]);
    expect(folded).toHaveLength(1);
  });

  it('keeps a finished subagent in the fold, carrying its terminal status', () => {
    // The contract every reader depends on: the fold is "what this turn handed
    // off", not "what is running". A reader that treated membership as liveness
    // reported finished subagents as running for the rest of the turn.
    const folded = foldActiveSubagents([
      update(1, 't1', { description: 'done thing' }),
      update(2, 't1', { status: 'complete' }),
      update(3, 't2', { description: 'live thing' }),
    ]);
    expect(folded.map((s) => [s.taskId, s.status])).toEqual([
      ['t1', 'complete'],
      ['t2', 'running'],
    ]);
  });
});

/** A folded row. */
function row(taskId: string, status: ActiveSubagent['status']): ActiveSubagent {
  return { taskId, status };
}

describe('partitionSubagents', () => {
  it('treats only `running` as still in flight', () => {
    // Written as a negative check on purpose: `complete`, `error` and `stopped`
    // are all finished, and so is any fifth status a runtime adds later.
    const { running, finished } = partitionSubagents([
      row('t1', 'running'),
      row('t2', 'complete'),
      row('t3', 'error'),
      row('t4', 'stopped'),
      row('t5', 'running'),
    ]);
    expect(running.map((s) => s.taskId)).toEqual(['t1', 't5']);
    expect(finished.map((s) => s.taskId)).toEqual(['t2', 't3', 't4']);
  });

  it('returns two empty lists for a turn that handed nothing off', () => {
    expect(partitionSubagents([])).toEqual({ running: [], finished: [] });
  });
});
