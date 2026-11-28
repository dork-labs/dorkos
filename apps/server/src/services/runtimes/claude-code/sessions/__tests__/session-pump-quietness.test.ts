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
  taskStartedMessage,
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
  /** The process dies mid-stream, as a crashed CLI does. */
  crash: () => Promise<void>;
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
    crash: async () => {
      queries[queries.length - 1]!.failStream(new Error('CLI exited'));
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

  it('declines while a settled notification has not been delivered', async () => {
    const harness = await warmPump();
    await harness.emit(taskNotificationMessage('task-1'));

    expect(harness.pump.quietness()).toMatchObject({
      quiet: false,
      because: 'delivery-owed',
    });
    expect(await reapNow(harness.pump)).toBe(false);
  });

  // DOR-2065. A warm process never closes stdin, so its background shells live
  // on, and when one finishes the CLI wakes the model with the result, as it
  // does in the bare CLI. Reaping took that wake away: a PR watcher started
  // before a turn ended died with the process five minutes later, and the chat
  // never heard back (the 2026-10-05 overnight builders).
  it('declines while a background shell is running', async () => {
    const harness = await warmPump();
    await runTask(harness, 'local_bash');

    expect(harness.pump.quietness()).toMatchObject({
      quiet: false,
      because: 'background-work',
      holding: { agents: 0, other: 0 },
      shells: 1,
    });
    expect(await reapNow(harness.pump)).toBe(false);
    expect(harness.pump.isHoldingWork()).toBe(true);
  });
});

// DOR-2717. A session timer lives inside the CLI and is no task, so only the
// Stop hook's report says one is pending. Reaping before it fires loses it.
describe('a pending session timer holds the process', () => {
  it('declines to reap while a timer is pending, and counts it as held work', async () => {
    const harness = await warmPump({ hasPendingTimer: () => true });

    expect(harness.pump.quietness()).toMatchObject({ quiet: false, because: 'timer-pending' });
    expect(await reapNow(harness.pump)).toBe(false);
    expect(harness.pump.isHoldingWork()).toBe(true);
    // A timer alone is reclaimable as a last resort, like a shell.
    expect(harness.pump.isHoldingOnlyReclaimable()).toBe(true);
  });

  it('lets the process go once no timer is pending', async () => {
    const harness = await warmPump({ hasPendingTimer: () => false });

    expect(await reapNow(harness.pump)).toBe(true);
  });
});

// DOR-2681. Record eviction asks this, and it is the only thing that protects a
// turn the AGENT started: nobody dispatched it, so the session has no
// `activeQuery` for the store's own in-flight rule to see. It used to answer
// only for background work, and a runtime turn outranks that reason, so a
// helper's report still being written thirty minutes on was torn down mid-turn.
describe('isHoldingWork, the question record eviction asks', () => {
  it('holds while a turn the agent started is open, even with a helper running under it', async () => {
    const harness = await warmPump({ hasRuntimeTurnOpen: () => true });
    await runTask(harness, 'local_agent');

    expect(harness.pump.quietness()).toMatchObject({ because: 'runtime-turn-open' });
    expect(harness.pump.isHoldingWork()).toBe(true);
  });

  it('leaves a person-wait to the store, which bounds it by its own ceiling', async () => {
    const harness = await warmPump({ hasPendingInteraction: () => true });

    expect(harness.pump.quietness()).toMatchObject({ because: 'waiting-on-person' });
    expect(harness.pump.isHoldingWork()).toBe(false);
  });

  it('holds nothing once the process is quiet', async () => {
    const harness = await warmPump();

    expect(harness.pump.isHoldingWork()).toBe(false);
  });
});

// DOR-2681. What the stall watchdog asks, and the ceiling that keeps a helper
// that never finishes from excusing a silent turn forever.
describe('isHelperWorking, the question the stall watchdog asks', () => {
  it('answers yes while a helper runs, until its spell passes the ceiling', async () => {
    const harness = await warmPump();
    await runTask(harness, 'local_agent');
    expect(harness.pump.isHelperWorking()).toBe(true);

    vi.advanceTimersByTime(SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS);
    expect(harness.pump.isHelperWorking()).toBe(false);
  });

  // DOR-2717. A Monitor, a Workflow or a backgrounded MCP task is just as
  // silent between its steps as a helper, and the watchdog cut them at ten
  // minutes. Every live task type now excuses a silent turn.
  it.each(['monitor', 'local_workflow', 'mcp_task'])(
    'answers yes while a %s task runs',
    async (type) => {
      const harness = await warmPump();
      await runTask(harness, type as BackgroundTaskType);
      expect(harness.pump.isHelperWorking()).toBe(true);
    }
  );

  it('answers no for a background shell alone, so a dev server cannot hide a hung turn', async () => {
    const harness = await warmPump();
    await runTask(harness, 'local_bash');
    expect(harness.pump.isHelperWorking()).toBe(false);
  });
});

