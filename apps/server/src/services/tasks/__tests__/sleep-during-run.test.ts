/**
 * A run the computer slept through is not stopped as over its time limit, and
 * a fire in a dark wake waits for the computer to settle (DOR-3286). Nor is a
 * run that waited in line for a free agent slot: its limit counts from when its
 * turn starts (DOR-4576).
 *
 * The deadline cases run on real timers at a small scale, under a clock that
 * reports how long the computer slept: awake time is elapsed time minus sleep,
 * and that sum is the contract. The settle cases run on a hand-driven clock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { SLOT_WAIT_STATUS } from '@dorkos/shared/schemas';
import { MAX_START_WAIT_MS } from '@dorkos/shared/run-time-limit';
import { SESSIONS } from '../../../config/constants.js';
import { createAwakeClock, type AwakeClock, type AwakeTimers } from '@dorkos/shared/awake-clock';
import { createTestDb } from '@dorkos/test-utils/db';
import { initBoundary } from '../../../lib/boundary.js';
import { TaskSchedulerService, singleRuntimeSource } from '../task-scheduler-service.js';
import { TaskStore } from '../task-store.js';
import { isTerminalRunStatus } from '../lifecycle/run-statuses.js';
import {
  RUN_START_WAIT_MS,
  WAKE_SETTLE_MS,
  WakeSettle,
  runDeadline,
} from '../timing/wake-settle.js';

vi.mock('../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn(() => false),
}));

vi.mock('../../runtimes/claude-code/claude-config-dir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../runtimes/claude-code/claude-config-dir.js')>()),
  isRegisteredClaudeAccount: vi.fn(() => undefined),
}));

const CONFIG = { maxConcurrentRuns: 2, retentionCount: 100, mayFire: true, firingReason: 'test' };

/** Real timers, and a sleep total the test sets. */
function reportedSleep(): { clock: AwakeClock; slept: (ms: number) => void } {
  const real = createAwakeClock();
  real.dispose();
  let slept = 0;
  return {
    clock: { ...real, sleptMs: () => slept, lastWakeAt: () => null },
    slept: (ms) => (slept += ms),
  };
}

/** A turn that emits one event, works for `ms`, then finishes. */
function agentWorkingFor(ms: number, onStart: () => void = () => {}) {
  return {
    type: 'claude-code',
    ensureSession: vi.fn(),
    sendMessage: async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
      onStart();
      await new Promise((resolve) => setTimeout(resolve, ms));
      yield { type: 'done', data: { sessionId: 's' } } as StreamEvent;
    },
    interruptQuery: vi.fn().mockResolvedValue(true),
    getInternalSessionId: vi.fn(() => undefined),
    acquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
  };
}

let store: TaskStore;

beforeEach(async () => {
  store = new TaskStore(createTestDb());
  await initBoundary('/');
});

function newTask(maxRuntime: number) {
  return store.createTask({
    name: 'nightly',
    description: 'test',
    prompt: 'test',
    cron: '0 3 * * *',
    maxRuntime,
    filePath: '/tmp/tasks/nightly/SKILL.md',
  });
}

describe('a run the computer slept through (direct path)', () => {
  it('finishes, rather than being stopped on wake as over its time limit', async () => {
    const { clock, slept } = reportedSleep();
    // 1s of work under a 500ms limit, 900ms of which the computer slept: 100ms awake.
    const service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(agentWorkingFor(1_000, () => slept(900)) as never),
      config: CONFIG,
      wakeSettle: new WakeSettle(clock),
    });
    const run = await service.triggerManualRun(newTask(500).id);

    await vi.waitFor(() => expect(isTerminalRunStatus(store.getRun(run!.id)!.status)).toBe(true), {
      timeout: 5_000,
    });
    expect(store.getRun(run!.id)).toMatchObject({ status: 'completed' });
    expect(store.getRun(run!.id)!.error ?? null).toBeNull();
    await service.stop();
  });

  it('still stops a run that was awake for its whole limit', async () => {
    const { clock } = reportedSleep();
    const service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(agentWorkingFor(2_000) as never),
      config: CONFIG,
      wakeSettle: new WakeSettle(clock),
    });
    const run = await service.triggerManualRun(newTask(300).id);

    await vi.waitFor(() => expect(isTerminalRunStatus(store.getRun(run!.id)!.status)).toBe(true), {
      timeout: 4_000,
    });
    expect(store.getRun(run!.id)).toMatchObject({
      status: 'cancelled',
      error: expect.stringContaining('time limit'),
    });
    await service.stop();
  });
});

/** A clock and timers a test drives by hand; `sleep` fires overdue timers once. */
function handClock() {
  let now = Date.parse('2026-10-30T03:00:00Z');
  const timers = new Map<object, { at: number; fn: () => void; every: number | null }>();
  const add = (fn: () => void, ms: number, every: number | null) => {
    const handle = {};
    timers.set(handle, { at: now + ms, fn, every });
    return handle;
  };
  const fake: AwakeTimers = {
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: (h) => void timers.delete(h as object),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: (h) => void timers.delete(h as object),
  };
  const fireDue = () => {
    for (const [handle, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now || !timers.has(handle)) continue;
      if (timer.every === null) timers.delete(handle);
      else timer.at = now + timer.every;
      timer.fn();
    }
  };
  const clock = createAwakeClock({ now: () => now, timers: fake });
  return {
    clock,
    advance(ms: number) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 1_000);
        fireDue();
      }
    },
    sleep(ms: number) {
      now += ms;
      fireDue();
    },
  };
}

