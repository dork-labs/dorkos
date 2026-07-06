/**
 * Unit tests for the turn stall watchdog ({@link withStallGuard}).
 *
 * Pins every clause of the guard's contract with a hand-controlled source and
 * fake timers: pass-through resets the inactivity clock, a paused expiry
 * re-arms without firing, a stall abandons the source (return() fired but
 * never awaited, the dangling next() rejection-silenced) and injects exactly
 * the three closing events, a source throw propagates with the timer cleared,
 * and a completed stream leaves no timer behind to fire late.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { withStallGuard } from '../stall-guard.js';
import type { StallGuardOpts } from '../stall-guard.js';

const TEN_MINUTES = 10 * 60 * 1000;
const SESSION_ID = 'stall-guard-session';

/** A text_delta fixture, cast like every StreamEvent literal in server tests. */
function delta(text: string): StreamEvent {
  return { type: 'text_delta', data: { text } } as StreamEvent;
}

/** The three events the guard injects on a stall, parameterized on the outcome. */
function stallCloseEvents(interrupted: boolean): StreamEvent[] {
  return [
    {
      type: 'error',
      data: {
        message: 'No activity from the agent for 10 minutes, so the turn was interrupted.',
        code: 'turn_stalled',
        category: 'execution_error',
        details: interrupted
          ? 'The in-flight turn was aborted.'
          : 'No in-flight turn was found to abort; the runtime may have leaked a process.',
      },
    },
    { type: 'session_status', data: { sessionId: SESSION_ID, terminalReason: 'error' } },
    { type: 'done', data: { sessionId: SESSION_ID } },
  ] as StreamEvent[];
}

