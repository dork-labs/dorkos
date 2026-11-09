import { describe, it, expect } from 'vitest';
import { timeRuntimeEvents } from '../timing/runtime-timing.js';
import type { StreamEvent } from '@dorkos/shared/types';
const tool = (type: StreamEvent['type'], status = 'running', id = 'a'): StreamEvent =>
  ({ type, data: { toolCallId: id, toolName: 'Read', status } }) as StreamEvent;
describe('runtime timing', () => {
  it('keeps parallel tools separate and waits for a real terminal, not argument completion', () => {
    const owner = {};
    expect(timeRuntimeEvents(owner, [tool('tool_call_start')], { now: 10 })[0].data).toMatchObject({
      startedAt: 10,
    });
    timeRuntimeEvents(owner, [tool('tool_call_start', 'running', 'b')], { now: 20 });
    expect(
      timeRuntimeEvents(owner, [tool('tool_call_end')], { now: 30 })[0].data
    ).not.toHaveProperty('endedAt');
    expect(
      timeRuntimeEvents(owner, [tool('tool_result', 'complete', 'b')], { now: 40 })[0].data
    ).toMatchObject({ startedAt: 20, endedAt: 40 });
    expect(
      timeRuntimeEvents(owner, [tool('tool_result', 'error')], { now: 50 })[0].data
    ).toMatchObject({ startedAt: 10, endedAt: 50 });
  });
  it('leaves an unobserved start absent and never borrows from another turn', () => {
    const owner = {};
    timeRuntimeEvents(owner, [tool('tool_call_start')], { now: 10 });
    const result = timeRuntimeEvents(
      {},
      [tool('tool_call_start'), tool('tool_result', 'complete')],
      { observeStart: false, now: 30 }
    );
    expect(result[0].data).not.toHaveProperty('startedAt');
    expect(result[1].data).not.toHaveProperty('startedAt');
    expect(result[1].data).toHaveProperty('endedAt', 30);
  });
  it('uses compaction progress when present and never guesses its start', () => {
    const owner = {};
    timeRuntimeEvents(
      owner,
      [
        {
          type: 'operation_progress',
          data: { operation: 'compaction', state: 'started', determinate: false },
        },
      ],
      { now: 10 }
    );
    expect(
      timeRuntimeEvents(owner, [{ type: 'compact_boundary', data: {} }], { now: 40 })[0].data
    ).toEqual({ startedAt: 10, endedAt: 40 });
    expect(
      timeRuntimeEvents(owner, [{ type: 'compact_boundary', data: {} }], { now: 50 })[0].data
    ).toEqual({ endedAt: 50 });
  });
});