describe('a scheduled fire right after a wake', () => {
  it('runs at once when the computer has not slept', () => {
    const hand = handClock();
    const settle = new WakeSettle(hand.clock);
    const fire = vi.fn();
    settle.run(fire, 'nightly');
    expect(fire).toHaveBeenCalledOnce();
  });

  it('waits out a dark wake, and runs once the computer has stayed awake', () => {
    const hand = handClock();
    const settle = new WakeSettle(hand.clock);
    const fire = vi.fn();

    hand.advance(60_000);
    hand.sleep(6 * 60 * 60 * 1000); // asleep, then a dark wake
    settle.run(fire, 'nightly');
    hand.advance(30_000);
    expect(fire).not.toHaveBeenCalled();

    hand.sleep(60 * 60 * 1000); // back to sleep before the fire ran, then a full wake
    const fullWake = hand.clock.now();
    hand.advance(WAKE_SETTLE_MS - 1_000);
    expect(fire).not.toHaveBeenCalled();
    hand.advance(2_000);
    expect(fire).toHaveBeenCalledOnce();
    // Judged at the instant it runs, so a fire that waited hours is stale there.
    const firedAt = fire.mock.calls[0]![0] as Date;
    expect(firedAt.getTime()).toBe(fullWake + WAKE_SETTLE_MS);
  });

  it('drops a waiting fire when the scheduler stops', () => {
    const hand = handClock();
    const settle = new WakeSettle(hand.clock);
    const fire = vi.fn();
    hand.advance(60_000);
    hand.sleep(60 * 60 * 1000);
    settle.run(fire, 'nightly');
    settle.stop();
    hand.advance(WAKE_SETTLE_MS * 2);
    expect(fire).not.toHaveBeenCalled();
  });
});

const WAIT_WORDS = 'Waiting to start: every agent on this computer is busy.';
const WAIT = {
  type: 'system_status',
  data: { message: WAIT_WORDS, status: SLOT_WAIT_STATUS },
} as StreamEvent;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A turn that waits `waitMs` for a slot (saying so twice), then works `workMs`. */
function agentQueuedFor(waitMs: number, workMs: number, onWaiting: () => void = () => {}) {
  return {
    ...agentWorkingFor(0),
    sendMessage: async function* (): AsyncGenerator<StreamEvent> {
      yield WAIT;
      await pause(waitMs / 2);
      onWaiting();
      yield WAIT;
      await pause(waitMs / 2);
      yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
      await pause(workMs);
      yield { type: 'done', data: { sessionId: 's' } } as StreamEvent;
    },
  };
}

describe('a run queued behind a full computer (direct path, DOR-4576)', () => {
  it('still runs when it waited longer than its limit, and gets its full limit once started', async () => {
    let summaryWhileWaiting: string | null | undefined;
    // 1.8s in line under a 1.5s limit, then 300ms of work: inside the limit.
    const agent = agentQueuedFor(1_800, 300, () => {
      summaryWhileWaiting = store.getRun(run!.id)!.outputSummary;
    });
    const service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(agent as never),
      config: CONFIG,
    });
    const run = await service.triggerManualRun(newTask(1_500).id);

    await vi.waitFor(() => expect(isTerminalRunStatus(store.getRun(run!.id)!.status)).toBe(true), {
      timeout: 5_000,
    });
    expect(store.getRun(run!.id)).toMatchObject({ status: 'completed', outputSummary: 'working' });
    expect(store.getRun(run!.id)!.error ?? null).toBeNull();
    // While it waited, the row said so rather than looking stuck.
    expect(summaryWhileWaiting).toBe(WAIT_WORDS);
    await service.stop();
  });

  it('still stops a run that runs past its limit once started', async () => {
    const service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(agentQueuedFor(400, 2_000) as never),
      config: CONFIG,
    });
    const run = await service.triggerManualRun(newTask(300).id);

    await vi.waitFor(() => expect(isTerminalRunStatus(store.getRun(run!.id)!.status)).toBe(true), {
      timeout: 5_000,
    });
    expect(store.getRun(run!.id)).toMatchObject({
      status: 'cancelled',
      error: expect.stringContaining('time limit'),
    });
    await service.stop();
  });

  it('allows exactly the wait the runtime does before it refuses a turn', () => {
    // The pause cap the relay path uses must match the runtime's own wait.
    expect(RUN_START_WAIT_MS).toBe(SESSIONS.WARM_SLOT_WAIT_MS);
    expect(RUN_START_WAIT_MS).toBe(MAX_START_WAIT_MS);
  });

  it('never waits past the hard cap: its limit plus the longest wait to start', () => {
    const hand = handClock();
    const stop = runDeadline(hand.clock, 5 * 60_000, new AbortController().signal);
    // A runtime that says it is waiting and then never starts.
    stop.observe(WAIT);
    hand.advance(5 * 60_000 + RUN_START_WAIT_MS - 2_000);
    expect(stop.signal.aborted).toBe(false);
    hand.advance(4_000);
    expect(stop.timedOut()).toBe(true);
    stop.cancel();
  });
});
