import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TaskSchedulerService,
  scheduledTickKey,
  type SchedulerAgentManager,
} from '../task-scheduler-service.js';
import { buildTaskAppend } from '../task-append.js';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { StreamEvent, Task, TaskRun } from '@dorkos/shared/types';
import type { RelayCore } from '@dorkos/relay';
import type { MeshCore } from '@dorkos/mesh';
import type { ActivityService } from '../../activity/activity-service.js';
import type { TaskDispatchPayload } from '@dorkos/shared/relay-schemas';

vi.mock('../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn(() => false),
}));

import { isRelayEnabled } from '../../relay/relay-state.js';

function createMockAgentManager(): SchedulerAgentManager {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* () {
      // Default: no events (immediate completion)
    }),
    interruptQuery: vi.fn().mockResolvedValue(true),
  } as unknown as SchedulerAgentManager;
}

/**
 * A turn that emits one event and then parks forever — the shape of a run
 * blocked on a tool-approval prompt nobody will answer. It yields no further
 * events, so anything that only runs inside the consumer's loop body never runs
 * again.
 *
 * `parked` resolves once the consumer has asked for the event that will never
 * come. Tests must await it before stopping the run: an abort that lands while
 * the first event is still in flight is caught by the loop body and proves
 * nothing about a genuinely parked turn.
 */
function parkedTurn(): {
  impl: () => AsyncGenerator<StreamEvent>;
  parked: Promise<void>;
} {
  let signalParked!: () => void;
  const parked = new Promise<void>((resolve) => {
    signalParked = resolve;
  });
  const impl = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'starting' } };
    signalParked();
    // Never settles: the run is waiting on a person who never arrives.
    await new Promise(() => {});
  };
  return { impl, parked };
}

/**
 * A turn that ends normally, but whose LAST event lands in the same instant
 * something stops the run.
 *
 * This is the one window where "did a stop end this run?" and "is the signal
 * aborted?" give different answers, and it is not reachable with a plain
 * generator — the abort has to be queued between the final `next()` resolving
 * and the consumer's continuation running. A hand-rolled iterator is the only
 * way to put it exactly there, so the race is deterministic instead of a
 * coin-flip that reproduces once a fortnight.
 *
 * @param stopAtEnd - Called as the stream ends; queued so it lands after the
 *   final `next()` has already resolved `done`.
 */
