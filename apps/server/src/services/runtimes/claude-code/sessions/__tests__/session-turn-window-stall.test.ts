/**
 * The stall watchdog over real turn windows (task 3.7).
 *
 * `stall-guard-windows.test.ts` pins the guard against a hand-driven signal;
 * this pins the wiring the pump will use — a real {@link SessionTurnWindows}
 * driving a {@link TurnWindowSignal} through its `onWindowOpen`/`onWindowClose`
 * seams, with `withStallGuard` following that signal. What it proves is the one
 * behavior the task exists for: a WARM process between turns is never
 * watchdogged, while a turn that has gone dark still trips at the same bound
 * and closes with the same typed-error terminal sequence as today.
 *
 * @module services/runtimes/claude-code/sessions/__tests__/session-turn-window-stall
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { withStallGuard } from '../../../../session/stall-guard.js';
import { TurnWindowSignal } from '../../../../session/turn-window-signal.js';
import { SessionTurnWindows, type WindowedPump } from '../session-turn-windows.js';

const SESSION_ID = 'warm-session';
const TEN_MINUTES = 10 * 60 * 1000;

/** The three events the guard injects when the interrupt aborts the turn. */
const STALL_CLOSE: StreamEvent[] = [
  {
    type: 'error',
    data: {
      message: 'No activity from the agent for 10 minutes, so the turn was interrupted.',
      code: 'turn_stalled',
      category: 'execution_error',
      details: 'The in-flight turn was aborted.',
    },
  },
  { type: 'session_status', data: { sessionId: SESSION_ID, terminalReason: 'error' } },
  { type: 'done', data: { sessionId: SESSION_ID } },
] as StreamEvent[];

/** A `result` that answers `answers`, or one that answers nothing it can name. */
function resultMessage(answers?: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    uuid: `result-${answers ?? 'anonymous'}`,
    session_id: 'sdk-1',
    ...(answers !== undefined ? { user_message_uuid: answers } : {}),
  } as unknown as SDKMessage;
}

/** The pump slice the windower drives; no process, because none is needed here. */
function fakePump(): WindowedPump & { turnsEnded: number } {
  return {
    turnsEnded: 0,
    dispatch: vi.fn(async () => {}),
    endTurn(): void {
      this.turnsEnded += 1;
    },
    controlQuery: undefined,
  };
}

/** A StreamEvent source the test settles by hand — the pump's mapped output. */
function createControlledSource() {
  const pending: Array<(r: IteratorResult<StreamEvent>) => void> = [];
  const iterator: AsyncIterator<StreamEvent> = {
    next: () => new Promise<IteratorResult<StreamEvent>>((resolve) => pending.push(resolve)),
    return: async () => ({ done: true, value: undefined }),
  };
  return {
    source: { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<StreamEvent>,
    emit: (event: StreamEvent) => pending.shift()?.({ done: false, value: event }),
  };
}

/** Consume the guard in the background, recording events and completion. */
function collect(gen: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = [];
  let ended = false;
  void (async () => {
    try {
      for await (const event of gen) events.push(event);
    } finally {
      ended = true;
    }
  })();
  return { events, isEnded: () => ended };
}

/** Drain the microtask chain without advancing fake time. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** A windower wired to a signal, and a guard following it. */
function harness() {
  const pump = fakePump();
  const signal = new TurnWindowSignal();
  const windows = new SessionTurnWindows({
    sessionId: SESSION_ID,
    pump,
    onWindowOpen: signal.opened,
    onWindowClose: signal.closed,
  });
  const src = createControlledSource();
  const onStall = vi.fn(async () => true);
  const collector = collect(
    withStallGuard(src.source, {
      sessionId: SESSION_ID,
      timeoutMs: TEN_MINUTES,
      isPaused: () => false,
      onStall,
      windows: signal,
    })
  );
  return { pump, signal, windows, src, onStall, collector };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the stall watchdog over turn windows', () => {
  it('leaves a WARM session alone however long it sits between turns', async () => {
    const h = harness();
    await flush();

    // No dispatch, so no window: the process is warm and legitimately quiet.
    // Three full stall windows pass and nothing happens — the process idle
    // timer (5 min) is what bounds this silence, not the watchdog.
    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 3);
    await flush();
    expect(h.onStall).not.toHaveBeenCalled();
    expect(h.collector.events).toEqual([]);
    expect(h.collector.isEnded()).toBe(false);
  });

  it('interrupts a dispatched window that goes dark, at the same bound as today', async () => {
    const h = harness();
    await h.windows.dispatch([{ content: 'do the thing', messageId: 'm1' }]);
    await flush();

    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1);
    await flush();
    expect(h.onStall).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.onStall).toHaveBeenCalledTimes(1);
    expect(h.collector.events).toEqual(STALL_CLOSE);
    expect(h.collector.isEnded()).toBe(true);
  });

  it('disarms when the window closes, and stays disarmed while the process idles', async () => {
    const h = harness();
    await h.windows.dispatch([{ content: 'do the thing', messageId: 'm1' }]);
    await flush();

    // The correlated result closes the window: RUNNING → WARM.
    h.windows.onMessage(resultMessage('m1'));
    await flush();
    expect(h.pump.turnsEnded).toBe(1);
    expect(h.signal.isOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 3);
    await flush();
    expect(h.onStall).not.toHaveBeenCalled();
    expect(h.collector.isEnded()).toBe(false);
  });

  it('re-arms for the next turn on the same warm process', async () => {
    const h = harness();
    await h.windows.dispatch([{ content: 'first', messageId: 'm1' }]);
    await flush();
    h.windows.onMessage(resultMessage('m1'));
    await flush();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 2);

    await h.windows.dispatch([{ content: 'second', messageId: 'm2' }]);
    await flush();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1);
    await flush();
    expect(h.onStall).not.toHaveBeenCalled();

    // A full fresh bound, measured from THIS window's open — not shortened by
    // the two idle windows that went by while the process was warm.
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.onStall).toHaveBeenCalledTimes(1);
    expect(h.collector.events).toEqual(STALL_CLOSE);
  });

  it('keeps guarding the open turn when a runtime window opens and closes beside it', async () => {
    const h = harness();
    await h.windows.dispatch([{ content: 'do the thing', messageId: 'm1' }]);
    await flush();

    // A `result` for a message this session never sent: the windower gives it a
    // synthetic `runtime` window of its own and closes it, leaving the
    // dispatched window untouched. That close must not disarm the watchdog on a
    // turn somebody is still waiting for.
    await vi.advanceTimersByTimeAsync(60_000);
    h.windows.onMessage(resultMessage('never-dispatched'));
    await flush();
    expect(h.signal.isOpen).toBe(true);
    expect(h.pump.turnsEnded).toBe(0);

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(h.onStall).toHaveBeenCalledTimes(1);
    expect(h.collector.events).toEqual(STALL_CLOSE);
  });

  it('leaves nothing armed when a refused dispatch opens no window at all', async () => {
    const h = harness();
    vi.mocked(h.pump.dispatch).mockRejectedValueOnce(new Error('the process is gone'));

    await expect(
      h.windows.dispatch([{ content: 'do the thing', messageId: 'm1' }])
    ).rejects.toThrow('the process is gone');
    await flush();
    // A turn that never began is not a turn to watchdog.
    expect(h.signal.isOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 2);
    await flush();
    expect(h.onStall).not.toHaveBeenCalled();
  });
});
