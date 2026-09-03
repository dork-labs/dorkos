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
import type { InterruptReceipt, StreamEvent } from '@dorkos/shared/types';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import { withStallGuard } from '../stall-guard.js';
import type { StallGuardOpts } from '../stall-guard.js';
import { SESSIONS } from '../../../config/constants.js';
import { logger } from '../../../lib/logger.js';

// The guard says out loud when it fires, and consola collapses an identical
// line repeated soon after by PARKING A TIMER to flush the repeat count. Every
// stall below logs the same sentence, so from the second one on that timer is
// live — and `no timer left behind` counts every fake timer, not just the
// guard's. Replacing the logger keeps that assertion about the thing it names,
// and makes the line itself assertable rather than merely emitted.
vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
}));

/** What the guard said, for the tests that pin it. */
const warned = vi.mocked(logger.warn);

const TEN_MINUTES = 10 * 60 * 1000;
const SESSION_ID = 'stall-guard-session';

/** A text_delta fixture, cast like every StreamEvent literal in server tests. */
function delta(text: string): StreamEvent {
  return { type: 'text_delta', data: { text } } as StreamEvent;
}

/** The per-outcome details string of the injected stall error. */
const STALL_DETAILS = {
  aborted: 'The in-flight turn was aborted.',
  notFound: 'No in-flight turn was found to abort; the runtime may have leaked a process.',
  failed: 'Interrupting the turn failed; the runtime may have leaked a process.',
  timedOut: 'Interrupting the turn did not finish in time; the runtime may have leaked a process.',
} as const;

/**
 * The three events the guard injects on a stall, parameterized on the outcome.
 *
 * The message defaults to the NEVER-STARTED wording because that is what these
 * sources are: a controlled source the test never emits from has yielded
 * nothing, so the guard reports the launch fault rather than the went-quiet one
 * (DOR-1229). Pass `started: true` for a source that did emit first.
 */
