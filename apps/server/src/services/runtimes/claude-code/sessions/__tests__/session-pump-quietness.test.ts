/**
 * The quiet predicate and the two clocks that bound it (spec
 * `warm-process-lifecycle` D1, slice 2 — T3, T6, T35).
 *
 * A warm process keeps working after its turn's `result`, and until this landed
 * DorkOS could not see most of that work. `reap` asked one question — "are any
 * background SUBAGENTS live?" — so a Monitor, a task type nobody has catalogued
 * and a settled-but-undelivered notification were all reaped out from under the
 * agent (DOR-2064, DOR-2065). These tests pin the wider answer, and both bounds
 * that stop it from becoming a hold with no way out: the four-hour ceiling on a
 * busy spell, and the thirty-second clock on an owed delivery.
 *
 * Kept in its own file rather than appended to `session-pump.test.ts` because
 * it needs a mocked logger and a fake clock for every case, and neither belongs
 * to the state-machine suite next door.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { SESSIONS } from '../../../../../config/constants.js';
import { logger } from '../../../../../lib/logger.js';
import { OWED_DELIVERY_TIMEOUT_MS, SessionPump, type SessionPumpOptions } from '../session-pump.js';
import {
  assistantMessage,
  backgroundTasksMessage,
  FakeQuery,
  initMessage,
  resultMessage,
  taskNotificationMessage,
  type BackgroundTaskType,
} from './fake-pump-query.js';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A pump over a hand-driven process, with the gate re-arm recorded. */
interface Harness {
  pump: SessionPump;
  /** Every time the owed-delivery clock released the dispatch gate. */
  gateChanges: number[];
  /** Hand a frame to the process and let the pump consume it. */
  emit: (message: ReturnType<typeof initMessage>) => Promise<void>;
}

/**
 * Let every pending microtask run, so a frame handed to the fake process has
 * reached the pump's `for await` body. Microtasks, not timers: the fake clock
 * is under the test's control and must not be advanced just to deliver a frame.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Build a warm pump whose process a test drives frame by frame. */
async function warmPump(overrides: Partial<SessionPumpOptions> = {}): Promise<Harness> {
  const queries: FakeQuery[] = [];
  const gateChanges: number[] = [];
  const pump = new SessionPump({
    sessionId: 'sess-1',
    launch: () => {
      const query = new FakeQuery();
      queries.push(query);
      queueMicrotask(() => query.emit(initMessage()));
      return query;
    },
    onDispatchGateChange: () => gateChanges.push(Date.now()),
    drainGraceMs: 20,
    ...overrides,
  });
  await pump.warm();
  return {
    pump,
    gateChanges,
    emit: async (message) => {
      queries[queries.length - 1]!.emit(message);
      await flush();
    },
  };
}

/**
 * Reap, letting the polite close's grace window elapse.
 *
 * `SessionPump.drain` waits out `drainGraceMs` before the forceful close, and
 * under a fake clock that timer fires only if the test advances it — so an
 * awaited reap that actually closes a process deadlocks without this.
 *
 * @param pump - The pump to reap
 */
async function reapNow(pump: SessionPump): Promise<boolean> {
  const reaped = pump.reap();
  await vi.advanceTimersByTimeAsync(100);
  return reaped;
}

/** Put one live background task of `type` on the process. */
async function runTask(harness: Harness, type: BackgroundTaskType): Promise<void> {
  await harness.emit(backgroundTasksMessage([{ id: 'task-1', type }]));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000_000);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// T3. Every one of these but the first two was reaped by the old rule, which
// counted `local_agent` and nothing else.
describe('reap declines while the process is still working', () => {
  it('declines while a helper agent is running', async () => {
    const harness = await warmPump();
    await runTask(harness, 'local_agent');

    expect(harness.pump.quietness()).toMatchObject({
      quiet: false,
      because: 'background-work',
      holding: { agents: 1, other: 0 },
    });
    expect(await reapNow(harness.pump)).toBe(false);
  });

  it('declines while a Monitor-typed task is running', async () => {
    const harness = await warmPump();
    await runTask(harness, 'monitor');

    expect(harness.pump.quietness()).toMatchObject({
      quiet: false,
      because: 'background-work',
      holding: { agents: 0, other: 1 },
    });
    expect(await reapNow(harness.pump)).toBe(false);
  });

  it('declines while a task of a type nobody has catalogued is running', async () => {
    const harness = await warmPump();
    await runTask(harness, 'some_type_shipped_next_year');

    expect(await reapNow(harness.pump)).toBe(false);
  });

  it('declines while a settled notification has not been delivered', async () => {
    const harness = await warmPump();
    await harness.emit(taskNotificationMessage('task-1'));

    expect(harness.pump.quietness()).toMatchObject({
      quiet: false,
      because: 'delivery-owed',
    });
    expect(await reapNow(harness.pump)).toBe(false);
  });

  it('proceeds when only background shells are running', async () => {
    const harness = await warmPump();
    await runTask(harness, 'local_bash');

    // Shells are reported so the operator can be told they ended, and they hold
    // nothing: the CLI kills them shortly after stdin closes either way.
    expect(harness.pump.quietness()).toMatchObject({ quiet: true, shells: 1 });
    expect(await reapNow(harness.pump)).toBe(true);
  });
});

