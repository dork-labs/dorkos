import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { TaskSchedulerService, singleRuntimeSource } from '../../task-scheduler-service.js';
import type { SchedulerAgentManager } from '../../task-scheduler-service.js';
import type { RelayCore } from '@dorkos/relay';
import { NotificationStore } from '../../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../../notifications/notification-service.js';
import { notifyRunCompleted } from '../../../notifications/emitters/run-completed.js';
import { TaskStore } from '../../task-store.js';
import * as misplacedMode from '../../execution/misplaced-mode.js';
import { isTerminalRunStatus } from '../../lifecycle/run-statuses.js';
import { recentDispatches } from '../../../observability/dispatch-buffers.js';
import type { Db } from '@dorkos/db';
import type { StreamEvent, TaskRun } from '@dorkos/shared/types';
import type { ActivityService } from '../../../activity/activity-service.js';
import {
  RemapFakeAgent,
  parkedTurn,
  deferred,
  turnThatEndsAsItIsStopped,
  SESSION_UUID_RE,
  waitFor,
  taskInput,
  DEFAULT_CONFIG,
  ON_TIME_HOURLY,
  freshHarness,
} from './task-scheduler.fixtures.js';
import type { Dispatchable } from './task-scheduler.fixtures.js';
import { registerClaudeCodeFacts } from '../../../../startup/register-claude-code-facts.js';

// What the server's startup registers (DOR-4928): unregistered, the protected-path policy
// refuses every path and turn code knows no Claude transcript.
registerClaudeCodeFacts();

/** DorkOS's own refusal record for a tool asked on a run nobody watches. */
function nobodyThere(toolName: string, id: string): StreamEvent {
  return {
    type: 'permission_denied',
    data: {
      toolCallId: id,
      toolName,
      reasonType: 'no_approval_surface',
      askKind: 'tool',
      reason: 'nobody was available to approve this tool',
      message: 'Nobody is available to approve this on a scheduled run.',
    },
  } as StreamEvent;
}

/** A tool call that ended having actually done its job. */
function toolWorked(toolName: string, id: string): StreamEvent {
  return {
    type: 'tool_result',
    data: { toolCallId: id, toolName, result: 'ok', status: 'complete' },
  } as StreamEvent;
}

