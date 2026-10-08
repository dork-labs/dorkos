import { expect, it } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { StreamEventSchema } from '@dorkos/shared/schemas';
import { DoeTurnEvents } from '../turn.js';
import { model } from './runtime-fixture.js';
it('correlates child output to its actual builder and keeps child tools outside parent calls', () => {
  const events: StreamEvent[] = [];
  const mapper = new DoeTurnEvents('s', model, (event) => events.push(event));
  mapper.childStarted('child:one', 'builder-call');
  mapper.receive({ type: 'text', delta: 'Coding', scope: 'child:one' });
  mapper.receive({ type: 'tool-start', callId: 'child-write', name: 'write', scope: 'child:one' });
  mapper.receive({
    type: 'tool-end',
    callId: 'child-write',
    name: 'write',
    scope: 'child:one',
    result: { content: [] },
  });
  mapper.childEnded('child:one', {
    kind: 'result',
    result: { usage: [], messages: [], stopReason: 'stop' },
  });
  mapper.childEnded('child:one', { kind: 'error', error: new Error('late') });
  expect(events.map((event) => event.type)).toEqual([
    'background_task_started',
    'subagent_text_delta',
    'background_task_progress',
    'background_task_progress',
    'background_task_done',
  ]);
  expect(events[1]?.data).toEqual({ parentToolUseId: 'builder-call', text: 'Coding' });
  for (const event of events) expect(StreamEventSchema.safeParse(event).success).toBe(true);
});
it('never invents lifecycle correlation for an unknown child', () => {
  const events: StreamEvent[] = [];
  const mapper = new DoeTurnEvents('s', model, (event) => events.push(event));
  mapper.receive({ type: 'text', delta: 'Orphan', scope: 'child:unknown' });
  mapper.receive({ type: 'tool-start', callId: 'orphan', name: 'write', scope: 'child:unknown' });
  expect(events).toEqual([]);
});
it('RT-COST-01: separates turn cost from cumulative cost and retains unknown totals', () => {
  const events: StreamEvent[] = [];
  const mapper = new DoeTurnEvents(
    's',
    model,
    (event) => events.push(event),
    'auto',
    () => 0.5
  );
  mapper.receive({ type: 'usage', scope: 'main', usage: { requestId: 'one', costUsd: 0.1 } });
  mapper.finish('completed', false);
  expect(events.at(-1)?.data).toMatchObject({
    turnCostUsd: 0.1,
    costUsd: 0.5,
    usage: { kind: 'pay-as-you-go', costUsd: 0.5 },
  });
  const unknown = new DoeTurnEvents(
    's',
    model,
    (event) => events.push(event),
    'auto',
    () => undefined
  );
  unknown.receive({ type: 'usage', scope: 'main', usage: { requestId: 'two', costUsd: 0.1 } });
  unknown.finish('completed', false);
  expect(events.at(-1)?.data).toMatchObject({ turnCostUsd: 0.1 });
  expect(events.at(-1)?.data).not.toHaveProperty('costUsd');
});
