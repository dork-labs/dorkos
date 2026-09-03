/**
 * Unit tests for the stall watchdog's WINDOWED lifetime (task 3.7).
 *
 * The unwindowed contract — pass-through, pause, the three closing events, the
 * bounded interrupt — is pinned by `stall-guard.test.ts` and is deliberately
 * not restated here. What this file pins is the one thing task 3.7 changed:
 * with a {@link TurnWindowSignal} supplied, the inactivity clock runs only
 * while a turn window is open, so a warm process between turns is never
 * watchdogged while a turn that has gone dark still trips at the same bound.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import { withStallGuard } from '../stall-guard.js';
import type { StallGuardOpts } from '../stall-guard.js';
import { MAX_CANCELLED_WINDOWS, TurnWindowSignal } from '../turn-window-signal.js';

// The guard says out loud when it fires, and consola parks a timer to collapse
// an identical line repeated soon after — which would pollute the timer-count
// assertions below. Replacing the logger keeps those about the guard's timers.
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

const TEN_MINUTES = 10 * 60 * 1000;
const SESSION_ID = 'windowed-stall-session';

/** A text_delta fixture, cast like every StreamEvent literal in server tests. */
function delta(text: string): StreamEvent {
  return { type: 'text_delta', data: { text } } as StreamEvent;
}

/**
 * The three events the guard injects when an interrupt aborts the turn.
 *
 * The never-started wording, because every source in this file yields nothing
 * before the stall — the guard distinguishes a turn that went quiet from one
 * that never got going (DOR-1229). The WINDOW is unchanged at ten minutes: no
 * test here supplies a first-event bound.
 */
const STALL_CLOSE: StreamEvent[] = [
  {
    type: 'error',
    data: {
      message: 'The agent never started working after 10 minutes, so the turn was ended.',
      code: 'turn_stalled',
      category: 'execution_error',
      details: 'The in-flight turn was aborted.',
    },
  },
  { type: 'session_status', data: { sessionId: SESSION_ID, terminalReason: 'error' } },
  { type: 'done', data: { sessionId: SESSION_ID } },
] as StreamEvent[];