function turnThatEndsAsItIsStopped(stopAtEnd: () => void): AsyncGenerator<StreamEvent> {
  let calls = 0;
  const iterator: AsyncIterator<StreamEvent> = {
    next(): Promise<IteratorResult<StreamEvent>> {
      calls++;
      if (calls === 1) {
        return Promise.resolve({
          done: false,
          value: { type: 'text_delta', data: { text: 'ok' } },
        });
      }
      queueMicrotask(stopAtEnd);
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    ...iterator,
  } as AsyncGenerator<StreamEvent>;
}

/** Build a minimal CreateTaskStoreInput with defaults for required fields. */
function taskInput(
  overrides: Partial<CreateTaskStoreInput> & { name: string }
): CreateTaskStoreInput {
  return {
    description: overrides.prompt ?? 'test',
    prompt: 'test',
    filePath: `/tmp/tasks/${overrides.name.toLowerCase().replace(/\s+/g, '-')}/SKILL.md`,
    ...overrides,
  };
}

const DEFAULT_CONFIG = {
  maxConcurrentRuns: 1,
  retentionCount: 100,
  mayFire: true,
  firingReason: 'test',
};

describe('TaskSchedulerService', () => {
  let store: TaskStore;
  let db: Db;
  let mockAgent: ReturnType<typeof createMockAgentManager>;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    mockAgent = createMockAgentManager();
  });

  describe('start()', () => {
    it('marks interrupted running runs as failed on startup', async () => {
      // Create a task + "running" run that simulates a crash
      const task = store.createTask(
        taskInput({ name: 'Crash', prompt: 'test', cron: '0 * * * *' })
      );
      store.createRun(task.id, 'scheduled');

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      const runs = store.listRuns();
      expect(runs[0].status).toBe('failed');
      expect(runs[0].error).toBe('Interrupted by server restart');

      await service.stop();
    });

    it('registers cron jobs for enabled active tasks', async () => {
      store.createTask(taskInput({ name: 'Active', prompt: 'test', cron: '0 * * * *' }));
      store.createTask(
        taskInput({ name: 'Disabled', prompt: 'test', cron: '0 * * * *', enabled: false })
      );

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      const tasks = store.getTasks();
      expect(service.isRegistered(tasks[0].id)).toBe(true);
      expect(service.isRegistered(tasks[1].id)).toBe(false);

      await service.stop();
    });

    // One unschedulable row used to be able to stop the server booting at all:
    // `index.ts` awaits start(), croner throws on a pattern it cannot read, and
    // the rejection ends in process.exit(1). A task file is a plain text file a
    // person edits, so this is a typo away at any time.
    it('boots past a task whose cron croner cannot read, and registers the rest', async () => {
      store.createTask(taskInput({ name: 'Broken', prompt: 'test', cron: 'banana' }));
      store.createTask(taskInput({ name: 'Fine', prompt: 'test', cron: '0 * * * *' }));

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await expect(service.start()).resolves.toBeUndefined();

      const [broken, fine] = store.getTasks();
      expect(service.isRegistered(broken!.id)).toBe(false);
      expect(service.isRegistered(fine!.id)).toBe(true);

      await service.stop();
    });

    // Croner reads a timezone lazily, so this one throws from a different place
    // than a bad pattern does — and the row reaches the scheduler the same way.
    it('boots past a task whose timezone croner cannot resolve', async () => {
      store.createTask(
        taskInput({ name: 'Off world', prompt: 'test', cron: '0 * * * *', timezone: 'Mars/Phobos' })
      );
      store.createTask(taskInput({ name: 'Fine', prompt: 'test', cron: '0 * * * *' }));

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await expect(service.start()).resolves.toBeUndefined();

      const [offWorld, fine] = store.getTasks();
      expect(service.isRegistered(offWorld!.id)).toBe(false);
      expect(service.isRegistered(fine!.id)).toBe(true);

      await service.stop();
    });

    it('is not started before start() runs, and is not started after stop()', async () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.isStarted).toBe(false);

      await service.start();
      expect(service.isStarted).toBe(true);

      await service.stop();
      expect(service.isStarted).toBe(false);
    });

    it('skips tasks with pending_approval status', async () => {
      const task = store.createTask(
        taskInput({ name: 'Pending', prompt: 'test', cron: '0 * * * *' })
      );
      store.updateTask(task.id, { status: 'pending_approval' });

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      expect(service.isRegistered(task.id)).toBe(false);

      await service.stop();
    });
  });

  describe('production gate (mayFire)', () => {
    it('suppresses scheduled firing when mayFire is false — no run is created', async () => {
      const task = store.createTask(
        taskInput({ name: 'Gated', prompt: 'test', cron: '0 * * * *' })
      );
      const service = new TaskSchedulerService(store, mockAgent, {
        ...DEFAULT_CONFIG,
        mayFire: false,
        firingReason: 'test: suppressed',
      });
      await service.start();

      // dispatch() is the scheduled-firing chokepoint; with mayFire=false it must no-op.
      await (service as unknown as { dispatch(t: typeof task): Promise<void> }).dispatch(task);

      expect(store.listRuns()).toHaveLength(0);
      // Display is unaffected — the cron is still registered and next-run resolves.
      expect(service.getNextRun(task.id)).not.toBeNull();

      await service.stop();
    });

    it('fires when mayFire is true — a scheduled run is created', async () => {
      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        yield { type: 'text_delta', data: { text: 'Done!' } };
      });
      const task = store.createTask(
        taskInput({ name: 'Allowed', prompt: 'test', cron: '0 * * * *' })
      );
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG); // mayFire: true

      await (service as unknown as { dispatch(t: typeof task): Promise<void> }).dispatch(task);

      expect(store.listRuns().length).toBeGreaterThan(0);

      await service.stop();
    });
  });

  describe('leader gate (ADR-285)', () => {
    const followerLock = {
      tryAcquire: () => false,
      heartbeat: () => {},
      release: () => {},
      isLeaderNow: false,
    };
    const leaderLock = {
      tryAcquire: () => true,
      heartbeat: () => {},
      release: () => {},
      isLeaderNow: true,
    };

    it('a follower does NOT fire scheduled dispatches', async () => {
      const task = store.createTask(
        taskInput({ name: 'Follower', prompt: 'test', cron: '0 * * * *' })
      );
      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: { ...DEFAULT_CONFIG },
        leaderLock: followerLock,
      });

      await (service as unknown as { dispatch(t: typeof task): Promise<void> }).dispatch(task);

      expect(store.listRuns()).toHaveLength(0);
      await service.stop();
    });

    it('the leader fires scheduled dispatches', async () => {
      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        yield { type: 'text_delta', data: { text: 'ok' } };
      });
      const task = store.createTask(
        taskInput({ name: 'Leader', prompt: 'test', cron: '0 * * * *' })
      );
      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: { ...DEFAULT_CONFIG },
        leaderLock,
      });

      await (service as unknown as { dispatch(t: typeof task): Promise<void> }).dispatch(task);

      expect(store.listRuns().length).toBeGreaterThan(0);
      await service.stop();
    });
  });

  describe('dispatch idempotency (ADR-285)', () => {
    const okAgent = () =>
      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        yield { type: 'text_delta', data: { text: 'ok' } };
      });
    type Dispatchable = {
      dispatch(t: ReturnType<TaskStore['createTask']>, when?: Date | null): Promise<void>;
    };

    it('dispatches a given scheduled tick at most once', async () => {
      okAgent();
      const task = store.createTask(taskInput({ name: 'Once', prompt: 'test', cron: '0 * * * *' }));
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const dispatch = (service as unknown as Dispatchable).dispatch.bind(service);
      const tick = new Date(1_700_000_000_000);

      await dispatch(task, tick);
      await dispatch(task, tick); // same tick — deduped

      expect(store.listRuns()).toHaveLength(1);
      await service.stop();
    });

    it('dispatches distinct ticks separately', async () => {
      okAgent();
      const task = store.createTask(
        taskInput({ name: 'Twice', prompt: 'test', cron: '0 * * * *' })
      );
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const dispatch = (service as unknown as Dispatchable).dispatch.bind(service);

      await dispatch(task, new Date(1_700_000_000_000));
      await dispatch(task, new Date(1_700_000_060_000));

      expect(store.listRuns()).toHaveLength(2);
      await service.stop();
    });

    it('manual runs are exempt from dispatch idempotency', async () => {
      okAgent();
      const task = store.createTask(
        taskInput({ name: 'Manual', prompt: 'test', cron: '0 * * * *' })
      );
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);

      await service.triggerManualRun(task.id);
      await service.triggerManualRun(task.id);

      expect(store.listRuns()).toHaveLength(2);
      await service.stop();
    });

    it('two leaders firing the same occurrence (ms apart) produce exactly one run', async () => {
      // The cross-process regression: both instances are leaders (the dual-leader
      // handoff window) sharing one DB, firing the SAME scheduled minute a few ms
      // apart. The schedule-floored key must collapse them to one claim -> one run.
      // (With a raw currentRun() key this asserts 2 and fails — the bug guard.)
      okAgent();
      const task = store.createTask(
        taskInput({ name: 'Shared', prompt: 'test', cron: '* * * * *' })
      );
      const bothLeader = {
        tryAcquire: () => true,
        heartbeat: () => {},
        release: () => {},
        isLeaderNow: true,
      };
      const s1 = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: { ...DEFAULT_CONFIG },
        leaderLock: bothLeader,
      });
      const s2 = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: { ...DEFAULT_CONFIG },
        leaderLock: bothLeader,
      });
      const minuteBoundary = 1_700_000_040_000; // a multiple of 60_000

      await (s1 as unknown as Dispatchable).dispatch(task, new Date(minuteBoundary + 2));
      await (s2 as unknown as Dispatchable).dispatch(task, new Date(minuteBoundary + 7));

      expect(store.listRuns()).toHaveLength(1);
      await s1.stop();
      await s2.stop();
    });
  });

  describe('scheduledTickKey', () => {
    it('floors two triggers in the same minute to one key (5-field cron)', () => {
      const a = scheduledTickKey('* * * * *', new Date(1_700_000_040_002));
      const b = scheduledTickKey('* * * * *', new Date(1_700_000_040_009));
      expect(a).toBe(b);
      expect(a).toBe(1_700_000_040_000);
    });

    it('distinguishes different scheduled minutes', () => {
      expect(scheduledTickKey('* * * * *', new Date(1_700_000_040_000))).not.toBe(
        scheduledTickKey('* * * * *', new Date(1_700_000_100_000))
      );
    });

    it('uses 1s resolution for a 6-field (seconds) cron', () => {
      const a = scheduledTickKey('*/30 * * * * *', new Date(1_700_000_040_300));
      const b = scheduledTickKey('*/30 * * * * *', new Date(1_700_000_040_800));
      expect(a).toBe(b);
      expect(a).toBe(1_700_000_040_000);
    });
  });

  describe('triggerManualRun()', () => {
    it('creates a run with manual trigger', async () => {
      const task = store.createTask(
        taskInput({ name: 'Manual', prompt: 'do stuff', cron: '0 * * * *' })
      );

      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        yield { type: 'text_delta', data: { text: 'Done!' } };
      });

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const run = await service.triggerManualRun(task.id);

      expect(run).not.toBeNull();
      expect(run!.trigger).toBe('manual');
      expect(run!.status).toBe('running');

      // Wait for async execution
      await new Promise((r) => setTimeout(r, 100));

      await service.stop();
    });

    it('passes systemPromptAppend with task context to sendMessage', async () => {
      const task = store.createTask(
        taskInput({
          name: 'Context Test',
          prompt: 'do stuff',
          cron: '0 * * * *',
        })
      );

      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        // no events
      });

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.triggerManualRun(task.id);

      // Wait for async execution to complete
      await new Promise((r) => setTimeout(r, 100));

      expect(mockAgent.sendMessage).toHaveBeenCalledOnce();
      const [, , opts] = vi.mocked(mockAgent.sendMessage).mock.calls[0];
      expect(opts?.systemPromptAppend).toBeDefined();
      expect(opts?.systemPromptAppend).toContain('TASK SCHEDULER CONTEXT');
      expect(opts?.systemPromptAppend).toContain('Context Test');

      await service.stop();
    });

    it('returns null for nonexistent task', async () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const run = await service.triggerManualRun('nonexistent');
      expect(run).toBeNull();
      await service.stop();
    });
  });

  describe('cancelRun()', () => {
    it('says not_found when no run has that id', async () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await expect(service.cancelRun('nonexistent')).resolves.toEqual({ state: 'not_found' });
    });
  });

  describe('interrupting a run in flight', () => {
    /** The interrupt hook, typed for assertions. */
    function interruptSpy(agent: SchedulerAgentManager) {
      return vi.mocked(agent.interruptQuery);
    }

    it('stops a parked run when maxRuntime expires', async () => {
      const turn = parkedTurn();
      vi.mocked(mockAgent.sendMessage).mockImplementation(turn.impl);
      const task = store.createTask(
        taskInput({ name: 'Parked', prompt: 'test', cron: '0 * * * *', maxRuntime: 50 })
      );

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const run = await service.triggerManualRun(task.id);
      await turn.parked;

      await vi.waitFor(
        () => {
          expect(store.getRun(run!.id)!.status).toBe('cancelled');
        },
        { timeout: 2000 }
      );

      // The runtime is told to stop, not merely marked stopped in the DB.
      expect(interruptSpy(mockAgent)).toHaveBeenCalledWith(run!.id);
      // A deadline reads differently from an operator cancel in the run record.
      expect(store.getRun(run!.id)!.error).toContain('time limit');
      // The concurrency slot is released, so the next tick can fire.
      expect(service.getActiveRunCount()).toBe(0);

      await service.stop();
    });

    it('cancelRun interrupts a parked run and finalizes it as cancelled', async () => {
      const turn = parkedTurn();
      vi.mocked(mockAgent.sendMessage).mockImplementation(turn.impl);
      const task = store.createTask(
        taskInput({ name: 'Cancelme', prompt: 'test', cron: '0 * * * *', maxRuntime: null })
      );

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const run = await service.triggerManualRun(task.id);

      await turn.parked;
      expect(service.getActiveRunCount()).toBe(1);
      await expect(service.cancelRun(run!.id)).resolves.toEqual({ state: 'stopping' });

      await vi.waitFor(
        () => {
          expect(store.getRun(run!.id)!.status).toBe('cancelled');
        },
        { timeout: 2000 }
      );

      expect(interruptSpy(mockAgent)).toHaveBeenCalledWith(run!.id);
      expect(store.getRun(run!.id)!.error).toBe('Run cancelled');
      expect(service.getActiveRunCount()).toBe(0);

      await service.stop();
    });

    it('records a run that FINISHED as completed, even when a stop lands in the same instant', async () => {
      // The stop lost, by a microtask. Reading `signal.aborted` after the fact
      // cannot tell that from a stop that won, so a run that finished its work
      // was filed as cancelled — with output, and with nothing interrupted.
      const task = store.createTask(
        taskInput({ name: 'PhotoFinish', prompt: 'test', cron: '0 * * * *', maxRuntime: null })
      );
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      // The session key IS the run id, so the turn can stop the very run it is
      // ending — at the instant it ends.
      vi.mocked(mockAgent.sendMessage).mockImplementation(((sessionId: string) =>
        turnThatEndsAsItIsStopped(
          () => void service.cancelRun(sessionId)
        )) as unknown as SchedulerAgentManager['sendMessage']);

      const run = await service.triggerManualRun(task.id);

      await vi.waitFor(() => {
        expect(store.getRun(run!.id)!.finishedAt).not.toBeNull();
      });

      expect(store.getRun(run!.id)!.status).toBe('completed');
      expect(store.getRun(run!.id)!.error).toBeNull();

      await service.stop();
    });

    it('leaves a normal run alone — it completes and is never interrupted', async () => {
      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        yield { type: 'text_delta', data: { text: 'all done' } };
      });
      const task = store.createTask(
        taskInput({ name: 'Healthy', prompt: 'test', cron: '0 * * * *', maxRuntime: 60_000 })
      );

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const run = await service.triggerManualRun(task.id);

      await vi.waitFor(() => {
        expect(store.getRun(run!.id)!.status).toBe('completed');
      });

      expect(interruptSpy(mockAgent)).not.toHaveBeenCalled();
      expect(store.getRun(run!.id)!.outputSummary).toBe('all done');

      await service.stop();
    });

    it('does not re-emit run_cancelled for an operator cancel, but does for a deadline', async () => {
      // The cancel route emits its own activity event when the operator asks;
      // a second one here would show the same cancel twice.
      const activityService = { emit: vi.fn() };
      const cancelTurn = parkedTurn();
      vi.mocked(mockAgent.sendMessage).mockImplementation(cancelTurn.impl);
      const task = store.createTask(
        taskInput({ name: 'Dedupe', prompt: 'test', cron: '0 * * * *', maxRuntime: null })
      );
      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        activityService: activityService as unknown as ActivityService,
      });

      const cancelled = await service.triggerManualRun(task.id);
      await cancelTurn.parked;
      await service.cancelRun(cancelled!.id);
      await vi.waitFor(() => {
        expect(store.getRun(cancelled!.id)!.status).toBe('cancelled');
      });
      expect(activityService.emit).not.toHaveBeenCalled();

      // A deadline has no route emit behind it, so it must still be reported.
      const timeoutTurn = parkedTurn();
      vi.mocked(mockAgent.sendMessage).mockImplementation(timeoutTurn.impl);
      const timedTask = store.createTask(
        taskInput({ name: 'Deadline', prompt: 'test', cron: '0 * * * *', maxRuntime: 50 })
      );
      const timedRun = await service.triggerManualRun(timedTask.id);
      await vi.waitFor(
        () => {
          expect(store.getRun(timedRun!.id)!.status).toBe('cancelled');
        },
        { timeout: 2000 }
      );
      expect(activityService.emit).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'tasks.run_cancelled' })
      );

      await service.stop();
    });

    it('survives an interrupt that fails — the run still finalizes', async () => {
      const turn = parkedTurn();
      vi.mocked(mockAgent.sendMessage).mockImplementation(turn.impl);
      vi.mocked(mockAgent.interruptQuery).mockRejectedValue(new Error('runtime is wedged'));
      const task = store.createTask(
        taskInput({ name: 'Wedged', prompt: 'test', cron: '0 * * * *', maxRuntime: 50 })
      );

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const run = await service.triggerManualRun(task.id);
      await turn.parked;

      // A rejected interrupt must not become an unhandled rejection, and must
      // not leave the run pinned to `running` holding a concurrency slot.
      await vi.waitFor(
        () => {
          expect(store.getRun(run!.id)!.status).toBe('cancelled');
        },
        { timeout: 2000 }
      );
      expect(service.getActiveRunCount()).toBe(0);

      await service.stop();
    });
  });

  describe('getActiveRunCount()', () => {
    it('returns 0 when no runs are active', () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.getActiveRunCount()).toBe(0);
    });
  });

  describe('the concurrency cap counts BOTH dispatch paths (DOR-1482)', () => {
    type Dispatchable = {
      dispatch(t: ReturnType<TaskStore['createTask']>, when?: Date | null): Promise<void>;
    };
    /** A relay that takes the dispatch and never reports an ending. */
    let mockRelay: { publish: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.mocked(isRelayEnabled).mockReturnValue(true);
      mockRelay = {
        publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      };
    });

    afterEach(() => {
      vi.mocked(isRelayEnabled).mockReturnValue(false);
    });

    function relayScheduler(maxConcurrentRuns = 1): TaskSchedulerService {
      return new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: { ...DEFAULT_CONFIG, maxConcurrentRuns },
        relay: mockRelay as unknown as RelayCore,
      });
    }

    it('a relay-dispatched run is counted as active', async () => {
      // It used to be invisible: only `executeRunDirect` recorded anything, so
      // with the relay enabled this number was a flat zero however many runs
      // were in flight.
      const task = store.createTask(taskInput({ name: 'Busy relay', cron: '0 * * * *' }));
      const service = relayScheduler();

      await service.triggerManualRun(task.id);

      expect(service.getActiveRunCount()).toBe(1);
      await service.stop();
    });

    it('a second tick at the cap is refused while a relay run is in flight', async () => {
      // The defect: with the relay enabled, `maxConcurrentRuns` never tripped,
      // so a slow hourly task could pile up unbounded concurrent agent turns.
      const first = store.createTask(taskInput({ name: 'First', cron: '0 * * * *' }));
      const second = store.createTask(taskInput({ name: 'Second', cron: '0 * * * *' }));
      const service = relayScheduler(1);

      await service.triggerManualRun(first.id); // takes the only slot
      await (service as unknown as Dispatchable).dispatch(second, new Date(1_700_000_040_000));

      // The second task was NOT published — it never ran.
      expect(mockRelay.publish).toHaveBeenCalledOnce();
      const [secondRun] = store.listRuns({ taskId: second.id });
      expect(secondRun.status).toBe('skipped');
      await service.stop();
    });

    it('a relay run that reaches a terminal status frees its slot', async () => {
      const first = store.createTask(taskInput({ name: 'Frees', cron: '0 * * * *' }));
      const second = store.createTask(taskInput({ name: 'Then runs', cron: '0 * * * *' }));
      const service = relayScheduler(1);

      const held = await service.triggerManualRun(first.id);
      expect(service.getActiveRunCount()).toBe(1);

      // The receiver finishes it — the row is the only thing that says so.
      store.updateRun(held!.id, { status: 'completed', finishedAt: new Date().toISOString() });
      expect(service.getActiveRunCount()).toBe(0);

      await (service as unknown as Dispatchable).dispatch(second, new Date(1_700_000_040_000));
      expect(mockRelay.publish).toHaveBeenCalledTimes(2);
      expect(store.listRuns({ taskId: second.id })[0].status).toBe('running');
      await service.stop();
    });

    it('shutdown asks the bus to stop the relay runs it cannot abort itself', async () => {
      const task = store.createTask(taskInput({ name: 'Left running', cron: '0 * * * *' }));
      const service = relayScheduler();
      const run = await service.triggerManualRun(task.id);

      await service.stop();

      const stop = mockRelay.publish.mock.calls.find(([subject]) =>
        String(subject).includes('cancel')
      );
      expect(stop, 'a stop request went out for the in-flight relay run').toBeDefined();
      expect(JSON.stringify(stop![1])).toContain(run!.id);
    });
  });

  describe('a tick dropped at the cap is recorded, not silently lost (DOR-1482)', () => {
    type Dispatchable = {
      dispatch(t: ReturnType<TaskStore['createTask']>, when?: Date | null): Promise<void>;
    };

    it('writes a skipped run saying why, at the time the schedule came round', async () => {
      const busy = store.createTask(taskInput({ name: 'Slow one', cron: '* * * * *' }));
      const waiting = store.createTask(taskInput({ name: 'Waiting', cron: '* * * * *' }));
      const { impl, parked } = parkedTurn();
      vi.mocked(mockAgent.sendMessage).mockImplementation(impl);

      const service = new TaskSchedulerService(store, mockAgent, {
        ...DEFAULT_CONFIG,
        maxConcurrentRuns: 1,
      });
      void service.triggerManualRun(busy.id);
      await parked;

      await (service as unknown as Dispatchable).dispatch(waiting, new Date(1_700_000_040_000));

      const [skipped] = store.listRuns({ taskId: waiting.id });
      expect(skipped.status).toBe('skipped');
      expect(skipped.error).toContain('limit');
      expect(skipped.finishedAt).not.toBeNull();
      // Nothing was started: the agent was never asked to run this one.
      expect(vi.mocked(mockAgent.sendMessage)).toHaveBeenCalledOnce();

      await service.stop();
    });

    it('claims the tick, so two processes at the cap record ONE skip', async () => {
      // Without the claim, every process that fired this occurrence wrote its
      // own skip — and, worse, an unclaimed tick could still be run by another
      // process after this one had decided not to.
      const busy = store.createTask(taskInput({ name: 'Occupier', cron: '* * * * *' }));
      const waiting = store.createTask(taskInput({ name: 'Contended', cron: '* * * * *' }));
      const { impl, parked } = parkedTurn();
      vi.mocked(mockAgent.sendMessage).mockImplementation(impl);

      const capped = { ...DEFAULT_CONFIG, maxConcurrentRuns: 1 };
      const bothLeader = {
        tryAcquire: () => true,
        heartbeat: () => {},
        release: () => {},
        isLeaderNow: true,
      };
      const s1 = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: capped,
        leaderLock: bothLeader,
      });
      const s2 = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: capped,
        leaderLock: bothLeader,
      });
      void s1.triggerManualRun(busy.id);
      await parked;

      const tick = new Date(1_700_000_040_000);
      await (s1 as unknown as Dispatchable).dispatch(waiting, tick);
      await (s2 as unknown as Dispatchable).dispatch(waiting, tick);

      expect(store.listRuns({ taskId: waiting.id })).toHaveLength(1);

      await s1.stop();
      await s2.stop();
    });
  });

  describe('retention runs on a timer, not only at startup (DOR-1482)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A run that is over — the only kind retention may ever delete. */
    function finishedRun(taskId: string): string {
      const run = store.createRun(taskId, 'scheduled');
      store.updateRun(run.id, { status: 'completed', finishedAt: new Date().toISOString() });
      return run.id;
    }

    it('prunes finished run history and the dispatch log every hour', async () => {
      vi.useFakeTimers();
      const task = store.createTask(taskInput({ name: 'Chatty', cron: '* * * * *' }));
      const service = new TaskSchedulerService(store, mockAgent, {
        ...DEFAULT_CONFIG,
        retentionCount: 2,
      });
      await service.start();

      // Four runs land AFTER boot — exactly what a per-minute task does to a
      // server that is never restarted.
      for (let i = 0; i < 4; i++) finishedRun(task.id);
      expect(store.listRuns({ taskId: task.id })).toHaveLength(4);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(store.listRuns({ taskId: task.id })).toHaveLength(2);
      await service.stop();
    });

    it('leaves a run that is still going, however far behind the window it is', async () => {
      // Retention on a timer meets a long run: a relay-dispatched hourly task
      // that takes 40 minutes is still `running` when the sweep comes round,
      // and a per-minute task can bury it under a hundred newer rows. Deleting
      // it would discard the outcome, silence the terminal hook, and hand back
      // the concurrency slot it is holding (DOR-1482 review).
      vi.useFakeTimers();
      const task = store.createTask(taskInput({ name: 'Slow', cron: '* * * * *' }));
      const service = new TaskSchedulerService(store, mockAgent, {
        ...DEFAULT_CONFIG,
        retentionCount: 2,
      });
      await service.start();

      const live = store.createRun(task.id, 'scheduled');
      for (let i = 0; i < 6; i++) finishedRun(task.id);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(store.getRun(live.id)).not.toBeNull();
      expect(store.getRun(live.id)!.status).toBe('running');
      // Its real ending still lands, and still counts.
      expect(store.updateRun(live.id, { status: 'completed' })!.status).toBe('completed');
      await service.stop();
    });

    it('stops pruning once the scheduler has stopped', async () => {
      vi.useFakeTimers();
      const task = store.createTask(taskInput({ name: 'Stopped', cron: '* * * * *' }));
      const service = new TaskSchedulerService(store, mockAgent, {
        ...DEFAULT_CONFIG,
        retentionCount: 1,
      });
      await service.start();
      await service.stop();

      finishedRun(task.id);
      finishedRun(task.id);
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

      expect(store.listRuns({ taskId: task.id })).toHaveLength(2);
    });
  });

  describe('crash recovery is the leader job alone (DOR-1482)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a promotion never ends the scheduled run this process is executing', async () => {
      // The scenario (DOR-1482 review): this process WAS the leader and is
      // running a scheduled task. It stalls past the lock's stale TTL — a closed
      // laptop is enough — so another process steals the lock; then it comes
      // back and is promoted again. The sweep that promotion triggers must not
      // fail the run this process still has an AbortController for.
      const task = store.createTask(taskInput({ name: 'Ours', cron: '0 * * * *' }));
      const orphan = store.createRun(task.id, 'scheduled');
      const { impl, parked } = parkedTurn();
      vi.mocked(mockAgent.sendMessage).mockImplementation(impl);

      // Leadership is scripted by the test: `heartbeat()` is where a real lock
      // re-reads the file and steps up or down, and these flips are what it
      // would have found.
      let leaderNow = true;
      const flakyLock = {
        tryAcquire: () => leaderNow,
        heartbeat: () => {},
        release: () => {},
        get isLeaderNow() {
          return leaderNow;
        },
      };
      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: { ...DEFAULT_CONFIG },
        leaderLock: flakyLock,
      });
      await service.start();
      // The boot sweep ended the orphan already; a fresh one stands in for what
      // the process that held the lock in between leaves behind.
      expect(store.getRun(orphan.id)!.status).toBe('failed');
      const strandedByTheOtherProcess = store.createRun(task.id, 'scheduled');

      // Our own scheduled run, in flight.
      void (
        service as unknown as {
          dispatch(t: typeof task, when?: Date | null): Promise<void>;
        }
      ).dispatch(task, new Date(1_700_000_040_000));
      await parked;
      expect(service.getActiveRunCount()).toBe(1);
      const mine = store
        .listRuns({ taskId: task.id })
        .find((run) => run.status === 'running' && run.id !== strandedByTheOtherProcess.id)!;

      // Lock stolen while we were stalled, then handed back.
      leaderNow = false;
      const beat = (service as unknown as { onHeartbeat(): void }).onHeartbeat.bind(service);
      beat();
      leaderNow = true;
      beat();

      // Ours survives — and the other process's stranded run is swept, so this
      // is not passing because the sweep did nothing.
      expect(store.getRun(mine.id)!.status).toBe('running');
      expect(store.getRun(strandedByTheOtherProcess.id)!.status).toBe('failed');

      await service.stop();
    });

    it('a follower boot leaves another process runs running', async () => {
      const task = store.createTask(taskInput({ name: 'Someone elses', cron: '0 * * * *' }));
      const live = store.createRun(task.id, 'scheduled');

      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: { ...DEFAULT_CONFIG },
        leaderLock: {
          tryAcquire: () => false,
          heartbeat: () => {},
          release: () => {},
          isLeaderNow: false,
        },
      });
      await service.start();

      expect(store.getRun(live.id)!.status).toBe('running');
      await service.stop();
    });
  });

  describe('getNextRun()', () => {
    it('returns null for unregistered task', () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.getNextRun('nonexistent')).toBeNull();
    });

    it('returns a date for registered task', async () => {
      const task = store.createTask(taskInput({ name: 'Next', prompt: 'test', cron: '0 * * * *' }));

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      const next = service.getNextRun(task.id);
      expect(next).toBeInstanceOf(Date);

      await service.stop();
    });
  });

  describe('previewNextRuns()', () => {
    it('reads a cron the scheduler has never registered (DOR-1394)', () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);

      const runs = service.previewNextRuns('0 3 * * *', 'UTC', 3);

      expect(runs).toHaveLength(3);
      // Daily at 03:00 UTC, in order, one day apart.
      for (const run of runs) expect(run).toMatch(/T03:00:00\.000Z$/);
      const gaps = runs.slice(1).map((r, i) => Date.parse(r) - Date.parse(runs[i]!));
      expect(gaps).toEqual([86_400_000, 86_400_000]);
      expect(Date.parse(runs[0]!)).toBeGreaterThan(Date.now());
    });

    it('honours the timezone, so the same expression means different instants', () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);

      const utc = service.previewNextRuns('0 3 * * *', 'UTC', 1);
      const tokyo = service.previewNextRuns('0 3 * * *', 'Asia/Tokyo', 1);

      // 03:00 in Tokyo is 18:00 UTC the day before — if the timezone were
      // ignored, both would land on the same instant and this would be equal.
      expect(tokyo[0]).toMatch(/T18:00:00\.000Z$/);
      expect(tokyo[0]).not.toBe(utc[0]);
    });

    it('treats a missing timezone as UTC', () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.previewNextRuns('0 3 * * *', null, 1)).toEqual(
        service.previewNextRuns('0 3 * * *', 'UTC', 1)
      );
    });

    it('returns nothing for a cron it cannot read, rather than throwing', () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);

      // An agent writes these. A proposal with a broken cron still has to be
      // readable — and rejectable — by the person it is waiting on.
      for (const cron of ['not a cron', '99 99 99 99 99', '* * *', '']) {
        expect(service.previewNextRuns(cron, 'UTC', 3), `cron ${cron}`).toEqual([]);
      }
      expect(service.previewNextRuns('0 3 * * *', 'Mars/Olympus_Mons', 3)).toEqual([]);
      expect(service.previewNextRuns(null, 'UTC', 3)).toEqual([]);
      expect(service.previewNextRuns(undefined, 'UTC', 3)).toEqual([]);
    });

    it('returns nothing when asked for nothing', () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.previewNextRuns('0 3 * * *', 'UTC', 0)).toEqual([]);
      expect(service.previewNextRuns('0 3 * * *', 'UTC', -1)).toEqual([]);
    });

    it('schedules nothing — reading a cron must not arm it', async () => {
      const task = store.createTask(
        taskInput({ name: 'Parked', prompt: 'test', cron: '* * * * *' })
      );
      store.updateTask(task.id, { status: 'pending_approval' });
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      expect(service.previewNextRuns(task.cron, task.timezone, 3)).toHaveLength(3);

      expect(service.isRegistered(task.id)).toBe(false);
      expect(service.getNextRun(task.id)).toBeNull();

      await service.stop();
    });
  });

  describe('registerTask / unregisterTask', () => {
    it('can register and unregister a task', () => {
      const task = store.createTask(taskInput({ name: 'Reg', prompt: 'test', cron: '0 * * * *' }));

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      service.registerTask(task);
      expect(service.isRegistered(task.id)).toBe(true);

      service.unregisterTask(task.id);
      expect(service.isRegistered(task.id)).toBe(false);
    });

    it('replaces existing cron job on re-register', () => {
      const task = store.createTask(
        taskInput({ name: 'Re-reg', prompt: 'test', cron: '0 * * * *' })
      );

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      service.registerTask(task);
      service.registerTask(task); // Should not throw
      expect(service.isRegistered(task.id)).toBe(true);
    });

    // `registerTask` is reachable from a file somebody hand-edited, so it has to
    // answer rather than throw: the caller is a watcher event or a reconciler
    // pass, and neither has anywhere to put an exception.
    it('refuses a schedule croner cannot read, and says so instead of throwing', () => {
      const task = store.createTask(taskInput({ name: 'Broken', prompt: 'test', cron: 'banana' }));

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.registerTask(task)).toBe(false);
      expect(service.isRegistered(task.id)).toBe(false);
    });

    it('reports an on-demand task as unregistered rather than scheduled', () => {
      const task = store.createTask(taskInput({ name: 'On demand', prompt: 'test' }));

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.registerTask(task)).toBe(false);
      expect(service.isRegistered(task.id)).toBe(false);
    });

    // A pattern that parses but never matches is a REGISTERED job, not a refused
    // one. `apps/e2e` calls this expression `NEVER_FIRES_CRON` and seeds its task
    // fixtures with it precisely because it renders as a live, enabled schedule
    // while being unable to spawn a (real, billed) agent on that suite's leg.
    it('registers a schedule that never comes round, and never fires it', async () => {
      const task = store.createTask(
        taskInput({ name: 'Manual only', prompt: 'test', cron: '0 0 31 2 *', timezone: 'UTC' })
      );

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.registerTask(task)).toBe(true);
      expect(service.isRegistered(task.id)).toBe(true);
      // Held by croner with no occurrence to wait for — the honest answer to
      // "when does this run?" is nothing, not an error.
      expect(service.getNextRun(task.id)).toBeNull();

      // Nothing dispatches: no run row, and the agent was never asked to work.
      expect(store.listRuns()).toHaveLength(0);
      expect(mockAgent.ensureSession).not.toHaveBeenCalled();
      expect(mockAgent.sendMessage).not.toHaveBeenCalled();

      await service.stop();
    });

    // A task edited from a good cron to a bad one must lose its old job, not
    // keep firing on the schedule nobody asked for any more.
    it('drops the old job when a re-register is refused', () => {
      const task = store.createTask(
        taskInput({ name: 'Drifts', prompt: 'test', cron: '0 * * * *' })
      );

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      service.registerTask(task);
      expect(service.registerTask({ ...task, cron: 'banana' })).toBe(false);
      expect(service.isRegistered(task.id)).toBe(false);
    });
  });

  describe('executeRunViaRelay (via triggerManualRun)', () => {
    let mockRelay: { publish: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.mocked(isRelayEnabled).mockReturnValue(true);
      mockRelay = {
        publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      };
    });

    afterEach(() => {
      vi.mocked(isRelayEnabled).mockReturnValue(false);
    });

    it('publishes envelope with correct subject relay.system.tasks.{taskId}', async () => {
      const task = store.createTask(
        taskInput({
          name: 'Relay Test',
          prompt: 'do relay stuff',
          cron: '0 * * * *',
        })
      );

      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      expect(mockRelay.publish).toHaveBeenCalledOnce();
      const [subject] = mockRelay.publish.mock.calls[0];
      expect(subject).toBe(`relay.system.tasks.${task.id}`);

      await service.stop();
    });

    it('publishes TaskDispatchPayload with all expected fields', async () => {
      const task = store.createTask(
        taskInput({
          name: 'Payload Test',
          prompt: 'run this task',
          cron: '30 2 * * *',
          permissionMode: 'acceptEdits',
        })
      );

      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      const [, payload, options] = mockRelay.publish.mock.calls[0];
      const dispatch = payload as TaskDispatchPayload;

      expect(dispatch.type).toBe('task_dispatch');
      expect(dispatch.taskId).toBe(task.id);
      expect(dispatch.runId).toEqual(expect.any(String));
      expect(dispatch.prompt).toBe('run this task');
      expect(dispatch.cwd).toEqual(expect.any(String));
      expect(dispatch.permissionMode).toBe('acceptEdits');
      expect(dispatch.taskName).toBe('Payload Test');
      expect(dispatch.cron).toBe('30 2 * * *');
      expect(dispatch.trigger).toBe('manual');

      // Verify publish options
      expect(options.from).toBe('relay.system.tasks.scheduler');
      expect(options.replyTo).toBe(`relay.system.tasks.${task.id}.response`);
      expect(options.budget.maxHops).toBe(3);
      expect(options.budget.callBudgetRemaining).toBe(5);

      await service.stop();
    });

    it('marks run as failed when deliveredTo is 0', async () => {
      mockRelay.publish.mockResolvedValue({ messageId: 'msg-2', deliveredTo: 0 });

      const task = store.createTask(
        taskInput({
          name: 'No Receiver',
          prompt: 'orphan task',
          cron: '0 * * * *',
        })
      );

      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      const run = await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      const updatedRun = store.listRuns({ taskId: task.id }).find((r) => r.id === run!.id);
      expect(updatedRun?.status).toBe('failed');
      expect(updatedRun?.error).toBe('No receiver for task dispatch');

      await service.stop();
    });

    it('marks run as running on successful delivery', async () => {
      mockRelay.publish.mockResolvedValue({ messageId: 'msg-3', deliveredTo: 2 });

      const task = store.createTask(
        taskInput({
          name: 'Success Delivery',
          prompt: 'delivered task',
          cron: '0 * * * *',
        })
      );

      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      const run = await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      const updatedRun = store.listRuns({ taskId: task.id }).find((r) => r.id === run!.id);
      expect(updatedRun?.status).toBe('running');

      await service.stop();
    });

    it('DOR-248: a terminal status the handler already wrote survives the post-publish "running" write', async () => {
      // In-process relay delivery is synchronous: the task handler can run the
      // agent turn to completion and write 'completed' to the store BEFORE
      // relay.publish() resolves here. Simulate that by having the mocked
      // publish() itself perform the handler's terminal write before
      // resolving — reproducing the exact race from the DOR-235 smoke test.
      mockRelay.publish.mockImplementation(
        async (_subject: string, payload: TaskDispatchPayload) => {
          store.updateRun(payload.runId, {
            status: 'completed',
            finishedAt: '2026-07-10T02:44:10.310Z',
            durationMs: 10_307,
            outputSummary: 'ok',
            sessionId: payload.runId,
          });
          return { messageId: 'msg-race', deliveredTo: 1 };
        }
      );

      const task = store.createTask(
        taskInput({ name: 'Synchronous Race', prompt: 'reply with exactly: ok', cron: '0 * * * *' })
      );

      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      const run = await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      const updatedRun = store.getRun(run!.id);
      expect(updatedRun?.status).toBe('completed');
      expect(updatedRun?.finishedAt).toBe('2026-07-10T02:44:10.310Z');
      expect(updatedRun?.durationMs).toBe(10_307);
      expect(updatedRun?.outputSummary).toBe('ok');

      await service.stop();
    });

    it('sets budget TTL based on task.maxRuntime', async () => {
      const task = store.createTask(
        taskInput({
          name: 'TTL Test',
          prompt: 'timed task',
          cron: '0 * * * *',
          maxRuntime: 600_000, // 10 minutes
        })
      );

      const now = Date.now();
      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      const [, , options] = mockRelay.publish.mock.calls[0];
      // TTL should be roughly now + 600_000 (10 minutes)
      expect(options.budget.ttl).toBeGreaterThanOrEqual(now + 600_000 - 1000);
      expect(options.budget.ttl).toBeLessThanOrEqual(now + 600_000 + 5000);

      await service.stop();
    });

    it('uses default TTL of 1 hour when maxRuntime is null', async () => {
      const task = store.createTask(
        taskInput({
          name: 'Default TTL',
          prompt: 'no timeout task',
          cron: '0 * * * *',
        })
      );

      const now = Date.now();
      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });

      await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      const [, , options] = mockRelay.publish.mock.calls[0];
      // Default TTL: 3_600_000 (1 hour)
      expect(options.budget.ttl).toBeGreaterThanOrEqual(now + 3_600_000 - 1000);
      expect(options.budget.ttl).toBeLessThanOrEqual(now + 3_600_000 + 5000);

      await service.stop();
    });

    it('does not report a run the handler already finished as a delivery failure', async () => {
      // The adapter answers `success: false` for a run it stopped on a
      // deadline, and in-process delivery means that has already happened by
      // the time publish() resolves. Reading that as "nobody was listening"
      // used to put a `tasks.run_failed` event in the activity feed for a run
      // whose own record says cancelled.
      const activityService = { emit: vi.fn() };
      mockRelay.publish.mockImplementation(
        async (_subject: string, payload: TaskDispatchPayload) => {
          store.updateRun(payload.runId, {
            status: 'cancelled',
            finishedAt: new Date().toISOString(),
            error: 'Run cancelled',
          });
          return { messageId: 'msg-stopped', deliveredTo: 0 };
        }
      );

      const task = store.createTask(
        taskInput({ name: 'Stopped Mid-Flight', prompt: 'p', cron: '0 * * * *' })
      );
      const service = new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
        activityService: activityService as unknown as ActivityService,
      });

      const run = await service.triggerManualRun(task.id);
      await new Promise((r) => setTimeout(r, 100));

      expect(store.getRun(run!.id)!.status).toBe('cancelled');
      expect(activityService.emit).not.toHaveBeenCalled();

      await service.stop();
    });
  });

  describe('cancelRun() for a relay-dispatched run', () => {
    let mockRelay: { publish: ReturnType<typeof vi.fn> };

    /** A task with one run the relay is carrying (status `running`). */
    function relayRun(name: string) {
      const task = store.createTask(taskInput({ name, prompt: 'p', cron: '0 * * * *' }));
      return store.createRun(task.id, 'scheduled');
    }

    function schedulerWithRelay() {
      return new TaskSchedulerService({
        store,
        agentManager: mockAgent,
        config: DEFAULT_CONFIG,
        relay: mockRelay as unknown as RelayCore,
      });
    }

    beforeEach(() => {
      vi.mocked(isRelayEnabled).mockReturnValue(true);
      mockRelay = {
        publish: vi.fn().mockResolvedValue({ messageId: 'cancel-1', deliveredTo: 1 }),
      };
    });

    afterEach(() => {
      vi.mocked(isRelayEnabled).mockReturnValue(false);
    });

    it('sends the stop over the bus, addressed to the run', async () => {
      const run = relayRun('Relay Cancel');
      const service = schedulerWithRelay();

      await expect(service.cancelRun(run.id)).resolves.toEqual({ state: 'stopping' });

      const [subject, payload, options] = mockRelay.publish.mock.calls[0];
      expect(subject).toBe(`relay.control.task-cancel.${run.id}`);
      expect(payload).toEqual({ type: 'task_cancel', runId: run.id });
      expect(options.from).toBe('relay.system.tasks.scheduler');
      expect(options.budget.maxHops).toBe(1);
      // Short-lived on purpose: a stop replayed to a late subscriber names a
      // run that has long since ended.
      expect(options.budget.ttl).toBeLessThanOrEqual(Date.now() + 30_000);

      await service.stop();
    });

    it('reports unconfirmed — and leaves the run alone — when nothing takes it', async () => {
      mockRelay.publish.mockResolvedValue({ messageId: 'cancel-2', deliveredTo: 0 });
      const run = relayRun('Nobody Home');
      const service = schedulerWithRelay();

      const outcome = await service.cancelRun(run.id);

      expect(outcome.state).toBe('unconfirmed');
      expect(store.getRun(run.id)!.status).toBe('running');

      await service.stop();
    });

    it('reports already_finished when the run ends while the stop is in flight', async () => {
      const run = relayRun('Finished In Flight');
      mockRelay.publish.mockImplementation(async () => {
        store.updateRun(run.id, {
          status: 'completed',
          finishedAt: new Date().toISOString(),
        });
        return { messageId: 'cancel-3', deliveredTo: 0 };
      });
      const service = schedulerWithRelay();

      await expect(service.cancelRun(run.id)).resolves.toEqual({ state: 'already_finished' });
      // Exactly one terminal state, and it is the one the run actually reached.
      expect(store.getRun(run.id)!.status).toBe('completed');

      await service.stop();
    });

    it('is a no-op on a run that has already finished', async () => {
      const run = relayRun('Already Done');
      store.updateRun(run.id, { status: 'completed', finishedAt: new Date().toISOString() });
      const service = schedulerWithRelay();

      await expect(service.cancelRun(run.id)).resolves.toEqual({ state: 'already_finished' });
      expect(mockRelay.publish).not.toHaveBeenCalled();

      await service.stop();
    });

    it('names the rate limit rather than blaming a silent runner', async () => {
      // A refused publish and an unanswered one both come back as zero. The
      // scheduler shares one principal across every task, so hitting the bus's
      // per-sender limit is realistic — and "nothing picked it up" would send
      // somebody hunting a runner that is fine.
      mockRelay.publish.mockResolvedValue({
        messageId: 'cancel-rl',
        deliveredTo: 0,
        rejected: [{ endpointHash: '*', reason: 'rate_limited' }],
      });
      const run = relayRun('Rate Limited');
      const service = schedulerWithRelay();

      const outcome = await service.cancelRun(run.id);

      expect(outcome.state).toBe('unconfirmed');
      expect(outcome).toMatchObject({ reason: expect.stringContaining('rate-limiting') });
      expect(outcome).not.toMatchObject({ reason: expect.stringContaining('Nothing picked up') });

      await service.stop();
    });

    it('says so when the stop cannot even be sent', async () => {
      mockRelay.publish.mockRejectedValue(new Error('Access denied'));
      const run = relayRun('Refused Publish');
      const service = schedulerWithRelay();

      const outcome = await service.cancelRun(run.id);

      // Not a 500 with a stack trace: the person pressing Stop needs to know
      // the run may still be going, which is the same news either way.
      expect(outcome).toEqual({
        state: 'unconfirmed',
        reason: expect.stringContaining('Access denied'),
      });

      await service.stop();
    });

    it('says so when there is no bus to carry the stop', async () => {
      const run = relayRun('No Bus');
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);

      const outcome = await service.cancelRun(run.id);

      expect(outcome.state).toBe('unconfirmed');

      await service.stop();
    });
  });
});