// T6. The ceiling is what stops "declines while working" from becoming
// "declines forever", and the reset is what stops two helpers running back to
// back from being read as two separate spells.
describe('the background-work ceiling and its quiet reset', () => {
  /** Run a helper, go quiet for `quietMs`, then run another one. */
  async function spellWithGap(quietMs: number): Promise<Harness> {
    const harness = await warmPump();
    await runTask(harness, 'local_agent');
    vi.advanceTimersByTime(SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS - 10 * 60_000);
    await harness.emit(backgroundTasksMessage([]));
    vi.advanceTimersByTime(quietMs);
    await runTask(harness, 'local_agent');
    return harness;
  }

  it('does not reset the ceiling for thirty seconds of quiet', async () => {
    const harness = await spellWithGap(30_000);

    // The spell still dates from the first helper, so eleven more minutes puts
    // it past four hours and the process is taken back.
    vi.advanceTimersByTime(11 * 60_000);
    expect(harness.pump.isHoldingBackgroundWork()).toBe(false);
    expect(await reapNow(harness.pump)).toBe(true);
  });

  it('does reset the ceiling for a full minute of quiet', async () => {
    const harness = await spellWithGap(SESSIONS.BACKGROUND_QUIET_RESET_MS);

    // Same eleven minutes, but the spell restarted at the second helper, so the
    // ceiling is nowhere near and the work is still protected.
    vi.advanceTimersByTime(11 * 60_000);
    expect(harness.pump.isHoldingBackgroundWork()).toBe(true);
    expect(await reapNow(harness.pump)).toBe(false);
  });
});

// T35. The one hold with no other way out: a delivery that is owed and never
// arrives. Before this clock, `owed` on the warm path was cleared only by a
// delivery segment, and the deadline that bounds it lives in a stdin close the
// pump never performs.
describe('the owed-delivery clock', () => {
  it('gives up thirty seconds after the result, clearing the debt and releasing the gate', async () => {
    const harness = await warmPump();
    await harness.emit(taskNotificationMessage('task-1'));
    await harness.emit(resultMessage());

    vi.advanceTimersByTime(OWED_DELIVERY_TIMEOUT_MS - 1);
    expect(harness.gateChanges).toHaveLength(0);
    expect(harness.pump.quietness()).toMatchObject({ because: 'delivery-owed' });

    vi.advanceTimersByTime(1);
    expect(harness.gateChanges).toHaveLength(1);
    expect(harness.pump.quietness()).toMatchObject({ quiet: true });
    expect(logger.info).toHaveBeenCalledWith(
      '[SessionPump] an owed delivery never arrived; releasing the queue',
      expect.objectContaining({ tasks: ['task-1'] })
    );
  });

  it('arms on a notification that lands with no turn and no segment running', async () => {
    const harness = await warmPump();
    // No `result` at all: the settle itself is what takes the count from zero,
    // and without this arming point nothing would ever release the debt.
    await harness.emit(taskNotificationMessage('task-1'));

    vi.advanceTimersByTime(OWED_DELIVERY_TIMEOUT_MS);
    expect(harness.gateChanges).toHaveLength(1);
    expect(harness.pump.quietness()).toMatchObject({ quiet: true });
  });

  it('is cancelled by a segment starting, whose init clears the debt properly', async () => {
    const harness = await warmPump();
    await harness.emit(taskNotificationMessage('task-1'));
    await harness.emit(resultMessage());

    vi.advanceTimersByTime(10_000);
    await harness.emit(assistantMessage());
    vi.advanceTimersByTime(OWED_DELIVERY_TIMEOUT_MS);

    // The clock is gone, so nothing gave up on the delivery; the debt is still
    // owed because this segment has not finished handing it over.
    expect(harness.gateChanges).toHaveLength(0);
    expect(harness.pump.quietness()).toMatchObject({ because: 'delivery-owed' });

    await harness.emit(initMessage());
    expect(harness.pump.quietness()).toMatchObject({ quiet: true });
  });

  it('is not re-armed by a further settle', async () => {
    const harness = await warmPump();
    await harness.emit(taskNotificationMessage('task-1'));

    vi.advanceTimersByTime(20_000);
    await harness.emit(taskNotificationMessage('task-2'));

    // The bound is on the debt, not on each notification: a stream of settles
    // must not walk the deadline forward. Ten more seconds is thirty from the
    // FIRST one, and that is when it fires.
    vi.advanceTimersByTime(10_000);
    expect(harness.gateChanges).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      '[SessionPump] an owed delivery never arrived; releasing the queue',
      expect.objectContaining({ tasks: ['task-1', 'task-2'] })
    );
  });

  it('measures how late a delivery that arrives after the clock expired was', async () => {
    const harness = await warmPump();
    await harness.emit(taskNotificationMessage('task-1'));
    vi.advanceTimersByTime(OWED_DELIVERY_TIMEOUT_MS);

    vi.advanceTimersByTime(5_000);
    await harness.emit(assistantMessage());

    // The thirty seconds are a guarantee, not a measurement. This line is how
    // the number gets checked against real sessions instead of assumed.
    expect(logger.info).toHaveBeenCalledWith(
      '[SessionPump] a delivery arrived after its clock expired',
      expect.objectContaining({ lateByMs: 5_000 })
    );
  });
});
