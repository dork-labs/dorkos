/**
 * Turns the agent starts on its own, projected onto the session's durable
 * stream (spec `warm-process-lifecycle` D6, T9/T12).
 *
 * What these pin is the whole hop: a runtime announces a turn nobody
 * dispatched, `subscribeRuntimeTurns` claims the session under the reserved
 * `runtime:` holder, the turn is projected with `origin: 'runtime'`, and the
 * session is handed back at `turn_end` so the queue can move again. The
 * assertions read the durable stream, because that is the thing the spec makes
 * promises about.
 *
 * @module services/session/runtime-turns/__tests__/runtime-turn
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { SESSIONS } from '../../../../config/constants.js';
import { resetMessageDispatcher } from '../../message-dispatcher.js';
import { getOrCreateProjector } from '../../session-state-projector.js';
import { subscribeRuntimeTurns } from '../runtime-turn.js';

/** A stream of events a test pushes by hand, with an explicit end. */
function pushable(): {
  push: (event: StreamEvent) => void;
  end: () => void;
  stream: AsyncIterable<StreamEvent>;
} {
  const queue: StreamEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* drain(): AsyncGenerator<StreamEvent> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return {
    push: (event) => {
      queue.push(event);
      wake?.();
      wake = undefined;
    },
    end: () => {
      ended = true;
      wake?.();
      wake = undefined;
    },
    stream: drain(),
  };
}

/** Let the detached projection make progress without advancing fake time. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

let sessionCounter = 0;
/** A fresh session id per case: projectors are process-wide and never reset. */
function nextSessionId(): string {
  sessionCounter += 1;
  return `runtime-turn-session-${sessionCounter}`;
}

beforeEach(() => {
  resetMessageDispatcher();
});

afterEach(() => {
  vi.useRealTimers();
  resetMessageDispatcher();
});

describe('a turn the agent started reaches the durable stream (T9)', () => {
  it('projects it as its own runtime-origin turn and hands the session back', async () => {
    const sessionId = nextSessionId();
    const runtime = new FakeAgentRuntime();
    const projector = getOrCreateProjector(sessionId);
    const unsubscribe = subscribeRuntimeTurns(runtime);
    expect(unsubscribe).toBeDefined();

    const turn = pushable();
    runtime.emitRuntimeTurn(sessionId, turn.stream);
    await flush();

    // Taken under the RESERVED holder, which `acquireLock` refuses to everyone
    // else — so a reader of the lock can believe what it says.
    expect(runtime.acquireRuntimeLock).toHaveBeenCalledWith(
      sessionId,
      expect.anything(),
      expect.anything()
    );

    turn.push({ type: 'text_delta', data: { text: 'the helper finished' } } as StreamEvent);
    turn.push({ type: 'done', data: { sessionId } } as StreamEvent);
    turn.end();
    await flush();

    const events = projector.replayFrom(0);
    const start = events.find((event) => event.type === 'turn_start');
    expect(start).toBeDefined();
    // The honesty of the whole feature: the turn is the AGENT's, and the stream
    // says so rather than dressing it as a reply to a message nobody sent.
    expect((start as { origin?: string }).origin).toBe('runtime');
    // Nobody typed anything, so nothing may claim they did.
    expect((start as { userMessage?: string }).userMessage).toBeUndefined();
    expect(events.some((event) => event.type === 'turn_end')).toBe(true);

    // And the session is given back, or every queued message waits for the life
    // of the process.
    expect(runtime.releaseLock).toHaveBeenCalledWith(
      sessionId,
      `runtime:${sessionId}`,
      expect.anything()
    );
    unsubscribe?.();
  });
});

describe('a runtime turn that goes dark is interrupted like any other (T12)', () => {
  it('interrupts at the ordinary stall bound', async () => {
    vi.useFakeTimers();
    const sessionId = nextSessionId();
    const runtime = new FakeAgentRuntime();
    getOrCreateProjector(sessionId);
    const unsubscribe = subscribeRuntimeTurns(runtime);

    const turn = pushable();
    runtime.emitRuntimeTurn(sessionId, turn.stream);
    await flush();

    // It says one thing, then nothing at all. A turn nobody asked for is still a
    // turn, and an agent holding the session in silence is exactly what the
    // watchdog is for (spec D6 rule 5 — no exemption).
    turn.push({ type: 'text_delta', data: { text: 'starting' } } as StreamEvent);
    await flush();
    expect(runtime.interruptQuery).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SESSIONS.TURN_STALL_TIMEOUT_MS + 1_000);
    await flush();
    expect(runtime.interruptQuery).toHaveBeenCalledWith(sessionId);
    unsubscribe?.();
  });
});

describe('a runtime that cannot start its own turns subscribes to nothing', () => {
  it('answers undefined rather than pretending', () => {
    const runtime = new FakeAgentRuntime();
    // Two observers are wired here, not one: turns the agent starts, and the
    // release of a hold its pending-segment gate puts on the queue. A backend
    // whose output only ever answers a dispatch offers neither.
    (runtime as { onRuntimeTurn?: unknown }).onRuntimeTurn = undefined;
    (runtime as { onDispatchGateChange?: unknown }).onDispatchGateChange = undefined;
    expect(subscribeRuntimeTurns(runtime)).toBeUndefined();
  });

  it('still subscribes for a runtime that only holds the queue', () => {
    const runtime = new FakeAgentRuntime();
    (runtime as { onRuntimeTurn?: unknown }).onRuntimeTurn = undefined;
    // A runtime that can hold a person's message MUST be able to say the hold
    // dropped, whether or not it ever produces a turn of its own — otherwise
    // that message waits for an event nothing will send.
    expect(subscribeRuntimeTurns(runtime)).toBeDefined();
  });
});