describe('TaskSchedulerService — how a run goes and how it ends', () => {
  let store: TaskStore;
  let db: Db;
  let mockAgent: SchedulerAgentManager;

  beforeEach(async () => {
    ({ db, store, mockAgent } = await freshHarness());
  });

  /** Fire a manual run of `task` and hand back its terminal row. */
  async function runManually(service: TaskSchedulerService, taskId: string): Promise<TaskRun> {
    const run = await service.triggerManualRun(taskId);
    await waitFor(() => expect(isTerminalRunStatus(store.getRun(run!.id)!.status)).toBe(true));
    return store.getRun(run!.id)!;
  }

  describe('the asks a run could not get answered', () => {
    // A timer-started run has nobody to answer a prompt, so the runtime refuses
    // it at once (spec `unattended-session-permission-prompts`); these pin the
    // telling, and the one trigger that must keep its cards.
    it('marks a timer run unattended and briefs it so; leaves a "Run now" answerable', async () => {
      const task = store.createTask(taskInput({ name: 'Nightly', cron: '0 * * * *' }));
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);

      await (service as unknown as Dispatchable).dispatch(task, ON_TIME_HOURLY);
      await runManually(service, task.id);

      const [timer, manual] = vi.mocked(mockAgent.ensureSession).mock.calls;
      expect(timer![1]).toMatchObject({ unattended: true });
      expect(manual![1]).toMatchObject({ unattended: false });
      const [timerSend, manualSend] = vi.mocked(mockAgent.sendMessage).mock.calls;
      expect(timerSend![2]?.systemPromptAppend).toContain('Nobody is here to approve');
      expect(timerSend![2]?.systemPromptAppend).toContain('Nightly');
      expect(manualSend![2]?.systemPromptAppend).not.toContain('Nobody is here to approve');
      await service.stop();
    });

    it('leads the summary with a tool it could not use, and reads as partial (DOR-2101)', async () => {
      // The successful call makes this the run that lost ONE tool and carried on.
      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        yield nobodyThere('Bash', 't1');
        yield toolWorked('Read', 't2');
        yield { type: 'text_delta', data: { text: 'Checked what I could.' } } as StreamEvent;
      });
      const task = store.createTask(taskInput({ name: 'Refused', cron: '0 * * * *' }));
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);

      const finished = await runManually(service, task.id);

      // First line: history and the finished-run message quote only that.
      expect(finished.outputSummary?.split('\n')[0]).toBe(
        'Skipped Bash — nobody was there to approve it on a scheduled run.'
      );
      expect(finished.outputSummary).toContain('Checked what I could.');
      expect(finished).toMatchObject({
        status: 'needs_attention',
        outcome: 'partial',
        refusedTools: ['Bash'],
      });
      await service.stop();
    });

    it('never records an Accept edits schedule that lost Bash as completed (DOR-3123, DOR-3839)', async () => {
      // The terminal hook must reach the person's real notification store too.
      const notifications = new NotificationService(new NotificationStore(db));
      setNotificationService(notifications);
      store.setOnRunTerminal((run, task) => void notifyRunCompleted(run, task));
      onTestFinished(() => setNotificationService(null));
      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        yield toolWorked('Read', 't1');
        yield nobodyThere('Bash', 't2');
      });
      const task = store.createTask(
        taskInput({ name: 'Health check', cron: '0 * * * *', permissionMode: 'acceptEdits' })
      );
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);

      await (service as unknown as Dispatchable).dispatch(task, ON_TIME_HOURLY);
      const [run] = store.listRuns({ taskId: task.id });
      await waitFor(() => expect(isTerminalRunStatus(store.getRun(run!.id)!.status)).toBe(true));

      expect(store.getRun(run!.id)).toMatchObject({
        trigger: 'scheduled',
        status: 'needs_attention',
        error: 'Skipped Bash — nobody was there to approve it on a scheduled run.',
      });
      await waitFor(() =>
        expect(notifications.list({ limit: 25, unread: false }).notifications).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              title: 'Health check had a command refused',
              body: 'It may have needed approval. Open the schedule to check its mode.',
            }),
          ])
        )
      );
      expect(store.runHistory()(task.id).health).toMatchObject({
        state: 'failing',
        reason: { kind: 'tool_refused', tools: ['Bash'], nothingDone: false },
      });
      await service.stop();
    });

    it('records a tool the Never ask mode refused (DOR-3132)', async () => {
      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        yield {
          type: 'permission_denied',
          data: { toolCallId: 't1', toolName: 'Bash', reasonType: 'mode', message: 'never ask' },
        } as StreamEvent;
        yield toolWorked('Read', 't2');
      });
      const task = store.createTask(
        taskInput({ name: 'Publisher', cron: '0 * * * *', permissionMode: 'dontAsk' })
      );
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);

      expect(await runManually(service, task.id)).toMatchObject({
        status: 'needs_attention',
        refusedTools: ['Bash'],
      });
      await service.stop();
    });

    it('records a run refused every tool as needing attention with nothing done', async () => {
      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        yield nobodyThere('Bash', 't1');
        yield nobodyThere('mcp__gmail__search', 't2');
        yield { type: 'text_delta', data: { text: 'I could not read the mail.' } } as StreamEvent;
      });
      const task = store.createTask(taskInput({ name: 'Mailroom', cron: '0 * * * *' }));
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);

      expect(await runManually(service, task.id)).toMatchObject({
        status: 'needs_attention',
        outcome: 'nothing_done',
        error:
          'Skipped Bash and gmail: search — nobody was there to approve them on a scheduled run.',
        refusedTools: ['Bash', 'mcp__gmail__search'],
      });
      await service.stop();
    });

    it('writes one activity entry per refused tool, however often it was retried', async () => {
      const activityService = { emit: vi.fn() };
      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        for (let i = 0; i < 30; i++) yield nobodyThere('Bash', `t-${i}`);
        yield nobodyThere('mcp__dorkos__control_ui', 'u');
      });
      const task = store.createTask(taskInput({ name: 'Noted', cron: '0 * * * *' }));
      const service = new TaskSchedulerService({
        store,
        runtimes: singleRuntimeSource(mockAgent),
        config: DEFAULT_CONFIG,
        activityService: activityService as unknown as ActivityService,
      });

      await runManually(service, task.id);

      const refusals = activityService.emit.mock.calls
        .map(([event]) => event as { eventType: string; summary: string })
        .filter((event) => event.eventType === 'tasks.ask_refused');
      expect(refusals.map((event) => event.summary)).toEqual([
        'Noted had a Bash command refused',
        'Noted was refused control_ui',
      ]);
      await service.stop();
    });
  });

  describe('stopping a run', () => {
    it('stops a manual run during preparation without starting it', async () => {
      const preparing = deferred();
      const resume = deferred();
      const finished = deferred();
      // Hold the real pre-dispatch boundary: the schedule read can outlast the
      // trigger response and the person's following Stop request.
      const read = vi
        .spyOn(misplacedMode, 'checkMisplacedMode')
        .mockImplementationOnce(async (task) => {
          preparing.resolve();
          await resume.promise;
          return task;
        });
      const relay = { publish: vi.fn().mockResolvedValue({ messageId: 'stop', deliveredTo: 0 }) };
      const service = new TaskSchedulerService({
        store,
        runtimes: singleRuntimeSource(mockAgent),
        config: DEFAULT_CONFIG,
        relay: relay as unknown as RelayCore,
        keepAwake: {
          holdTask: () => ({ attachSession: vi.fn(), release: () => finished.resolve() }),
        },
      });
      const task = store.createTask(taskInput({ name: 'Preparing', cron: '0 * * * *' }));
      try {
        const run = await service.triggerManualRun(task.id);
        await preparing.promise;
        const stopped = await service.cancelRun(run!.id);
        resume.resolve();
        // A released hold means preparation and execution have both settled.
        await finished.promise;
        expect(stopped).toEqual({ state: 'stopping' });
        expect(store.getRun(run!.id)).toMatchObject({
          status: 'cancelled',
          sessionId: null,
          error: 'Stopped before it started.',
        });
        expect(mockAgent.sendMessage).not.toHaveBeenCalled();
        expect(relay.publish).not.toHaveBeenCalled();
        expect(recentDispatches(1)[0]).toMatchObject({ outcome: 'halted' });
      } finally {
        resume.resolve();
        read.mockRestore();
        await service.stop();
      }
    });

    it.each([
      ['maxRuntime expires', 50, 'time limit'],
      ['cancelRun is called', null, 'Run cancelled'],
    ])(
      'interrupts a parked run when %s, on the session it ran on',
      async (_label, maxRuntime, error) => {
        const turn = parkedTurn();
        vi.mocked(mockAgent.sendMessage).mockImplementation(turn.impl);
        const task = store.createTask(taskInput({ name: 'Parked', cron: '0 * * * *', maxRuntime }));
        const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
        const run = await service.triggerManualRun(task.id);
        await turn.parked;

        if (maxRuntime === null) {
          await expect(service.cancelRun(run!.id)).resolves.toEqual({ state: 'stopping' });
        }
        await waitFor(() => expect(store.getRun(run!.id)!.status).toBe('cancelled'), {
          timeout: 2000,
        });

        // The runtime is told to stop on the freshly minted session it ran on.
        const sessionId = vi.mocked(mockAgent.ensureSession).mock.calls[0]![0];
        expect(sessionId).toMatch(SESSION_UUID_RE);
        expect(mockAgent.interruptQuery).toHaveBeenCalledWith(sessionId);
        expect(store.getRun(run!.id)!.sessionId).toBe(sessionId);
        expect(store.getRun(run!.id)!.error).toContain(error);
        // The slot comes back, so the next tick can fire.
        await waitFor(() => expect(service.getActiveRunCount()).toBe(0), { timeout: 2000 });
        await service.stop();
      }
    );

    it('records a run that FINISHED as completed, even when a stop lands in the same instant', async () => {
      // Reading `signal.aborted` after the fact cannot tell a lost stop from a won one.
      const task = store.createTask(
        taskInput({ name: 'PhotoFinish', cron: '0 * * * *', maxRuntime: null })
      );
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      vi.mocked(mockAgent.sendMessage).mockImplementation((() =>
        turnThatEndsAsItIsStopped(
          () => void service.cancelRun(store.listRuns({ taskId: task.id })[0]!.id)
        )) as unknown as SchedulerAgentManager['sendMessage']);

      const run = await service.triggerManualRun(task.id);
      await waitFor(() => expect(store.getRun(run!.id)!.finishedAt).not.toBeNull());

      expect(store.getRun(run!.id)).toMatchObject({ status: 'completed', error: null });
      await service.stop();
    });

    it('still finalizes a run whose interrupt fails', async () => {
      const turn = parkedTurn();
      vi.mocked(mockAgent.sendMessage).mockImplementation(turn.impl);
      vi.mocked(mockAgent.interruptQuery).mockRejectedValue(new Error('runtime is wedged'));
      const task = store.createTask(
        taskInput({ name: 'Wedged', cron: '0 * * * *', maxRuntime: 50 })
      );
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const run = await service.triggerManualRun(task.id);
      await turn.parked;

      await waitFor(() => expect(store.getRun(run!.id)!.status).toBe('cancelled'), {
        timeout: 2000,
      });
      expect(service.getActiveRunCount()).toBe(0);
      await service.stop();
    });
  });

  // The outcome permutations (recovered errors, hook failures, sign-in wording)
  // are pinned on the tracker itself in packages/shared run-outcome.test.ts.
  describe('a run that hit an error says so (DOR-1658)', () => {
    /** Run one turn to its terminal row and hand the row back. */
    async function runTurn(turn: () => AsyncGenerator<StreamEvent>): Promise<TaskRun> {
      vi.mocked(mockAgent.sendMessage).mockImplementation(turn);
      const task = store.createTask(
        taskInput({ name: 'Turn', cron: '0 * * * *', maxRuntime: null })
      );
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const row = await runManually(service, task.id);
      await service.stop();
      return row;
    }

    it('records a stream that errored and then ended as FAILED, with the message', async () => {
      const finished = await runTurn(async function* () {
        yield { type: 'text_delta', data: { text: 'starting' } };
        yield {
          type: 'error',
          data: { message: 'API Error: 500 upstream', category: 'execution_error' },
        };
      });

      expect(finished).toMatchObject({
        status: 'failed',
        error: 'API Error: 500 upstream',
        outputSummary: 'starting',
      });
    });

    it('records a STOPPED run as cancelled even though its turn errored', async () => {
      // The error frame BEFORE the park is what puts the two answers in conflict.
      let signalParked!: () => void;
      const parked = new Promise<void>((resolve) => (signalParked = resolve));
      vi.mocked(mockAgent.sendMessage).mockImplementation(async function* () {
        yield { type: 'error', data: { message: 'API Error: 500 upstream' } };
        signalParked();
        await new Promise(() => {});
      });
      const task = store.createTask(
        taskInput({ name: 'Stopped', cron: '0 * * * *', maxRuntime: 50 })
      );
      const service = new TaskSchedulerService(store, mockAgent, DEFAULT_CONFIG);
      const run = await service.triggerManualRun(task.id);
      await parked;

      await waitFor(() => expect(store.getRun(run!.id)!.status).toBe('cancelled'), {
        timeout: 2000,
      });
      expect(store.getRun(run!.id)!.error).toContain('time limit');
      await service.stop();
    });
  });

  describe('sticky sessions (DOR-1571)', () => {
    // Sticky must survive the loss of the in-memory session (idle-reap or a
    // restart). It fails against a synthetic id with no transcript on disk.
    it("resumes the prior run's REAL SDK session AFTER eviction, loading its history", async () => {
      const fake = new RemapFakeAgent();
      const task = store.createTask(
        taskInput({ name: 'Sticky cold', cron: '* * * * *', sticky: true })
      );
      const service = new TaskSchedulerService(store, fake as unknown as SchedulerAgentManager, {
        ...DEFAULT_CONFIG,
        maxConcurrentRuns: 5,
      });
      const dispatch = (service as unknown as Dispatchable).dispatch.bind(service);

      await dispatch(task, new Date(1_700_000_040_000));
      const realId = fake.turns[0]!.ranAs;
      expect(store.listRuns({ taskId: task.id })[0]!.sessionId).toBe(realId);

      fake.evict();
      await dispatch(task, new Date(1_700_000_100_000));

      expect(fake.turns[1]).toMatchObject({ key: realId, hasStarted: true, loadedHistory: true });
      expect(store.listRuns({ taskId: task.id }).every((r) => r.sessionId === realId)).toBe(true);
      await service.stop();
    });

    it('a sticky fire while its session is busy is skipped, not run in parallel', async () => {
      const task = store.createTask(
        taskInput({ name: 'Sticky busy', cron: '* * * * *', sticky: true })
      );
      const { impl, parked } = parkedTurn();
      vi.mocked(mockAgent.sendMessage).mockImplementation(impl);
      // Cap high so the ONLY reason to skip is the one-session rule.
      const service = new TaskSchedulerService(store, mockAgent, {
        ...DEFAULT_CONFIG,
        maxConcurrentRuns: 5,
      });
      const dispatch = (service as unknown as Dispatchable).dispatch.bind(service);

      void dispatch(task, new Date(1_700_000_040_000));
      await parked;

      // Without the guard the second fire opens a turn that parks forever, so
      // race it against that broken outcome rather than a wall-clock guess.
      const secondFire = dispatch(task, new Date(1_700_000_100_000));
      const secondTurnOpened = vi
        .waitFor(() => expect(mockAgent.sendMessage).toHaveBeenCalledTimes(2))
        .catch(() => undefined);
      await Promise.race([secondFire, secondTurnOpened]);

      expect(mockAgent.sendMessage).toHaveBeenCalledOnce();
      const skipped = store.listRuns({ taskId: task.id }).find((r) => r.status === 'skipped');
      expect(skipped!.error).toContain('one chat');
      await service.stop();
    });
  });
});
