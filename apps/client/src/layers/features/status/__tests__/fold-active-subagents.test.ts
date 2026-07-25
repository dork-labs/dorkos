import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { foldActiveSubagents } from '../lib/fold-active-subagents';

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
});