/** A source whose next() promises the test settles by hand. */
function createControlledSource() {
  const pending: Array<{
    resolve: (r: IteratorResult<StreamEvent>) => void;
    reject: (e: unknown) => void;
  }> = [];
  const iterator: AsyncIterator<StreamEvent> = {
    next: () =>
      new Promise<IteratorResult<StreamEvent>>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    return: vi.fn<() => Promise<IteratorResult<StreamEvent>>>(async () => ({
      done: true,
      value: undefined,
    })),
  };
  return {
    source: { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<StreamEvent>,
    emit: (event: StreamEvent) => pending.shift()?.resolve({ done: false, value: event }),
    end: () => pending.shift()?.resolve({ done: true, value: undefined }),
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

/** Guard opts with overridable pieces; onStall defaults to interrupted=true. */
function makeOpts(overrides: Partial<StallGuardOpts> = {}): StallGuardOpts {
  return {
    sessionId: SESSION_ID,
    timeoutMs: TEN_MINUTES,
    isPaused: () => false,
    onStall: vi.fn(async () => mockInterruptReceipt('acked')),
    ...overrides,
  };
}

/** A stand-in for a `TurnWindow`; the signal keys on identity and nothing else. */
function window(name: string): object {
  return { name };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withStallGuard, windowed', () => {
  it('never fires while no turn window is open, and arms no timer at all', async () => {
    const src = createControlledSource();
    const windows = new TurnWindowSignal();
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
    const collector = collect(withStallGuard(src.source, makeOpts({ onStall, windows })));
    await flush();

    // A WARM process between turns: silent for three full stall windows. The
    // idle timer (5 min, session-pump-registry) is what bounds this silence;
    // the watchdog has no turn to end and must not invent one.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 3);
    await flush();
    expect(onStall).not.toHaveBeenCalled();
    expect(collector.events).toEqual([]);
    expect(collector.isEnded()).toBe(false);
  });

  it('arms on window open and fires at the same bound when the turn goes dark', async () => {
    const src = createControlledSource();
    const windows = new TurnWindowSignal();
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
    const collector = collect(withStallGuard(src.source, makeOpts({ onStall, windows })));
    await flush();

    windows.opened(window('turn-1'));
    await flush();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1);
    await flush();
    expect(onStall).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(collector.events).toEqual(STALL_CLOSE);
    expect(collector.isEnded()).toBe(true);
  });

  it('still resets the clock on activity inside an open window', async () => {
    const src = createControlledSource();
    const windows = new TurnWindowSignal();
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
    const collector = collect(withStallGuard(src.source, makeOpts({ onStall, windows })));
    await flush();

    windows.opened(window('turn-1'));
    await flush();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    src.emit(delta('working'));
    await flush();
    // Nine more minutes: eighteen since the window opened, nine since the event.
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await flush();
    expect(onStall).not.toHaveBeenCalled();
    expect(collector.events).toEqual([delta('working')]);

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('disarms on window close, leaving no timer to fire on a warm session', async () => {
    const src = createControlledSource();
    const windows = new TurnWindowSignal();
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
    const turn = window('turn-1');
    const collector = collect(withStallGuard(src.source, makeOpts({ onStall, windows })));
    await flush();

    windows.opened(turn);
    await flush();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    windows.closed(turn);
    await flush();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 3);
    await flush();
    expect(onStall).not.toHaveBeenCalled();
    expect(collector.isEnded()).toBe(false);
  });

  it('gives the next window a full fresh bound rather than the last one leftover', async () => {
    const src = createControlledSource();
    const windows = new TurnWindowSignal();
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
    const first = window('turn-1');
    collect(withStallGuard(src.source, makeOpts({ onStall, windows })));
    await flush();

    windows.opened(first);
    await flush();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    windows.closed(first);
    await flush();

    windows.opened(window('turn-2'));
    await flush();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1);
    await flush();
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('stays armed when a second window closes while the first is still open', async () => {
    const src = createControlledSource();
    const windows = new TurnWindowSignal();
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
    const dispatched = window('dispatched');
    const runtime = window('runtime');
    collect(withStallGuard(src.source, makeOpts({ onStall, windows })));
    await flush();

    // The windower opens a synthetic `runtime` window for a result nobody
    // dispatched, and closes it, WITHOUT touching the dispatched window that is
    // still running. A flag would disarm here; the count does not.
    windows.opened(dispatched);
    windows.opened(runtime);
    windows.closed(runtime);
    await flush();
    expect(windows.isOpen).toBe(true);

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('does not fire on a window parked on a person, for as long as they take', async () => {
    const src = createControlledSource();
    const windows = new TurnWindowSignal();
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
    let paused = true;
    collect(withStallGuard(src.source, makeOpts({ onStall, windows, isPaused: () => paused })));
    await flush();

    windows.opened(window('turn-1'));
    await flush();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 3);
    await flush();
    expect(onStall).not.toHaveBeenCalled();

    // Answered: the re-armed timer still owes a full window before it fires.
    paused = false;
    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1);
    await flush();
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('leaves no timer and no subscription behind when the stream ends', async () => {
    const src = createControlledSource();
    const windows = new TurnWindowSignal();
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
    const turn = window('turn-1');
    const collector = collect(withStallGuard(src.source, makeOpts({ onStall, windows })));
    await flush();

    windows.opened(turn);
    await flush();
    src.emit(delta('done thinking'));
    await flush();
    windows.closed(turn);
    src.end();
    await flush();
    expect(collector.isEnded()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(windows.watcherCount).toBe(0);

    // A window opened by the NEXT turn must not reach the guard that ended.
    windows.opened(window('turn-2'));
    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 2);
    await flush();
    expect(onStall).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a pause probe that throws and fires rather than hanging on it', async () => {
    const src = createControlledSource();
    const windows = new TurnWindowSignal();
    const onStall = vi.fn(async () => mockInterruptReceipt('acked'));
    const onError = vi.fn();
    const boom = new Error('the projector is gone');
    const collector = collect(
      withStallGuard(
        src.source,
        makeOpts({
          onStall,
          windows,
          onError,
          isPaused: () => {
            throw boom;
          },
        })
      )
    );
    await flush();

    windows.opened(window('turn-1'));
    await flush();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    await flush();
    // A probe that cannot answer must not crash the timer that asked it, and
    // must not be able to suppress the watchdog forever either.
    expect(onError).toHaveBeenCalledWith(boom);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(collector.events).toEqual(STALL_CLOSE);
  });
});

describe('TurnWindowSignal', () => {
  it('counts open windows and announces only the edges', () => {
    const signal = new TurnWindowSignal();
    const seen: boolean[] = [];
    const unwatch = signal.watch((open) => seen.push(open));
    const a = window('a');
    const b = window('b');

    expect(signal.isOpen).toBe(false);
    signal.opened(a);
    signal.opened(b);
    expect(seen).toEqual([true]);
    expect(signal.isOpen).toBe(true);

    signal.closed(b);
    expect(seen).toEqual([true]);
    expect(signal.isOpen).toBe(true);

    signal.closed(a);
    expect(seen).toEqual([true, false]);
    expect(signal.isOpen).toBe(false);

    unwatch();
    signal.opened(a);
    expect(seen).toEqual([true, false]);
    expect(signal.watcherCount).toBe(0);
  });

  it('ignores a close for a window it never saw open', () => {
    const signal = new TurnWindowSignal();
    const seen: boolean[] = [];
    signal.watch((open) => seen.push(open));

    signal.opened(window('a'));
    signal.closed(window('never-opened'));
    expect(signal.isOpen).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('cancels the open of a window whose close arrived first', () => {
    const signal = new TurnWindowSignal();
    const seen: boolean[] = [];
    signal.watch((open) => seen.push(open));
    const inverted = window('closed-before-it-opened');

    signal.closed(inverted);
    signal.opened(inverted);
    // The window is over: its late open is the announcement of a turn that has
    // already finished, and taking it at face value would leave the count at
    // one with nothing left to close it.
    expect(signal.isOpen).toBe(false);
    expect(seen).toEqual([]);
  });

  it('spends a cancellation on one open only', () => {
    const signal = new TurnWindowSignal();
    const seen: boolean[] = [];
    signal.watch((open) => seen.push(open));
    const reused = window('same-identity-twice');

    signal.closed(reused);
    signal.opened(reused);
    expect(signal.isOpen).toBe(false);

    // Whatever the next open means, it is not the one that was cancelled.
    signal.opened(reused);
    expect(signal.isOpen).toBe(true);
    expect(seen).toEqual([true]);
    signal.closed(reused);
    expect(signal.isOpen).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('keeps an inverted window from disarming a turn that is genuinely open', () => {
    const signal = new TurnWindowSignal();
    const live = window('live-turn');
    const inverted = window('inverted');

    signal.opened(live);
    signal.closed(inverted);
    signal.opened(inverted);
    expect(signal.isOpen).toBe(true);

    signal.closed(live);
    expect(signal.isOpen).toBe(false);
  });

  it('bounds the cancellations it remembers, oldest first', () => {
    const signal = new TurnWindowSignal();
    const windows = Array.from({ length: MAX_CANCELLED_WINDOWS + 1 }, (_, i) => window(`w${i}`));
    for (const w of windows) signal.closed(w);

    // The oldest was evicted, so its open is taken at face value — the honest
    // outcome for a cancellation nobody claimed within a full cap's worth of
    // windows, and the reason the bound is safe: the real inversion is claimed
    // inside a single dispatch.
    signal.opened(windows[0]!);
    expect(signal.isOpen).toBe(true);
    signal.closed(windows[0]!);

    // Everything still remembered cancels as it should.
    signal.opened(windows[1]!);
    expect(signal.isOpen).toBe(false);
  });
});
