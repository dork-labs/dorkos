import { describe, expect, it } from 'vitest';
import type { DispatchHoldHandshake } from '@dorkos/shared/agent-runtime';
import type { QueuedWaitingOn, StreamEvent } from '@dorkos/shared/types';
import { awaitDispatchDecision } from '../dispatch-decision.js';

const waitingOn: QueuedWaitingOn = {
  reason: 'background-work',
  holding: { agents: 1, shells: 0, other: 0 },
  pins: ['cwd'],
  since: 1,
  releaseAt: 2,
};
const done = { type: 'done', data: {} } as StreamEvent;

/** Drain a stream into an array. */
async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe('awaitDispatchDecision (DOR-2065)', () => {
  it('reports a hold the runtime made before yielding', async () => {
    let accepted: boolean | undefined;
    const decision = await awaitDispatchDecision(async function* (hold: DispatchHoldHandshake) {
      accepted = hold.hold(waitingOn);
    });
    expect(decision).toEqual({ held: waitingOn });
    expect(accepted).toBe(true);
  });

  it('refuses a hold that comes after it stopped waiting, so the runtime goes on', async () => {
    let accepted: boolean | undefined;
    const decision = await awaitDispatchDecision(async function* (hold: DispatchHoldHandshake) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      accepted = hold.hold(waitingOn);
      if (!accepted) yield done;
    }, 5);

    expect('stream' in decision).toBe(true);
    const events = await drain((decision as { stream: AsyncIterable<StreamEvent> }).stream);
    expect(accepted).toBe(false);
    expect(events).toEqual([done]);
  });

  it('replays the first event and continues the same stream after proceed', async () => {
    const decision = await awaitDispatchDecision(async function* (hold: DispatchHoldHandshake) {
      hold.proceed();
      yield { type: 'text_delta', data: { text: 'a' } } as StreamEvent;
      yield done;
    });
    const events = await drain((decision as { stream: AsyncIterable<StreamEvent> }).stream);
    expect(events.map((event) => event.type)).toEqual(['text_delta', 'done']);
  });
});