/** A source whose next() promises the test settles by hand. */
function createControlledSource() {
  const pending: Array<{
    resolve: (r: IteratorResult<StreamEvent>) => void;
    reject: (e: unknown) => void;
  }> = [];
  const returnSpy = vi.fn<() => Promise<IteratorResult<StreamEvent>>>(async () => ({
    done: true,
    value: undefined,
  }));
  const iterator: AsyncIterator<StreamEvent> = {
    next: () =>
      new Promise<IteratorResult<StreamEvent>>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    return: returnSpy,
  };
  return {
    source: { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<StreamEvent>,
    emit: (event: StreamEvent) => pending.shift()?.resolve({ done: false, value: event }),
    end: () => pending.shift()?.resolve({ done: true, value: undefined }),
    fail: (err: unknown) => pending.shift()?.reject(err),
    returnSpy,
  };
}

/** Consume the guard in the background, recording events, end, and any throw. */
function collect(gen: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = [];
  let ended = false;
  let error: unknown;
  void (async () => {
    try {
      for await (const event of gen) events.push(event);
    } catch (err) {
      error = err;
    } finally {
      ended = true;
    }
  })();
  return { events, isEnded: () => ended, getError: () => error };
}

/**
 * Drain the microtask chain (race settlement, yields, consumer re-arm) without
 * advancing fake time. Each yield-to-consumer hop is a couple of microtasks;
 * 20 turns covers the full three-event close with headroom.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Build guard opts with overridable pieces; onStall defaults to interrupted=true. */
function makeOpts(overrides: Partial<StallGuardOpts> = {}): StallGuardOpts {
  return {
    sessionId: SESSION_ID,
    timeoutMs: TEN_MINUTES,
    isPaused: () => false,
    onStall: vi.fn(async () => true),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withStallGuard', () => {
  it('forwards events and resets the inactivity clock on each one', async () => {
    const src = createControlledSource();
    const onStall = vi.fn(async () => true);
    const collector = collect(withStallGuard(src.source, makeOpts({ onStall })));
    await flush();

    // t=9min of silence: under threshold, nothing fires.
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    src.emit(delta('a'));
    await flush();
    expect(collector.events).toEqual([delta('a')]);

    // Another 9min of silence: 18min since start but only 9 since the event.
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await flush();
    expect(onStall).not.toHaveBeenCalled();
    expect(collector.isEnded()).toBe(false);

    // The 10th idle minute completes the window: NOW it stalls.
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(collector.isEnded()).toBe(true);
  });

  it('fires the stall: onStall awaited once, return() fired, then exactly the three closing events', async () => {
    const src = createControlledSource();
    let resolveStall!: (v: boolean) => void;
    const onStall = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveStall = resolve;
        })
    );
    const collector = collect(withStallGuard(src.source, makeOpts({ onStall })));
    await flush();

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(src.returnSpy).toHaveBeenCalledTimes(1);
    // The close is GATED on the interrupt outcome (the details string differs),
    // so nothing is yielded until onStall settles, proof it is awaited.
    expect(collector.events).toEqual([]);

    resolveStall(true);
    await flush();
    expect(collector.events).toEqual(stallCloseEvents(true));
    expect(collector.isEnded()).toBe(true);
  });

  it('closes with the leaked-process details when onStall resolves false', async () => {
    const src = createControlledSource();
    const collector = collect(
      withStallGuard(src.source, makeOpts({ onStall: vi.fn(async () => false) }))
    );
    await flush();

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(collector.events).toEqual(stallCloseEvents(false));
    expect(collector.isEnded()).toBe(true);
  });

  it('routes an onStall rejection to onError and closes as not-interrupted', async () => {
    const src = createControlledSource();
    const failure = new Error('interrupt transport died');
    const onError = vi.fn();
    const collector = collect(
      withStallGuard(
        src.source,
        makeOpts({
          onStall: vi.fn(async () => {
            throw failure;
          }),
          onError,
        })
      )
    );
    await flush();

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(onError).toHaveBeenCalledWith(failure);
    // interrupted stayed false, so the close carries the leaked-process details.
    expect(collector.events).toEqual(stallCloseEvents(false));
    expect(collector.isEnded()).toBe(true);
  });

  it('re-arms while paused and fires only a full threshold after unpause', async () => {
    const src = createControlledSource();
    let paused = true;
    const onStall = vi.fn(async () => true);
    const collector = collect(
      withStallGuard(src.source, makeOpts({ isPaused: () => paused, onStall }))
    );
    await flush();

    // Two consecutive expiries while blocked: never fires, keeps re-arming.
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(onStall).not.toHaveBeenCalled();

    // Unpause: the fresh timer from the last re-arm still needs its FULL window.
    paused = false;
    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1);
    await flush();
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(collector.events).toEqual(stallCloseEvents(true));
    expect(collector.isEnded()).toBe(true);
  });

  it('clears the timer on normal completion (no late fire)', async () => {
    const src = createControlledSource();
    const onStall = vi.fn(async () => true);
    const collector = collect(withStallGuard(src.source, makeOpts({ onStall })));
    await flush();

    src.emit(delta('a'));
    await flush();
    src.end();
    await flush();
    expect(collector.isEnded()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // Long past the threshold: the cleared timer must never resurrect.
    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 3);
    await flush();
    expect(onStall).not.toHaveBeenCalled();
    expect(collector.events).toEqual([delta('a')]);
  });

  it('rethrows a source throw and clears the timer (guardTurnErrors owns translation)', async () => {
    const src = createControlledSource();
    const onStall = vi.fn(async () => true);
    const collector = collect(withStallGuard(src.source, makeOpts({ onStall })));
    await flush();

    src.fail(new Error('boom'));
    await flush();
    expect(collector.getError()).toBeInstanceOf(Error);
    expect((collector.getError() as Error).message).toBe('boom');
    expect(collector.isEnded()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 2);
    await flush();
    expect(onStall).not.toHaveBeenCalled();
    expect(collector.events).toEqual([]);
  });

  it('never awaits iterator.return, so a stuck source cannot block the close', async () => {
    const src = createControlledSource();
    // A truly hung source: return() queues behind the pending next() and never
    // settles. The close must not depend on it.
    src.returnSpy.mockImplementation(() => new Promise<never>(() => {}));
    const collector = collect(withStallGuard(src.source, makeOpts()));
    await flush();

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(src.returnSpy).toHaveBeenCalledTimes(1);
    expect(collector.events).toEqual(stallCloseEvents(true));
    expect(collector.isEnded()).toBe(true);
  });

  it('silences the abandoned next() so a late rejection is never unhandled', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const src = createControlledSource();
      const collector = collect(withStallGuard(src.source, makeOpts()));
      await flush();

      await vi.advanceTimersByTimeAsync(TEN_MINUTES);
      await flush();
      expect(collector.isEnded()).toBe(true);

      // The abandoned next() rejects AFTER the stall detached from the source.
      src.fail(new Error('late rejection from a dying subprocess'));
      await flush();
      // Real macrotask turns so Node's unhandled-rejection detection runs.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