function stallCloseEvents(
  outcome: keyof typeof STALL_DETAILS,
  opts: { started?: boolean } = {}
): StreamEvent[] {
  return [
    {
      type: 'error',
      data: {
        message: opts.started
          ? 'No activity from the agent for 10 minutes, so the turn was interrupted.'
          : 'The agent never started working after 10 minutes, so the turn was ended.',
        code: 'turn_stalled',
        category: 'execution_error',
        details: STALL_DETAILS[outcome],
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
    onStall: vi.fn(async () => mockInterruptReceipt('acked')),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  warned.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withStallGuard', () => {
  it('forwards events and resets the inactivity clock on each one', async () => {
    const src = createControlledSource();
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
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
    let resolveStall!: (v: InterruptReceipt) => void;
    const onStall = vi.fn(
      () =>
        new Promise<InterruptReceipt>((resolve) => {
          resolveStall = resolve;
        })
    );
    const collector = collect(withStallGuard(src.source, makeOpts({ onStall })));
    await flush();

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(src.returnSpy).toHaveBeenCalledTimes(1);
    // (A second, idempotent return() fires from the outer finally when the
    // generator ends: consumer-cancellation safety.)
    // The close is GATED on the interrupt outcome (the details string differs),
    // so nothing is yielded until onStall settles, proof it is awaited.
    expect(collector.events).toEqual([]);

    resolveStall(mockInterruptReceipt('acked'));
    await flush();
    expect(collector.events).toEqual(stallCloseEvents('aborted'));
    expect(collector.isEnded()).toBe(true);

    // And it said so. Everything downstream of a stall reports a turn that
    // "failed" without saying why: a room showed an agent working for
    // forty-one minutes and the only trace of the watchdog ending it was the
    // absence of an answer.
    expect(warned).toHaveBeenCalledWith(
      '[stall-guard] no activity from the runtime; interrupting the turn',
      {
        sessionId: SESSION_ID,
        inactivityMs: TEN_MINUTES,
        timeoutMs: TEN_MINUTES,
        // No first-event window supplied, so this source that never yielded is
        // still judged by the one window — `neverStarted` reports the fact, it
        // does not shorten anything on its own.
        neverStarted: true,
      }
    );
  });

  it('closes with the leaked-process details when onStall resolves false', async () => {
    const src = createControlledSource();
    const collector = collect(
      withStallGuard(
        src.source,
        makeOpts({ onStall: vi.fn(async () => mockInterruptReceipt('not-running')) })
      )
    );
    await flush();

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(collector.events).toEqual(stallCloseEvents('notFound'));
    expect(collector.isEnded()).toBe(true);
  });

  it('routes an onStall rejection to onError and closes with the interrupt-failed details', async () => {
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
    // The interrupt was ATTEMPTED and errored: the close says so, distinct
    // from the not-found case, so lastError.details is honest to an operator.
    expect(collector.events).toEqual(stallCloseEvents('failed'));
    expect(collector.isEnded()).toBe(true);
  });

  it('re-arms while paused and fires only a full threshold after unpause', async () => {
    const src = createControlledSource();
    let paused = true;
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
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
    expect(collector.events).toEqual(stallCloseEvents('aborted'));
    expect(collector.isEnded()).toBe(true);
  });

  it('clears the timer on normal completion (no late fire)', async () => {
    const src = createControlledSource();
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
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
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
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
    // Two fire-and-forget calls: the stall path and the outer finally
    // (consumer-cancellation safety). Neither settles; the close still lands.
    expect(src.returnSpy).toHaveBeenCalledTimes(2);
    expect(collector.events).toEqual(stallCloseEvents('aborted'));
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

  it('warns with the MEASURED inactivity window, which exceeds the threshold after a pause', async () => {
    const src = createControlledSource();
    let paused = true;
    const collector = collect(withStallGuard(src.source, makeOpts({ isPaused: () => paused })));
    await flush();

    // One paused expiry (silence keeps accruing), then a real one.
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    paused = false;
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(collector.isEnded()).toBe(true);

    // inactivityMs is the REAL silence (two windows), not a restatement of the
    // threshold — an operator reading the log can tell a 20-minute park from a
    // 10-minute one.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stall-guard'), {
      sessionId: SESSION_ID,
      inactivityMs: 2 * TEN_MINUTES,
      timeoutMs: TEN_MINUTES,
      neverStarted: true,
    });
  });

  // DOR-1229. The ten-minute window buys a RUNNING agent room to be quiet. A
  // turn that has yielded nothing has not shown it is running, has spent
  // nothing, and has no work to lose — so its first gap is judged on its own,
  // shorter clock, and the person is told which of the two faults it was.
  describe('the first-event window', () => {
    const TWO_MINUTES = 2 * 60_000;

    it('ends a turn that never yields at the first-event window, not the full one', async () => {
      const src = createControlledSource();
      const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
      const collector = collect(
        withStallGuard(src.source, makeOpts({ onStall, firstEventTimeoutMs: TWO_MINUTES }))
      );
      await flush();

      // A minute short of the first-event window: still waiting.
      await vi.advanceTimersByTimeAsync(TWO_MINUTES - 60_000);
      await flush();
      expect(onStall).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      expect(onStall).toHaveBeenCalledTimes(1);
      expect(collector.isEnded()).toBe(true);
      // The error a person reads names the fault it actually was.
      expect(collector.events[0]).toEqual({
        type: 'error',
        data: {
          message: 'The agent never started working after 2 minutes, so the turn was ended.',
          code: 'turn_stalled',
          category: 'execution_error',
          details: STALL_DETAILS.aborted,
        },
      });
      expect(warned).toHaveBeenCalledWith(
        '[stall-guard] no activity from the runtime; interrupting the turn',
        {
          sessionId: SESSION_ID,
          inactivityMs: TWO_MINUTES,
          timeoutMs: TWO_MINUTES,
          neverStarted: true,
        }
      );
    });

    it('hands a turn the FULL window the moment it yields once', async () => {
      const src = createControlledSource();
      const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
      const collector = collect(
        withStallGuard(src.source, makeOpts({ onStall, firstEventTimeoutMs: TWO_MINUTES }))
      );
      await flush();

      src.emit(delta('working on it'));
      await flush();

      // Nine minutes of silence — four and a half first-event windows — and the
      // turn is left alone, because it has proved it is running.
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      await flush();
      expect(onStall).not.toHaveBeenCalled();
      expect(collector.isEnded()).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      expect(onStall).toHaveBeenCalledTimes(1);
      // And it is reported as the other fault: this one DID start.
      expect(collector.events.slice(1)).toEqual(stallCloseEvents('aborted', { started: true }));
    });

    it('never lengthens a shorter inactivity window a caller asked for', async () => {
      const src = createControlledSource();
      const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
      collect(
        withStallGuard(
          src.source,
          makeOpts({ onStall, timeoutMs: 30_000, firstEventTimeoutMs: TWO_MINUTES })
        )
      );
      await flush();

      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
      expect(onStall).toHaveBeenCalledTimes(1);
    });
  });

  it('logs the interrupt outcome when it succeeds', async () => {
    const src = createControlledSource();
    const collector = collect(withStallGuard(src.source, makeOpts()));
    await flush();

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(collector.isEnded()).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('stall-guard'),
      expect.objectContaining({ sessionId: SESSION_ID, interrupted: true, elapsedMs: 0 })
    );
  });

  it('gives up on an interrupt that never settles, closing the turn at the bound', async () => {
    const src = createControlledSource();
    // interruptQuery that hangs forever — the failure this bound exists for.
    const onStall = vi.fn(() => new Promise<InterruptReceipt>(() => {}));
    const collector = collect(withStallGuard(src.source, makeOpts({ onStall })));
    await flush();

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(onStall).toHaveBeenCalledTimes(1);

    // One tick short of the bound: still waiting, nothing closed.
    await vi.advanceTimersByTimeAsync(SESSIONS.STALL_INTERRUPT_TIMEOUT_MS - 1);
    await flush();
    expect(collector.events).toEqual([]);
    expect(collector.isEnded()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(collector.events).toEqual(stallCloseEvents('timedOut'));
    expect(collector.isEnded()).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('stall-guard'),
      expect.objectContaining({
        sessionId: SESSION_ID,
        interrupted: false,
        elapsedMs: SESSIONS.STALL_INTERRUPT_TIMEOUT_MS,
      })
    );
  });

  it('never lets an interrupt that rejects AFTER the bound become an unhandled rejection', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const src = createControlledSource();
      let failStall!: (err: unknown) => void;
      const collector = collect(
        withStallGuard(
          src.source,
          makeOpts({
            onStall: vi.fn(
              () =>
                new Promise<InterruptReceipt>((_resolve, reject) => {
                  failStall = reject;
                })
            ),
          })
        )
      );
      await flush();

      await vi.advanceTimersByTimeAsync(TEN_MINUTES + SESSIONS.STALL_INTERRUPT_TIMEOUT_MS);
      await flush();
      expect(collector.events).toEqual(stallCloseEvents('timedOut'));

      failStall(new Error('interrupt transport died long after we gave up'));
      await flush();
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('finalizes the source when the CONSUMER cancels the guard mid-race', async () => {
    const src = createControlledSource();
    const guard = withStallGuard(src.source, makeOpts());
    // Park the guard on its first race (one pull, no event delivered).
    const firstPull = guard.next();
    await flush();

    // Consumer walks away (e.g. feedProjector's for-await unwinding).
    const cancelled = guard.return(undefined);
    // The parked race must settle before the generator can process the queued
    // return(); the inactivity timer is what unblocks it.
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    await cancelled;
    await firstPull.catch(() => {});

    // The outer finally propagated finalization to the source, so its
    // generator (and any subprocess behind it) is not left suspended.
    expect(src.returnSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
