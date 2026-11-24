import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { RequiredSessionIdentityError } from '../../../../lib/replay/required-session-identity-error.js';
import { onRequiredSessionRekey } from '../../../session/turn-identity/durable-rekey.js';
import {
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
} from '../../../session/session-state-projector.js';
import { TaskSchedulerService, singleRuntimeSource } from '../../task-scheduler-service.js';
import type { SchedulerAgentManager, SchedulerDeps } from '../../task-scheduler-service.js';
import { agentApprovalBindingOf } from '../../agent-mode/agent-mode-binding.js';
import { TaskStore } from '../../task-store.js';
import { isTerminalRunStatus } from '../../lifecycle/run-statuses.js';
import {
  parkedTurn,
  taskInput,
  DEFAULT_CONFIG,
  ON_TIME_HOURLY,
  freshHarness,
  LEADER_LOCK,
  FOLLOWER_LOCK,
  meshAt,
} from './task-scheduler.fixtures.js';
import type { Dispatchable } from './task-scheduler.fixtures.js';

describe('TaskSchedulerService — registering, firing and recovering', () => {
  let store: TaskStore;
  let mockAgent: SchedulerAgentManager;

  beforeEach(async () => {
    ({ store, mockAgent } = await freshHarness());
  });

  /** A scheduler over the mock agent, with optional extra options. */
  function scheduler(extra: Partial<SchedulerDeps> = {}): TaskSchedulerService {
    return new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(mockAgent),
      config: { ...DEFAULT_CONFIG },
      ...extra,
    });
  }

  /** The scheduler's private cron-fire chokepoint. */
  const fire = (
    service: TaskSchedulerService,
    task: ReturnType<TaskStore['createTask']>,
    when = ON_TIME_HOURLY
  ) => (service as unknown as Dispatchable).dispatch(task, when);

  describe('start() and registerTask()', () => {
    it('fails interrupted runs, and registers only enabled, approved tasks', async () => {
      const crashed = store.createTask(taskInput({ name: 'Crash', cron: '0 * * * *' }));
      store.createRun(crashed.id, 'scheduled');
      const disabled = store.createTask(
        taskInput({ name: 'Off', cron: '0 * * * *', enabled: false })
      );
      const pending = store.createTask(taskInput({ name: 'Pending', cron: '0 * * * *' }));
      store.updateTask(pending.id, { status: 'pending_approval' });

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await service.start();

      expect(store.listRuns()[0]).toMatchObject({
        status: 'failed',
        error: 'Interrupted by server restart',
      });
      expect(service.isRegistered(crashed.id)).toBe(true);
      expect(service.isRegistered(disabled.id)).toBe(false);
      expect(service.isRegistered(pending.id)).toBe(false);
      await service.stop();
    });

    // One unschedulable row used to stop the server booting: `index.ts` awaits
    // start(), croner throws, and the rejection ends in process.exit(1). Croner
    // reads a timezone lazily, so that throws from a different place.
    it('boots past a cron or timezone croner cannot read, and registers the rest', async () => {
      const broken = store.createTask(taskInput({ name: 'Broken', cron: 'banana' }));
      const offWorld = store.createTask(
        taskInput({ name: 'Off world', cron: '0 * * * *', timezone: 'Mars/Phobos' })
      );
      const fine = store.createTask(taskInput({ name: 'Fine', cron: '0 * * * *' }));

      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      await expect(service.start()).resolves.toBeUndefined();

      expect(service.isRegistered(broken.id)).toBe(false);
      expect(service.isRegistered(offWorld.id)).toBe(false);
      expect(service.isRegistered(fine.id)).toBe(true);
      await service.stop();
    });

    // A task edited from a good cron to a bad one must lose its old job, and
    // the refusal is an answer, not a throw: the caller is a watcher event.
    it('drops the old job when a re-register is refused, and unregisters on request', () => {
      const task = store.createTask(taskInput({ name: 'Drifts', cron: '0 * * * *' }));
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);

      expect(service.registerTask(task)).toBe(true);
      expect(service.registerTask({ ...task, cron: 'banana' })).toBe(false);
      expect(service.isRegistered(task.id)).toBe(false);

      service.registerTask(task);
      service.unregisterTask(task.id);
      expect(service.isRegistered(task.id)).toBe(false);
    });

    // `apps/e2e` seeds its tasks with this NEVER_FIRES_CRON because it renders
    // as a live schedule while being unable to spawn a (billed) agent.
    it('registers a schedule that never comes round, and never fires it', async () => {
      const task = store.createTask(
        taskInput({ name: 'Manual only', cron: '0 0 31 2 *', timezone: 'UTC' })
      );
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);

      expect(service.registerTask(task)).toBe(true);
      expect(service.getNextRun(task.id)).toBeNull();
      expect(store.listRuns()).toHaveLength(0);
      expect(mockAgent.sendMessage).not.toHaveBeenCalled();
      await service.stop();
    });
  });

  describe('previewNextRuns()', () => {
    it('reads a cron the scheduler has never registered, in its timezone (DOR-1394)', () => {
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      // Read before the call (DOR-1716): the preview is in the future OF THE CALL.
      const before = Date.now();
      const runs = service.previewNextRuns('0 3 * * *', 'UTC', 3);

      for (const run of runs) expect(run).toMatch(/T03:00:00\.000Z$/);
      const gaps = runs.slice(1).map((r, i) => Date.parse(r) - Date.parse(runs[i]!));
      expect(gaps).toEqual([86_400_000, 86_400_000]);
      expect(Date.parse(runs[0]!)).toBeGreaterThan(before);
      // 03:00 in Tokyo is 18:00 UTC the day before.
      expect(service.previewNextRuns('0 3 * * *', 'Asia/Tokyo', 1)[0]).toMatch(/T18:00:00\.000Z$/);
    });

    it('returns nothing for a cron or timezone it cannot read, rather than throwing', () => {
      // An agent writes these; a proposal with a broken cron must stay rejectable.
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      expect(service.previewNextRuns('99 99 99 99 99', 'UTC', 3)).toEqual([]);
      expect(service.previewNextRuns('0 3 * * *', 'Mars/Olympus_Mons', 3)).toEqual([]);
      expect(service.previewNextRuns(null, 'UTC', 3)).toEqual([]);
    });
  });

  describe('which fires run', () => {
    it('creates no run when mayFire is false, but still shows the next run', async () => {
      const task = store.createTask(taskInput({ name: 'Gated', cron: '0 * * * *' }));
      const service = new TaskSchedulerService(store, mockAgent, {
        ...DEFAULT_CONFIG,
        mayFire: false,
      });
      await service.start();

      await fire(service, task);

      expect(store.listRuns()).toHaveLength(0);
      expect(service.getNextRun(task.id)).not.toBeNull();
      await service.stop();
    });

    it('a follower does NOT fire scheduled dispatches (ADR-285)', async () => {
      const task = store.createTask(taskInput({ name: 'Follower', cron: '0 * * * *' }));
      const service = scheduler({ leaderLock: FOLLOWER_LOCK });

      await fire(service, task);

      expect(store.listRuns()).toHaveLength(0);
      await service.stop();
    });

    it('checks an agent changed outside DorkOS before the fire, and a park stops it (DOR-2337)', async () => {
      const task = store.createTask(
        taskInput({ name: 'Follows', cron: '0 * * * *', agentId: 'agent-1' })
      );
      const service = scheduler({
        beforeScheduledFire: async () => {
          store.approvals.parkAgentFollowers('agent-1', [
            { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4' },
          ]);
          return undefined;
        },
      });

      await fire(service, task);

      expect(store.getTask(task.id)!.status).toBe('pending_approval');
      expect(store.listRuns()).toHaveLength(0);
      await service.stop();
    });

    it.each([
      ['its work changed', () => ({ meshCore: undefined, prompt: 'something nobody approved' })],
      [
        "its agent's folder moved",
        () => ({ meshCore: meshAt('/agents/elsewhere'), prompt: undefined }),
      ],
    ])(
      'parks an agent-approved schedule when %s, instead of running it (DOR-3703)',
      async (_label, change) => {
        const task = store.createTask(
          taskInput({ name: 'Armed', cron: '0 * * * *', agentId: 'agent-1' })
        );
        store.approvals.recordAgentApproval(
          task.id,
          agentApprovalBindingOf(task, '/agents/one'),
          '{}'
        );
        const { meshCore, prompt } = change();
        if (prompt) store.updateTask(task.id, { prompt });
        const service = scheduler({ meshCore: meshCore ?? meshAt('/agents/one') });

        await fire(service, store.getTask(task.id)!);

        expect(store.getTask(task.id)!.status).toBe('pending_approval');
        expect(store.listRuns()).toHaveLength(0);
        await service.stop();
      }
    );

    it('runs distinct ticks separately', async () => {
      const task = store.createTask(taskInput({ name: 'Twice', cron: '0 * * * *' }));
      const service = scheduler();

      // Two instants inside one hour are one occurrence (DOR-2718), so step an hour.
      await fire(service, task);
      await fire(service, task, new Date(ON_TIME_HOURLY.getTime() + 3_600_000));

      expect(store.listRuns()).toHaveLength(2);
      await service.stop();
    });

    it('two leaders firing the same occurrence (ms apart) produce exactly one run (ADR-285)', async () => {
      // The dual-leader handoff window: one DB, the SAME minute a few ms apart.
      const task = store.createTask(taskInput({ name: 'Shared', cron: '* * * * *' }));
      const s1 = scheduler({ leaderLock: LEADER_LOCK });
      const s2 = scheduler({ leaderLock: LEADER_LOCK });
      const minuteBoundary = 1_700_000_040_000;

      await fire(s1, task, new Date(minuteBoundary + 2));
      await fire(s2, task, new Date(minuteBoundary + 7));

      expect(store.listRuns()).toHaveLength(1);
      await s1.stop();
      await s2.stop();
    });

    it('records a tick dropped at the cap as a skipped run (DOR-1482)', async () => {
      const busy = store.createTask(taskInput({ name: 'Slow one', cron: '* * * * *' }));
      const waiting = store.createTask(taskInput({ name: 'Waiting', cron: '* * * * *' }));
      const { impl, parked } = parkedTurn();
      vi.mocked(mockAgent.sendMessage).mockImplementation(impl);
      const service = scheduler();
      void service.triggerManualRun(busy.id);
      await parked;

      await fire(service, waiting, new Date(1_700_000_040_000));

      const [skipped] = store.listRuns({ taskId: waiting.id });
      expect(skipped).toMatchObject({ status: 'skipped', finishedAt: expect.any(String) });
      expect(skipped!.error).toContain('limit');
      expect(mockAgent.sendMessage).toHaveBeenCalledOnce();
      await service.stop();
    });
  });

  it('releases the original session and writes one failed terminal when identity is refused at the end (DOR-4328)', async () => {
    const refusal = new RequiredSessionIdentityError(new Error('required launch alias refused'));
    const target = '4328-independent';
    const targetProjector = getOrCreateProjector(target, '/independent');
    const targetGeneration = targetProjector.streamGeneration;
    let renamed = false;
    let original: string | undefined;
    vi.mocked(mockAgent.getInternalSessionId).mockImplementation((id) =>
      renamed && id === original ? target : undefined
    );
    vi.mocked(mockAgent.sendMessage).mockImplementation(async function* (id) {
      original = id;
      // No yielded event: canonical identity is first observed by finish().
      renamed = true;
    });
    const unregister = onRequiredSessionRekey((from, to) => {
      if (from === original && to === target) throw refusal;
    });
    const writes = vi.spyOn(store, 'updateRun');
    const task = store.createTask(taskInput({ name: 'Required', maxRuntime: null }));
    const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
    onTestFinished(async () => {
      unregister();
      // A red regression may leak accounting; don't spend the 30 s shutdown grace.
      if (service.getActiveRunCount() === 0) await service.stop();
      else store.close();
      disposeProjector(target);
      if (original) disposeProjector(original);
    });

    const run = await service.triggerManualRun(task.id);
    await vi.waitFor(() => {
      expect(store.getRun(run!.id)!.finishedAt).not.toBeNull();
      expect(service.getActiveRunCount()).toBe(0);
    });

    expect(store.getRun(run!.id)).toMatchObject({
      status: 'failed',
      sessionId: original,
      error: refusal.message,
    });
    const terminals = writes.mock.calls.filter(
      ([id, fields]) => id === run!.id && fields.status && isTerminalRunStatus(fields.status)
    );
    expect(terminals).toHaveLength(1);
    expect(mockAgent.releaseLock).toHaveBeenCalledWith(
      original,
      expect.any(String),
      expect.any(Symbol)
    );
    expect(mockAgent.releaseLock).not.toHaveBeenCalledWith(
      target,
      expect.anything(),
      expect.anything()
    );
    expect(peekProjector(target)).toBe(targetProjector);
    expect(targetProjector.streamGeneration).toBe(targetGeneration);
    // A cap-one scheduler must still admit the next run.
    renamed = false;
    vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {});
    const next = await service.triggerManualRun(task.id);
    await vi.waitFor(() => expect(store.getRun(next!.id)!.status).toBe('completed'));
  });

  describe('retention and crash recovery (DOR-1482)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A run that is over — the only kind retention may ever delete. */
    function finishedRun(taskId: string): string {
      const run = store.createRun(taskId, 'scheduled');
      store.updateRun(run.id, { status: 'completed', finishedAt: new Date().toISOString() });
      return run.id;
    }

    it('prunes finished history every hour, but never a run that is still going', async () => {
      vi.useFakeTimers();
      const task = store.createTask(taskInput({ name: 'Chatty', cron: '* * * * *' }));
      // Firing off, so the fake hour adds no runs of its own.
      const service = new TaskSchedulerService(store, mockAgent, {
        ...DEFAULT_CONFIG,
        retentionCount: 2,
        mayFire: false,
      });
      await service.start();

      // A long relay run buried under newer rows: deleting it would lose its
      // outcome and hand back the slot it holds.
      const live = store.createRun(task.id, 'scheduled');
      for (let i = 0; i < 4; i++) finishedRun(task.id);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      const left = store.listRuns({ taskId: task.id });
      expect(left.filter((r) => r.status === 'completed')).toHaveLength(2);
      expect(store.getRun(live.id)!.status).toBe('running');
      await service.stop();
    });

    it('a promotion never ends the scheduled run this process is executing', async () => {
      // This process led, stalled past the lock's TTL, lost it and was promoted
      // again. The promotion's sweep must not fail the run it still owns.
      const task = store.createTask(taskInput({ name: 'Ours', cron: '0 * * * *' }));
      const { impl, parked } = parkedTurn();
      vi.mocked(mockAgent.sendMessage).mockImplementation(impl);
      let leaderNow = true;
      const service = scheduler({
        leaderLock: {
          tryAcquire: () => leaderNow,
          heartbeat: () => {},
          release: () => {},
          get isLeaderNow() {
            return leaderNow;
          },
        },
      });
      await service.start();
      const strandedByTheOtherProcess = store.createRun(task.id, 'scheduled');

      void fire(service, task, new Date(1_700_000_040_000));
      await parked;
      const mine = store
        .listRuns({ taskId: task.id })
        .find((run) => run.status === 'running' && run.id !== strandedByTheOtherProcess.id)!;

      const beat = (service as unknown as { onHeartbeat(): void }).onHeartbeat.bind(service);
      leaderNow = false;
      beat();
      leaderNow = true;
      beat();

      // Ours survives, and the stranded one is swept, so the sweep did run.
      expect(store.getRun(mine.id)!.status).toBe('running');
      expect(store.getRun(strandedByTheOtherProcess.id)!.status).toBe('failed');
      await service.stop();
    });
  });
});
