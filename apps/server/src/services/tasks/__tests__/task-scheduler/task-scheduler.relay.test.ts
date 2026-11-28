import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { TaskSchedulerService, singleRuntimeSource } from '../../task-scheduler-service.js';
import type { SchedulerRuntimes } from '../../task-scheduler-service.js';
import { RUN_START_WAIT_MS } from '../../timing/wake-settle.js';
import type { RelayCore } from '@dorkos/relay';
import type { TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import { TaskStore } from '../../task-store.js';
import type { CreateTaskStoreInput } from '../../task-store.js';
import { setRelayEnabled } from '../../../relay/relay-state.js';
import {
  SESSION_UUID_RE,
  waitFor,
  taskInput,
  DEFAULT_CONFIG,
  ON_TIME_HOURLY,
  createMockMeshCore,
  freshHarness,
  relayStub,
} from './task-scheduler.fixtures.js';
import type { MockRelay, Dispatchable } from './task-scheduler.fixtures.js';
import { registerClaudeCodeFacts } from '../../../../startup/register-claude-code-facts.js';
import { turnsOn, type RuntimeDouble } from '../support/runtime-task-turns.js';

// What the server's startup registers (DOR-4928): unregistered, the protected-path policy
// refuses every path and turn code knows no Claude transcript.
registerClaudeCodeFacts();

/** One tick every dispatch in this file claims unless it needs its own. */
const TICK = new Date(1_700_000_000_000);

// Attended runs never ride the relay (`assessRelayDispatch` refuses all but
// `trigger === 'scheduled'`), so these drive the scheduled-firing chokepoint.
describe('TaskSchedulerService — the relay path', () => {
  let store: TaskStore;
  let mockAgent: RuntimeDouble;
  let mockRelay: MockRelay;

  beforeEach(async () => {
    ({ store, mockAgent } = await freshHarness());
    setRelayEnabled(true);
    mockRelay = relayStub('msg-1');
  });

  afterEach(() => {
    setRelayEnabled(false);
    vi.useRealTimers();
  });

  /** A relay-enabled scheduler over the mock agent. */
  function relayScheduler(
    extra: {
      maxConcurrentRuns?: number;
      runtimes?: SchedulerRuntimes;
      meshAgents?: Record<string, string>;
    } = {}
  ): TaskSchedulerService {
    const runtimes = extra.runtimes ?? singleRuntimeSource(mockAgent);
    return new TaskSchedulerService({
      store,
      runtimes,
      turns: turnsOn(runtimes),
      config: { ...DEFAULT_CONFIG, maxConcurrentRuns: extra.maxConcurrentRuns ?? 1 },
      relay: mockRelay as unknown as RelayCore,
      ...(extra.meshAgents ? { meshCore: createMockMeshCore(extra.meshAgents) } : {}),
    });
  }

  const fire = (
    service: TaskSchedulerService,
    task: ReturnType<TaskStore['createTask']>,
    when = TICK
  ) => (service as unknown as Dispatchable).dispatch(task, when);

  /** The n-th task_dispatch payload published (stop requests excluded). */
  const dispatches = () =>
    mockRelay.publish.mock.calls
      .map(([, payload]) => payload as TaskDispatchPayload)
      .filter((payload) => payload.type === 'task_dispatch');

  describe('what goes on the wire', () => {
    it('publishes the run, its briefing, its limits and no replyTo (DOR-1567, DOR-4576)', async () => {
      const task = store.createTask(
        taskInput({
          name: 'Payload Test',
          prompt: 'run this task',
          cron: '30 2 * * *',
          maxRuntime: 30 * 60_000,
        })
      );
      const service = relayScheduler();
      const now = Date.now();

      // An on-time fire of its 02:30 occurrence; a stale one is skipped (DOR-2718).
      await fire(service, task, new Date('2023-11-14T02:30:00Z'));
      await waitFor(() => expect(mockRelay.publish).toHaveBeenCalledOnce());

      const [, payload, options] = mockRelay.publish.mock.calls[0];
      expect(payload).toMatchObject({
        type: 'task_dispatch',
        taskId: task.id,
        prompt: 'run this task',
        trigger: 'scheduled',
        timeLimitMs: 30 * 60_000,
        timeLimit: '30m',
      });
      expect((payload as TaskDispatchPayload).systemPromptAppend).toContain('Job: Payload Test');
      // An agent-less task names no turn agent (DOR-2355).
      expect(payload).not.toHaveProperty('forAgent');
      // NO replyTo: the subject it named sat under the tasks prefix the adapter
      // claims, so every progress event dead-lettered (DOR-1567).
      expect(options.replyTo).toBeUndefined();
      // The bus TTL covers the time limit plus the longest wait to start.
      const limit = now + 30 * 60_000 + RUN_START_WAIT_MS;
      expect(options.budget.ttl).toBeGreaterThanOrEqual(limit - 1000);
      expect(options.budget.ttl).toBeLessThanOrEqual(limit + 5000);
      await service.stop();
    });

    it('carries the agent, approved rules, a raised level and the account (DOR-2355, DOR-2100, DOR-2384)', async () => {
      const agentHome = await mkdtemp(path.join(tmpdir(), 'relay-task-agent-'));
      try {
        const rule = 'Bash(/abs/path/script.sh --once)';
        const task = store.createTask(
          taskInput({ name: 'Raised', agentId: 'agent-r', account: 'work' })
        );
        expect(task.permissionMode).toBe('acceptEdits');
        // The approval, as `PATCH /api/tasks/:id` performs it.
        const approved = store.updateTask(task.id, {
          status: 'active',
          permissionMode: 'bypassPermissions',
          approvedAllow: [rule],
        })!;
        const plain = store.createTask(taskInput({ name: 'Plain' }));
        const service = relayScheduler({
          maxConcurrentRuns: 2,
          meshAgents: { 'agent-r': agentHome },
        });

        await fire(service, approved);
        await fire(service, plain);
        await waitFor(() => expect(dispatches()).toHaveLength(2));

        const [mine, other] = dispatches();
        expect(mine).toMatchObject({
          forAgent: agentHome,
          permissionMode: 'bypassPermissions',
          approvedAllow: [rule],
          account: 'work',
        });
        expect(other).not.toHaveProperty('approvedAllow');
        expect(other).not.toHaveProperty('account');
        await service.stop();
      } finally {
        await rm(agentHome, { recursive: true, force: true });
      }
    });

    it("a sticky relay dispatch resumes the prior run's REAL session (DOR-1571)", async () => {
      const task = store.createTask(
        taskInput({ name: 'Sticky relay', cron: '0 * * * *', sticky: true })
      );
      const service = relayScheduler();

      const first = await fire(service, task, ON_TIME_HOURLY).then(
        () => store.listRuns({ taskId: task.id })[0]!
      );
      const [firstPayload] = dispatches();
      expect(firstPayload!.sessionId).toMatch(SESSION_UUID_RE);
      expect(firstPayload!.resumeSession).toBe(false);

      // The receiver records the RUNTIME's own id, not the key it was handed.
      const realId = 'sdk-real-uuid-1';
      await runtimeRegistry.persistSessionRuntime(
        firstPayload!.sessionId!,
        firstPayload!.runtime ?? 'claude-code',
        { kind: 'schedule' },
        firstPayload!.forAgent
      );
      await runtimeRegistry.rekeySessionSettings(firstPayload!.sessionId!, realId);
      store.updateRun(first.id, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        sessionId: realId,
      });

      await fire(service, task, new Date(ON_TIME_HOURLY.getTime() + 3_600_000));
      expect(dispatches()[1]).toMatchObject({ sessionId: realId, resumeSession: true });
      await service.stop();
    });
  });

  describe('delivery', () => {
    it('DOR-248: a terminal status the handler already wrote survives the post-publish "running" write', async () => {
      // In-process delivery is synchronous: the handler can finish the run
      // BEFORE publish() resolves here.
      mockRelay.publish.mockImplementation(
        async (_subject: string, payload: TaskDispatchPayload) => {
          store.updateRun(payload.runId, {
            status: 'completed',
            finishedAt: '2026-07-10T02:44:10.310Z',
            outputSummary: 'ok',
          });
          return { messageId: 'msg-race', deliveredTo: 1 };
        }
      );
      const task = store.createTask(taskInput({ name: 'Synchronous Race', cron: '0 * * * *' }));
      const service = relayScheduler();

      await fire(service, task);

      expect(store.listRuns({ taskId: task.id })[0]).toMatchObject({
        status: 'completed',
        finishedAt: '2026-07-10T02:44:10.310Z',
        outputSummary: 'ok',
      });
      await service.stop();
    });

    it('names the hourly turn limit when the bus refused the run for it', async () => {
      mockRelay.publish.mockResolvedValue({
        messageId: 'm',
        deliveredTo: 0,
        rejected: [{ endpointHash: 'h', reason: 'turn_ceiling' }],
      });
      const task = store.createTask(taskInput({ name: 'Turn Ceiling', cron: '0 * * * *' }));
      const service = relayScheduler();

      await fire(service, task);

      expect(store.listRuns({ taskId: task.id })[0]!.error).toBe(
        'The hourly limit on agent turns was reached, so this run didn’t start.'
      );
      await service.stop();
    });
  });

  describe('a dispatch nobody answered gets one retry (DOR-3033)', () => {
    /**
     * Walk the fake clock until `pending` settles. Each step first yields a real
     * turn so dispatch work on real I/O sets its retry timer before the clock
     * moves; a fixed step count could leave the 30 s wait unwalked (DOR-3368).
     */
    async function settleUnderFakeClock<T>(pending: Promise<T>): Promise<T> {
      let settled = false;
      void pending.finally(() => (settled = true));
      while (!settled) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(5_000);
      }
      return pending;
    }

    /** The default runtime, declaring three modes, so a level can be compared. */
    function runtimeWithModes(): SchedulerRuntimes {
      const base = singleRuntimeSource(mockAgent);
      const mode = (id: string, asks: string, reach: string) => ({ id, label: id, asks, reach });
      const permissionModes = {
        supported: true,
        default: 'acceptEdits',
        values: [
          mode('plan', 'always', 'read'),
          mode('acceptEdits', 'when-risky', 'edit'),
          mode('bypassPermissions', 'never', 'everything'),
        ],
      };
      return {
        ...base,
        getAllCapabilities: () =>
          ({ [base.getDefaultType()]: { permissionModes } }) as unknown as ReturnType<
            SchedulerRuntimes['getAllCapabilities']
          >,
      };
    }

    /** Dispatch a task whose first delivery finds nobody; hand back the run and the wait. */
    async function waitingForRetry(name: string, over: Partial<CreateTaskStoreInput> = {}) {
      mockRelay.publish
        .mockResolvedValueOnce({ messageId: 'm1', deliveredTo: 0 })
        .mockResolvedValue({ messageId: 'm2', deliveredTo: 1 });
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const task = store.createTask(taskInput({ name, cron: '0 * * * *', ...over }));
      const service = relayScheduler({ runtimes: runtimeWithModes() });
      const pending = fire(service, task);
      await waitFor(() => expect(mockRelay.publish).toHaveBeenCalledTimes(1));
      const run = store.listRuns({ taskId: task.id })[0]!;
      const finish = async () => {
        await settleUnderFakeClock(pending);
        vi.useRealTimers();
        await service.stop();
      };
      return { task, run, service, finish };
    }

    it('tries once more when nothing answered, and runs when something does', async () => {
      const { run, finish } = await waitingForRetry('Retry Works');
      await finish();
      expect(dispatches()).toHaveLength(2);
      expect(store.getRun(run.id)?.status).toBe('running');
    });

    // Security Must: Stop on a run nothing received yet ends it for good.
    it('pressing Stop during the wait ends the run, and it never starts', async () => {
      const { run, service, finish } = await waitingForRetry('Stopped Meanwhile');
      await expect(service.cancelRun(run.id)).resolves.toEqual({ state: 'stopping' });
      await finish();
      expect(dispatches()).toHaveLength(1);
      expect(store.getRun(run.id)).toMatchObject({
        status: 'cancelled',
        error: 'Stopped before it started.',
      });
    });

    // A run that ended, or a schedule turned off or sent back for approval,
    // during the 30 s wait must not be started anyway.
    it.each([
      [
        'the run ended',
        (_taskId: string, runId: string) =>
          void store.updateRun(runId, { status: 'cancelled', error: 'Run cancelled' }),
        'cancelled',
      ],
      [
        'the schedule was turned off',
        (taskId: string) => void store.updateTask(taskId, { enabled: false }),
        'skipped',
      ],
    ] as const)('does not retry when %s during the wait', async (_label, change, status) => {
      const { task, run, finish } = await waitingForRetry(`Changed: ${_label}`);
      change(task.id, run.id);
      await finish();
      expect(dispatches()).toHaveLength(1);
      expect(store.getRun(run.id)?.status).toBe(status);
    });

    // Security Must: a lower level binds queued work; a raise never reaches it (DOR-3175).
    it.each([
      ['lowered', 'bypassPermissions', 'acceptEdits', 'acceptEdits'],
      ['raised', 'acceptEdits', 'bypassPermissions', 'acceptEdits'],
    ] as const)(
      'a level %s during the wait retries at the lower of the two',
      async (_l, from, to, expected) => {
        const { task, finish } = await waitingForRetry(`Level ${_l}`, { permissionMode: from });
        store.updateTask(task.id, { permissionMode: to });
        await finish();
        expect(dispatches()).toHaveLength(2);
        expect(dispatches()[1]!.permissionMode).toBe(expected);
      }
    );
  });

  describe('the concurrency cap counts relay runs too (DOR-1482)', () => {
    it('keeps a tick off the bus while a relay run holds the only slot, and frees it when the run ends', async () => {
      // With the relay enabled `maxConcurrentRuns` never tripped, so a slow
      // hourly task could pile up unbounded agent turns. A tick at the cap is no
      // longer skipped: it goes in process, where admission holds it for a slot
      // (spec `turns-survive-restarts` §3.5, proven in `tasks-through-turn-port`).
      const first = store.createTask(taskInput({ name: 'First', cron: '0 * * * *' }));
      const second = store.createTask(taskInput({ name: 'Second', cron: '0 * * * *' }));
      const service = relayScheduler();

      await fire(service, first);
      expect(service.getActiveRunCount()).toBe(1);
      await fire(service, second, new Date(1_700_000_040_000));
      expect(mockRelay.publish).toHaveBeenCalledOnce();
      expect(store.listRuns({ taskId: second.id })[0]!.status).not.toBe('skipped');
      expect(mockAgent.sendMessage).toHaveBeenCalledOnce();

      // The receiver finishes it; the row is the only thing that says so.
      const held = store.listRuns({ taskId: first.id })[0]!;
      store.updateRun(held.id, { status: 'completed', finishedAt: new Date().toISOString() });
      await waitFor(() => expect(service.getActiveRunCount()).toBe(0));
      // The next occurrence (one inside the same hour is the same tick, DOR-2718).
      await fire(service, second, new Date(1_700_000_040_000 + 3_600_000));
      expect(mockRelay.publish).toHaveBeenCalledTimes(2);
      await service.stop();
    });

    it('shutdown asks the bus to stop the relay runs it cannot abort itself', async () => {
      const task = store.createTask(taskInput({ name: 'Left running', cron: '0 * * * *' }));
      const service = relayScheduler();
      await fire(service, task);
      const run = store.listRuns({ taskId: task.id })[0]!;

      await service.stop();

      const stop = mockRelay.publish.mock.calls.find(([subject]) =>
        String(subject).includes('cancel')
      );
      expect(JSON.stringify(stop![1])).toContain(run.id);
    });
  });

  describe('cancelRun() for a relay-dispatched run', () => {
    /** A task with one run the relay is carrying (status `running`). */
    function relayRun(name: string) {
      const task = store.createTask(taskInput({ name, cron: '0 * * * *' }));
      return store.createRun(task.id, 'scheduled');
    }

    it('sends a short-lived stop over the bus, addressed to the run', async () => {
      const run = relayRun('Relay Cancel');
      const service = relayScheduler();

      await expect(service.cancelRun(run.id)).resolves.toEqual({ state: 'stopping' });

      const [subject, payload, options] = mockRelay.publish.mock.calls[0];
      expect(subject).toBe(`relay.control.task-cancel.${run.id}`);
      expect(payload).toEqual({ type: 'task_cancel', runId: run.id });
      // A stop replayed to a late subscriber names a run long since ended.
      expect(options.budget.ttl).toBeLessThanOrEqual(Date.now() + 30_000);
      await service.stop();
    });

    it.each([
      ['nothing takes it', { messageId: 'c', deliveredTo: 0 }, undefined],
      [
        // One principal for every task makes the per-sender limit realistic.
        'the bus is rate-limiting',
        {
          messageId: 'c',
          deliveredTo: 0,
          rejected: [{ endpointHash: '*', reason: 'rate_limited' }],
        },
        'rate-limiting',
      ],
      ['the stop cannot be sent', new Error('Access denied'), 'Access denied'],
    ])('reports unconfirmed, and leaves the run alone, when %s', async (_label, answer, reason) => {
      if (answer instanceof Error) mockRelay.publish.mockRejectedValue(answer);
      else mockRelay.publish.mockResolvedValue(answer);
      const run = relayRun('Unconfirmed');
      const service = relayScheduler();

      const outcome = await service.cancelRun(run.id);

      expect(outcome.state).toBe('unconfirmed');
      if (reason) expect(outcome).toMatchObject({ reason: expect.stringContaining(reason) });
      expect(store.getRun(run.id)!.status).toBe('running');
      await service.stop();
    });

    it('reports already_finished when the run ends while the stop is in flight', async () => {
      const run = relayRun('Finished In Flight');
      mockRelay.publish.mockImplementation(async () => {
        store.updateRun(run.id, { status: 'completed', finishedAt: new Date().toISOString() });
        return { messageId: 'cancel-3', deliveredTo: 0 };
      });
      const service = relayScheduler();

      await expect(service.cancelRun(run.id)).resolves.toEqual({ state: 'already_finished' });
      expect(store.getRun(run.id)!.status).toBe('completed');
      await service.stop();
    });
  });
});
