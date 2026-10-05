/**
 * Late scheduled runs are honest, and a late occurrence is claimed once
 * (DOR-2718, spec `keep-awake` Part C).
 *
 * A sleeping computer is a paused event loop: croner's pending timer cannot
 * fire until the machine wakes, and then it fires ONE late run and drops the
 * other missed ticks. These cases reproduce that with REAL croner under fake
 * timers: `vi.setSystemTime` moves the wall clock without firing anything
 * (exactly what a wake does to a pending `setTimeout`), and the next
 * `advanceTimersByTimeAsync` lets croner's own timer fire, late, at the
 * instant the test chose. Croner is the subject, so it is never mocked.
 *
 * @module services/tasks/tests/late-runs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseDispatchLog, type Db } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import { initBoundary } from '../../../lib/boundary.js';
import {
  TaskSchedulerService,
  singleRuntimeSource,
  type SchedulerAgentManager,
} from '../task-scheduler-service.js';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';

vi.mock('../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn(() => false),
}));

/** The words a person reads on a run skipped for being too late. */
const STALE_SKIP_COPY = 'Skipped: this computer was asleep when it was due.';

/** Croner chunks every wait into timeouts of at most this long (`W` in its source). */
const CRONER_CHUNK_MS = 30_000;

function agent(): SchedulerAgentManager {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'ok' } } as StreamEvent;
    }),
    interruptQuery: vi.fn().mockResolvedValue(true),
    getInternalSessionId: vi.fn(() => undefined),
    acquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
  } as unknown as SchedulerAgentManager;
}

function taskInput(
  overrides: Partial<CreateTaskStoreInput> & { name: string }
): CreateTaskStoreInput {
  return {
    description: 'test',
    prompt: 'test',
    timezone: 'UTC',
    filePath: `/tmp/tasks/${overrides.name.toLowerCase().replace(/\s+/g, '-')}/SKILL.md`,
    ...overrides,
  };
}

/** Both instances believe they lead: the dual-leader handoff window ADR-285 backstops. */
const BOTH_LEAD = {
  tryAcquire: () => true,
  heartbeat: () => {},
  release: () => {},
  isLeaderNow: true,
};