/** Create a minimal MeshCore mock with getProjectPath. */
function createMockMeshCore(pathMap: Record<string, string | undefined> = {}): MeshCore {
  return {
    getProjectPath: vi.fn((agentId: string) => pathMap[agentId]),
  } as unknown as MeshCore;
}

/** Build a minimal CreateTaskStoreInput for the CWD resolution tests. */
function cwdTaskInput(
  overrides: Partial<import('../task-store.js').CreateTaskStoreInput> & { name: string }
): import('../task-store.js').CreateTaskStoreInput {
  return {
    description: overrides.prompt ?? 'test',
    prompt: 'test',
    filePath: `/tmp/tasks/${overrides.name.toLowerCase().replace(/\s+/g, '-')}/SKILL.md`,
    ...overrides,
  };
}

describe('agent CWD resolution (via triggerManualRun)', () => {
  let store: TaskStore;
  let db: Db;
  let mockAgent: ReturnType<typeof createMockAgentManager>;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    mockAgent = createMockAgentManager();
    vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
      // no events
    });
  });

  it('records failed run when agent not found in registry', async () => {
    const task = store.createTask(
      cwdTaskInput({
        name: 'Agent CWD Test',
        prompt: 'test',
        cron: '0 * * * *',
        agentId: 'missing-agent',
      })
    );

    const mockMesh = createMockMeshCore({});
    const service = new TaskSchedulerService({
      store,
      agentManager: mockAgent,
      config: {
        maxConcurrentRuns: 1,
        retentionCount: 100,
        mayFire: true,
        firingReason: 'test',
      },
      meshCore: mockMesh,
    });

    const run = await service.triggerManualRun(task.id);
    await new Promise((r) => setTimeout(r, 100));

    const updatedRun = store.getRun(run!.id);
    expect(updatedRun!.status).toBe('failed');
    expect(updatedRun!.error).toContain('not found in registry');

    await service.stop();
  });

  it('uses agent projectPath as CWD when agentId is set', async () => {
    const task = store.createTask(
      cwdTaskInput({
        name: 'Agent CWD Resolve',
        prompt: 'test',
        cron: '0 * * * *',
        agentId: 'agent-123',
      })
    );

    const mockMesh = createMockMeshCore({ 'agent-123': '/projects/agent-dir' });
    const service = new TaskSchedulerService({
      store,
      agentManager: mockAgent,
      config: {
        maxConcurrentRuns: 1,
        retentionCount: 100,
        mayFire: true,
        firingReason: 'test',
      },
      meshCore: mockMesh,
    });

    await service.triggerManualRun(task.id);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockAgent.ensureSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: '/projects/agent-dir' })
    );
    // A scheduled run is UNATTENDED, and the runtime reads that: an unanswered
    // prompt is refused at the ten-minute countdown instead of waiting four
    // hours for somebody who is not coming (spec `ask-parks-on-timeout` §7).
    expect(mockAgent.ensureSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ unattended: true })
    );
    expect(mockAgent.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'test',
      expect.objectContaining({ cwd: '/projects/agent-dir' })
    );

    await service.stop();
  });

  it('falls back to process.cwd() when no agentId', async () => {
    store.createTask(
      cwdTaskInput({
        name: 'CWD Fallback',
        prompt: 'test',
        cron: '0 * * * *',
      })
    );

    const tasks = store.getTasks();
    const service = new TaskSchedulerService({
      store,
      agentManager: mockAgent,
      config: {
        maxConcurrentRuns: 1,
        retentionCount: 100,
        mayFire: true,
        firingReason: 'test',
      },
      meshCore: null,
    });

    await service.triggerManualRun(tasks[0].id);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockAgent.ensureSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: process.cwd() })
    );

    await service.stop();
  });

  it('falls back to process.cwd() when meshCore is null even with agentId', async () => {
    store.createTask(
      cwdTaskInput({
        name: 'No Mesh',
        prompt: 'test',
        cron: '0 * * * *',
        agentId: 'some-agent',
      })
    );

    const tasks = store.getTasks();
    const service = new TaskSchedulerService({
      store,
      agentManager: mockAgent,
      config: {
        maxConcurrentRuns: 1,
        retentionCount: 100,
        mayFire: true,
        firingReason: 'test',
      },
      meshCore: null,
    });

    await service.triggerManualRun(tasks[0].id);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockAgent.ensureSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: process.cwd() })
    );

    await service.stop();
  });
});