// DOR-2717. A laptop asleep for the night is not four hours of work: the
// ceiling is measured in awake time, so waking up does not reap at once.
describe('the ceiling counts awake time, not time asleep', () => {
  it('still holds a working process after the wall clock jumps past the ceiling', async () => {
    const harness = await warmPump();
    await runTask(harness, 'local_bash');

    // A sleep moves the wall clock and nothing else: no timer ran meanwhile.
    vi.setSystemTime(Date.now() + SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS + 60 * 60_000);

    expect(harness.pump.isPastCeiling()).toBe(false);
    expect(await reapNow(harness.pump)).toBe(false);
  });

  it('reaches the ceiling after that much awake time', async () => {
    const harness = await warmPump();
    await runTask(harness, 'local_bash');

    vi.advanceTimersByTime(SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS);

    expect(harness.pump.isPastCeiling()).toBe(true);
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

  it('does reset the ceiling for a full minute of quiet', async () => {
    const harness = await spellWithGap(SESSIONS.BACKGROUND_QUIET_RESET_MS);

    // Same eleven minutes, but the spell restarted at the second helper, so the
    // ceiling is nowhere near and the work is still protected.
    vi.advanceTimersByTime(11 * 60_000);
    expect(harness.pump.isHoldingWork()).toBe(true);
    expect(await reapNow(harness.pump)).toBe(false);
  });
});

// DOR-2705. The ceiling bounds work nobody hears from. A turn the agent is
// still talking in is not that: helpers ran for nearly four hours, the agent
// opened a turn to report on them, and the reap took the process back mid-turn
// ("DorkOS closed the agent before it finished this turn").
describe('an open turn that is still talking is never past the ceiling', () => {
  it('keeps a turn that talks past four hours of busy time', async () => {
    let turnOpen = false;
    const harness = await warmPump({ hasRuntimeTurnOpen: () => turnOpen });
    await runTask(harness, 'local_agent');
    vi.advanceTimersByTime(SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS - 60_000);

    // The frame that opens an agent-started turn reaches the pump BEFORE the
    // windower opens the window for it, so the window opens after the emit.
    await harness.emit(assistantMessage());
    turnOpen = true;
    vi.advanceTimersByTime(5 * 60_000);

    expect(harness.pump.isPastCeiling()).toBe(false);
    expect(harness.pump.isHoldingWork()).toBe(true);
    expect(await reapNow(harness.pump)).toBe(false);
  });

  it('ends a turn that keeps talking at the 16-hour limit', async () => {
    let turnOpen = false;
    const harness = await warmPump({ hasRuntimeTurnOpen: () => turnOpen });
    await harness.emit(assistantMessage());
    turnOpen = true;
    // One word every hour: never four quiet hours, but sixteen in all.
    for (let hour = 1; hour < 16; hour += 1) {
      vi.advanceTimersByTime(60 * 60_000);
      await harness.emit(assistantMessage());
      expect(harness.pump.isPastCeiling()).toBe(false);
    }
    vi.advanceTimersByTime(60 * 60_000);
    await harness.emit(assistantMessage());

    expect(SESSIONS.TURN_HARD_CEILING_MS).toBe(4 * SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS);
    expect(harness.pump.isPastHardLimit()).toBe(true);
    expect(harness.pump.isPastCeiling()).toBe(true);
    expect(await reapNow(harness.pump)).toBe(true);
  });

  it('ends a chain of short turns at 16 hours of nonstop work', async () => {
    let turnOpen = false;
    const harness = await warmPump({ hasRuntimeTurnOpen: () => turnOpen });
    // A Monitor stays live across every turn, so the process is never quiet.
    await runTask(harness, 'monitor');
    // Turn after turn the agent starts itself, each one hour, back to back.
    for (let hour = 1; hour <= 15; hour += 1) {
      await harness.emit(assistantMessage());
      turnOpen = true;
      vi.advanceTimersByTime(60 * 60_000 - 1_000);
      await harness.emit(assistantMessage());
      await harness.emit(resultMessage());
      turnOpen = false;
      vi.advanceTimersByTime(1_000);
    }
    await harness.emit(assistantMessage());
    turnOpen = true;
    expect(harness.pump.isPastCeiling()).toBe(false);

    vi.advanceTimersByTime(60 * 60_000);
    await harness.emit(assistantMessage());

    // No single turn ran past an hour, but the busy stretch has run sixteen.
    expect(harness.pump.isPastHardLimit()).toBe(true);
    expect(harness.pump.isPastCeiling()).toBe(true);
    expect(harness.pump.isHoldingWork()).toBe(false);
  });

  it('still ends a /loop between its turns once the background clock runs out', async () => {
    let turnOpen = false;
    const harness = await warmPump({
      hasRuntimeTurnOpen: () => turnOpen,
      hasPendingTimer: () => true,
    });
    // A timer wakes the agent every hour; each wake is a short turn that talks.
    for (let hour = 1; hour <= 4; hour += 1) {
      vi.advanceTimersByTime(60 * 60_000 - 60_000);
      await harness.emit(assistantMessage());
      turnOpen = true;
      vi.advanceTimersByTime(60_000);
      turnOpen = false;
    }

    expect(harness.pump.isPastCeiling()).toBe(true);
    expect(await reapNow(harness.pump)).toBe(true);
  });

  it('still reaches the ceiling when an open turn says nothing for four hours', async () => {
    let turnOpen = false;
    const harness = await warmPump({ hasRuntimeTurnOpen: () => turnOpen });
    await runTask(harness, 'local_agent');
    turnOpen = true;
    await harness.emit(assistantMessage());

    vi.advanceTimersByTime(SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS);

    expect(harness.pump.isPastCeiling()).toBe(true);
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

    // The init hands the debt over, and the segment holds until it speaks
    // (DOR-5490); a segment with nothing in it ends at its `result`.
    await harness.emit(initMessage());
    expect(harness.pump.quietness()).toMatchObject({ because: 'segment-starting' });
    await harness.emit(resultMessage());
    expect(harness.pump.quietness()).toMatchObject({ quiet: true });
  });
});

// DOR-5490. A report segment's init clears the owed delivery, and no window
// opens until the model's first frame, so for the whole time to first token the
// process read as quiet: a reap, a slot reclaim or a relaunch for new settings
// could end it mid-request, and the queue launched a person's message into it.
describe('a segment that has opened and not yet spoken', () => {
  /** A finished helper's report segment, opened and waiting on the model. */
  async function reportSegmentOpened(harness: Harness): Promise<void> {
    await harness.emit(resultMessage());
    await harness.emit(taskNotificationMessage('task-1'));
    await harness.emit(initMessage());
  }

  it('holds past the restart settle interval, and a reap declines', async () => {
    const harness = await warmPump();
    await reportSegmentOpened(harness);

    vi.advanceTimersByTime(SESSIONS.RESTART_SETTLE_MS * 10);
    expect(harness.pump.quietness()).toMatchObject({ quiet: false, because: 'segment-starting' });
    expect(await reapNow(harness.pump)).toBe(false);

    // A helper still talking is not the segment speaking.
    await harness.emit({ ...assistantMessage(), parent_tool_use_id: 'toolu-helper' } as never);
    expect(harness.pump.quietness()).toMatchObject({ because: 'segment-starting' });

    // The main thread's first frame ends it; from here the open runtime window
    // holds the process (`session-turn-windows.report-gap.test.ts`).
    await harness.emit(assistantMessage());
    expect(harness.pump.quietness()).toMatchObject({ quiet: true });
  });

  it('is not given up as shells-only work while the segment is opening', async () => {
    const harness = await warmPump();
    await reportSegmentOpened(harness);
    await runTask(harness, 'local_bash');

    expect(harness.pump.isHoldingOnlyReclaimable()).toBe(false);
    expect(await harness.pump.reapReclaimable()).toBe(false);
  });

  it('drops at once when the process dies in the gap, and a relaunch starts quiet', async () => {
    const harness = await warmPump();
    await reportSegmentOpened(harness);

    // What `isSegmentPending` reads: a dead process cannot speak, so a person's
    // message must not wait two minutes on it.
    await harness.crash();
    expect(harness.pump.state).toBe('crashed');
    expect(harness.pump.quietness()).toMatchObject({ quiet: true });

    await harness.pump.warm();
    expect(harness.pump.quietness()).toMatchObject({ quiet: true });
  });

  it('keeps the owed-delivery clock when the process dies before the segment opens', async () => {
    const harness = await warmPump();
    await harness.emit(resultMessage());
    await harness.emit(taskNotificationMessage('task-1'));
    await harness.crash();
    expect(harness.pump.quietness()).toMatchObject({ because: 'delivery-owed' });

    // The clock is what clears the dead tracker's debt and lets the queue go.
    vi.advanceTimersByTime(OWED_DELIVERY_TIMEOUT_MS);
    expect(harness.pump.quietness()).toMatchObject({ quiet: true });
    expect(harness.gateChanges).toHaveLength(1);
  });

  it('is not kept past the wait by a helper that keeps talking', async () => {
    const harness = await warmPump();
    await reportSegmentOpened(harness);

    const helperFrame = { ...assistantMessage(), parent_tool_use_id: 'toolu-helper' } as never;
    vi.advanceTimersByTime(90_000);
    await harness.emit(helperFrame);
    vi.advanceTimersByTime(SESSIONS.TURN_FIRST_EVENT_TIMEOUT_MS - 90_000);
    expect(harness.gateChanges).toHaveLength(1);
    expect(harness.pump.quietness()).toMatchObject({ quiet: true });
  });

  it('is not kept past the wait by task progress from a finished helper', async () => {
    const harness = await warmPump();
    await reportSegmentOpened(harness);

    // A `task_progress` carries no `parent_tool_use_id`; no task is live.
    const progress = { type: 'system', subtype: 'task_progress', task_id: 'task-1' } as never;
    vi.advanceTimersByTime(90_000);
    await harness.emit(progress);
    vi.advanceTimersByTime(SESSIONS.TURN_FIRST_EVENT_TIMEOUT_MS - 90_000);
    expect(harness.gateChanges).toHaveLength(1);
    expect(harness.pump.quietness()).toMatchObject({ quiet: true });
  });

  it('gives up after two minutes of silence, releasing the gate; a frame of its own restarts the wait', async () => {
    const harness = await warmPump();
    await reportSegmentOpened(harness);

    vi.advanceTimersByTime(SESSIONS.TURN_FIRST_EVENT_TIMEOUT_MS - 1_000);
    await harness.emit({ type: 'system', subtype: 'status', status: 'requesting' } as never);
    vi.advanceTimersByTime(SESSIONS.TURN_FIRST_EVENT_TIMEOUT_MS - 1);
    expect(harness.gateChanges).toHaveLength(0);
    expect(harness.pump.quietness()).toMatchObject({ because: 'segment-starting' });

    vi.advanceTimersByTime(1);
    expect(harness.gateChanges).toHaveLength(1);
    expect(harness.pump.quietness()).toMatchObject({ quiet: true });
  });
});

// DOR-3755 item 3. The CLI emits `task_notification` for EVERY task it
// registers, the ones nothing will ever be delivered for included: a foreground
// helper or shell, whose result already went back inline as its tool result,
// and a task it keeps out of the transcript (`skip_transcript`). Each of those
// used to open a debt no delivery segment would ever clear, so the next message
// into the chat waited out the whole owed-delivery clock.
describe('a settle nothing will be delivered for (DOR-3755)', () => {
  it('a foreground task owes nothing, so the next message is not held for thirty seconds', async () => {
    const harness = await warmPump();
    await harness.emit(taskStartedMessage('fg-1', false));
    await harness.emit(taskNotificationMessage('fg-1'));
    await harness.emit(resultMessage());

    expect(harness.pump.quietness()).toMatchObject({ quiet: true });
    vi.advanceTimersByTime(OWED_DELIVERY_TIMEOUT_MS);
    // No clock was armed, so none gave up on anything.
    expect(harness.gateChanges).toHaveLength(0);
    expect(logger.info).not.toHaveBeenCalledWith(
      '[SessionPump] an owed delivery never arrived; releasing the queue',
      expect.anything()
    );
  });
});