describe('late scheduled runs (DOR-2718)', () => {
  let db: Db;
  let store: TaskStore;
  let mockAgent: SchedulerAgentManager;
  const services: TaskSchedulerService[] = [];

  function scheduler(): TaskSchedulerService {
    const service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(mockAgent),
      config: { maxConcurrentRuns: 5, retentionCount: 100, mayFire: true, firingReason: 'test' },
      leaderLock: BOTH_LEAD,
    });
    services.push(service);
    return service;
  }

  /**
   * Put the machine to sleep with croner's timer pending, and wake it so that
   * the timer fires at exactly `fireAt`. `remainingMs` is how long the pending
   * timeout still had to run when the machine slept.
   */
  async function sleepUntil(fireAt: string, remainingMs: number): Promise<void> {
    vi.setSystemTime(new Date(new Date(fireAt).getTime() - remainingMs));
    await vi.advanceTimersByTimeAsync(remainingMs);
  }

  beforeEach(async () => {
    db = createTestDb();
    store = new TaskStore(db);
    mockAgent = agent();
    await initBoundary('/');
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const service of services.splice(0)) await service.stop();
  });

  it('two processes firing one late occurrence across a minute boundary claim it once', async () => {
    // The regression (spec Part C). Two leaders share one database; the
    // machine wakes 21 minutes after a daily 09:00 occurrence, and the two
    // processes' croner timers fire 200 ms apart, straddling 09:21:00. Keyed
    // on the wall-clock minute they claimed 09:20 and 09:21 — two different
    // keys — and BOTH ran. Keyed on the occurrence they both claim 09:00.
    vi.useFakeTimers({ now: new Date('2026-10-05T08:00:00.000Z') });
    const task = store.createTask(taskInput({ name: 'Daily report', cron: '0 9 * * *' }));
    const first = scheduler();
    const second = scheduler();

    first.registerTask(task); // its timer: 30 s from 08:00:00.000
    await vi.advanceTimersByTimeAsync(200);
    second.registerTask(task); // its timer: 30 s from 08:00:00.200

    // `first` had 29.8 s left when the machine slept; `second` fires 200 ms later.
    await sleepUntil('2026-10-05T09:20:59.900Z', CRONER_CHUNK_MS - 200);
    await vi.advanceTimersByTimeAsync(200); // `second` fires at 09:21:00.100

    expect(store.listRuns({ taskId: task.id })).toHaveLength(1);
  });

  it('records which occurrence a late run was for, and how many it missed', async () => {
    // Asleep from 08:00 to 11:12 under an hourly schedule: 09:00 and 10:00
    // never fired, and 11:00 runs twelve minutes late.
    vi.useFakeTimers({ now: new Date('2026-10-05T08:00:00.000Z') });
    const task = store.createTask(taskInput({ name: 'Hourly', cron: '0 * * * *' }));
    scheduler().registerTask(task);

    await sleepUntil('2026-10-05T11:12:00.000Z', CRONER_CHUNK_MS);

    const runs = store.listRuns({ taskId: task.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).not.toBe('skipped');
    expect(runs[0]!.scheduledFor).toBe('2026-10-05T11:00:00.000Z');
    expect(runs[0]!.missedTicks).toBe(2);
    expect(runs[0]!.startedAt).toBe('2026-10-05T11:12:00.000Z');
    // The claim is keyed on the occurrence, not on the minute it fired in.
    const keys = db.select().from(pulseDispatchLog).all();
    expect(keys.map((k) => k.scheduledFireTime)).toEqual([Date.parse('2026-10-05T11:00:00Z')]);
  });

  it('skips a run too late to matter, on the record, without starting it', async () => {
    // 45 minutes past an hourly occurrence is past halfway to the next one.
    vi.useFakeTimers({ now: new Date('2026-10-05T08:00:00.000Z') });
    const task = store.createTask(taskInput({ name: 'Too late', cron: '0 * * * *' }));
    scheduler().registerTask(task);

    await sleepUntil('2026-10-05T11:45:00.000Z', CRONER_CHUNK_MS);

    const runs = store.listRuns({ taskId: task.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('skipped');
    expect(runs[0]!.error).toBe(STALE_SKIP_COPY);
    expect(runs[0]!.scheduledFor).toBe('2026-10-05T11:00:00.000Z');
    expect(runs[0]!.missedTicks).toBe(2);
    expect(mockAgent.sendMessage).not.toHaveBeenCalled();
  });

  it('a daily run woken 59 minutes late runs; 61 minutes late is skipped', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-05T08:00:00.000Z') });
    const runsLate = store.createTask(taskInput({ name: 'Fifty nine', cron: '0 9 * * *' }));
    const tooLate = store.createTask(taskInput({ name: 'Sixty one', cron: '0 10 * * *' }));
    const service = scheduler();
    service.registerTask(runsLate);
    service.registerTask(tooLate);

    await sleepUntil('2026-10-05T09:59:00.000Z', CRONER_CHUNK_MS);
    expect(store.listRuns({ taskId: runsLate.id })[0]!.status).not.toBe('skipped');

    await sleepUntil('2026-10-05T11:01:00.000Z', CRONER_CHUNK_MS);
    const [skipped] = store.listRuns({ taskId: tooLate.id });
    expect(skipped!.status).toBe('skipped');
    expect(skipped!.scheduledFor).toBe('2026-10-05T10:00:00.000Z');
  });

  it('an on-time run records its occurrence, nothing missed, and keys as it always did', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-05T08:59:45.000Z') });
    const task = store.createTask(taskInput({ name: 'On time', cron: '0 9 * * *' }));
    scheduler().registerTask(task);

    await vi.advanceTimersByTimeAsync(15_000);

    const [run] = store.listRuns({ taskId: task.id });
    expect(run!.scheduledFor).toBe('2026-10-05T09:00:00.000Z');
    expect(run!.missedTicks).toBe(0);
    const keys = db.select().from(pulseDispatchLog).all();
    expect(keys.map((k) => k.scheduledFireTime)).toEqual([Date.parse('2026-10-05T09:00:00Z')]);
  });

  it('counts missed ticks from the occurrence after the last fire, not from registration', async () => {
    // After a late fire, croner waits for the NEXT occurrence; an on-time fire
    // of it has missed nothing.
    vi.useFakeTimers({ now: new Date('2026-10-05T08:00:00.000Z') });
    const task = store.createTask(taskInput({ name: 'Recovers', cron: '0 * * * *' }));
    scheduler().registerTask(task);

    await sleepUntil('2026-10-05T11:12:00.000Z', CRONER_CHUNK_MS);
    await vi.advanceTimersByTimeAsync(48 * 60_000);

    const runs = store.listRuns({ taskId: task.id });
    const onTime = runs.find((r) => r.scheduledFor === '2026-10-05T12:00:00.000Z');
    expect(onTime).toBeDefined();
    expect(onTime!.missedTicks).toBe(0);
  });

  it('a manual run carries no occurrence', async () => {
    const task = store.createTask(taskInput({ name: 'By hand', cron: '0 * * * *' }));
    const run = await scheduler().triggerManualRun(task.id);
    expect(run!.scheduledFor).toBeNull();
    expect(run!.missedTicks).toBeNull();
  });
});