describe('buildTaskAppend', () => {
  it('produces system prompt with task info', () => {
    const task: Task = {
      id: 'task-1',
      name: 'Daily Cleanup',
      displayName: null,
      description: 'Clean temp files',
      prompt: 'Clean temp files',
      cron: '0 2 * * *',
      timezone: null,
      agentId: null,
      enabled: true,
      maxRuntime: null,
      permissionMode: 'acceptEdits',
      status: 'active',
      filePath: '/tmp/tasks/daily-cleanup/SKILL.md',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      reason: null,
      proposedBySessionId: null,
      proposedByAgentPath: null,
      proposedByName: null,
      origin: null,
      nextRun: null,
      nextRuns: [],
    };

    const run: TaskRun = {
      id: 'run-1',
      scheduleId: 'task-1',
      status: 'running',
      startedAt: '2026-01-01T02:00:00Z',
      finishedAt: null,
      durationMs: null,
      outputSummary: null,
      error: null,
      sessionId: null,
      trigger: 'scheduled',
      createdAt: '2026-01-01T02:00:00Z',
    };

    const result = buildTaskAppend(task, run);
    expect(result).toContain('TASK SCHEDULER CONTEXT');
    expect(result).toContain('Daily Cleanup');
    expect(result).toContain('0 2 * * *');
    expect(result).toContain('run-1');
    expect(result).toContain('scheduled');
    expect(result).toContain('unattended');
  });
});
