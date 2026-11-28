/**
 * Scheduled tasks start turns through the turn port (spec
 * `turns-survive-restarts` §9 T12, §10 child I; DOR-5219): the scheduler, the
 * space face, admission, the `start_turn` handler, the computer face, the real
 * launch path, dispatcher and projector, over SQLite. Only the runtime
 * underneath is a double.
 *
 * What this pins: a timer's fire reaches the runtime only through the port,
 * with its task's level and brief; its run row is written from the turn the
 * record ran; a fire at the scheduler's cap waits as a `queued` run and starts
 * when a slot frees, where it used to be skipped; a cancel stops the turn; and
 * a "Run now" ask reaches the person, since the dispatcher projects the turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent, TaskRun } from '@dorkos/shared/types';
import { SLOT_WAIT_TEXT } from '@dorkos/shared/schemas';
import { runtimeRegistry } from '../../core/runtime-registry.js';
// Wires the agent facts port a launch reads the rooms folder through (fail-closed unwired).
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import { resetMessageDispatcher } from '../../session/message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../../session/message-queue-store.js';
import {
  disposeProjector,
  getOrCreateProjector,
  listPendingInteractionsAcrossSessions,
} from '../../session/session-state-projector.js';
import { createComputerTurnPort } from '../../session/turn-port/computer-turn-port.js';
import {
  getRunRecord,
  installRunRecord,
  setScheduleCap,
  turnPort,
  uninstallRunRecord,
  type TurnRun,
} from '../../runs/index.js';
import { logger } from '../../../lib/logger.js';
import { initBoundary } from '../../../lib/boundary.js';
import { registerClaudeCodeFacts } from '../../../startup/register-claude-code-facts.js';
import { TaskStore } from '../task-store.js';
import { TaskSchedulerService } from '../task-scheduler-service.js';
import { portTaskTurns } from '../execution/task-turns.js';
import { isTerminalRunStatus } from '../lifecycle/run-statuses.js';
import { taskInput, type Dispatchable } from './task-scheduler/task-scheduler.fixtures.js';

registerClaudeCodeFacts();

/** Two on-time fires of an hourly task, an hour apart. */
const FIRST_HOUR = new Date(1_699_999_200_000);
const NEXT_HOUR = new Date(1_699_999_200_000 + 3_600_000);

let db: Db;
let store: TaskStore;
let runtime: FakeAgentRuntime;
let scheduler: TaskSchedulerService;
let errors: { mock: { calls: unknown[][] } };
/** What the runtime was handed, turn by turn. */
let heard: string[];
let releaseLongTurn: (() => void) | undefined;

/** A turn that answers at once. */
const quick = async function* (content: string): AsyncGenerator<StreamEvent> {
  heard.push(content);
  yield { type: 'text_delta', data: { text: 'all done' } };
  yield { type: 'done', data: {} };
};

/** A turn that works until the test lets it go. */
const long = async function* (content: string): AsyncGenerator<StreamEvent> {
  heard.push(content);
  yield { type: 'text_delta', data: { text: 'working' } };
  await new Promise<void>((resolve) => {
    releaseLongTurn = resolve;
  });
  yield { type: 'done', data: {} };
};

/** The task run's turn, as the run record holds it. */
function turnRunOf(run: TaskRun): TurnRun | undefined {
  const record = getRunRecord()!;
  return [...record.store.listForChat(run.sessionId ?? '')].at(0);
}

/** A scheduled fire of `task` at `when`. */
function fire(task: ReturnType<TaskStore['createTask']>, when: Date): Promise<void> {
  return (scheduler as unknown as Dispatchable).dispatch(task, when);
}

/** The task's runs. */
function runsOf(taskId: string): TaskRun[] {
  return store.listRuns({ taskId });
}

beforeEach(async () => {
  db = createTestDb();
  heard = [];
  releaseLongTurn = undefined;
  runtimeRegistry.setDb(db);
  await initBoundary('/');
  store = new TaskStore(db);
  setMessageQueueStore(new MessageQueueStore(db));
  registerTestHomes([]);
  runtime = new FakeAgentRuntime('task-port-demo');
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault(runtime.type);
  errors = vi.spyOn(logger, 'error');
  const computer = createComputerTurnPort({
    meshCore: () => undefined,
    roomSessionPlace: () => undefined,
  });
  installRunRecord(db, {
    epoch: '01BOOTEPOCHTASKS0000000000',
    computer: () => computer,
    admission: { admission: { pausedAgent: () => undefined, machineFull: () => false } },
  });
  getRunRecord()!.worker.start();
  scheduler = new TaskSchedulerService({
    store,
    runtimes: runtimeRegistry,
    config: { maxConcurrentRuns: 1, retentionCount: 100, mayFire: true, firingReason: 'test' },
    // Wired as startup wires them.
    turns: portTaskTurns(turnPort),
    scheduleCap: setScheduleCap,
  });
  await scheduler.start();
});

afterEach(async () => {
  releaseLongTurn?.();
  await scheduler.stop();
  // The record never refused a write, and the one-live-run index never fired (§4.7).
  expect(
    errors.mock.calls.some((call) => String(call[0]).includes('[runs]')),
    'the run record complained'
  ).toBe(false);
  uninstallRunRecord();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  clearTestHomes();
  vi.restoreAllMocks();
});

describe('a scheduled task’s turn goes through the turn port', () => {
  it('starts a timer’s fire through the port and writes its row from the run’s turn', async () => {
    // Purpose: fails if the scheduler drove the runtime itself, or the row did not follow the turn.
    runtime.withScenarios([quick]);
    const task = store.createTask(
      taskInput({ name: 'Morning brief', cron: '0 * * * *', prompt: 'Sum up the inbox' })
    );

    await fire(task, FIRST_HOUR);

    const [run] = runsOf(task.id);
    await vi.waitFor(() => expect(isTerminalRunStatus(store.getRun(run!.id)!.status)).toBe(true));
    const done = store.getRun(run!.id)!;
    expect(done).toMatchObject({ status: 'completed', outputSummary: 'all done' });
    expect(heard).toEqual(['Sum up the inbox']);
    // The turn ran as a run of the record, started by the schedule, with nobody watching.
    const turn = turnRunOf(done)!;
    expect(turn).toMatchObject({
      origin: { kind: 'schedule' },
      sourceRef: `task-run:${run!.id}`,
      status: expect.stringMatching(/^(ended|settled)$/),
      ending: 'completed',
    });
    const sent = runtime.sendMessage.mock.calls[0]![2]!;
    expect(sent).toMatchObject({
      permissionMode: task.permissionMode,
      contextPlace: 'task',
      unattended: true,
      unattendedApprovals: true,
    });
    expect(sent.systemPromptAppend).toContain('TASK SCHEDULER CONTEXT');
  });

  it('holds a fire at the cap as a queued run and starts it when the slot frees', async () => {
    // Purpose: fails if a fire at the scheduler's cap is skipped or run beside the one ahead.
    runtime.withScenarios([long, quick]);
    const first = store.createTask(
      taskInput({ name: 'Long sweep', cron: '0 * * * *', prompt: 'Sweep the repo' })
    );
    const second = store.createTask(
      taskInput({ name: 'Short note', cron: '0 * * * *', prompt: 'Write the note' })
    );

    // A fire resolves once its run is over, so neither is awaited here.
    const firstFire = fire(first, FIRST_HOUR);
    await vi.waitFor(() => expect(heard).toEqual(['Sweep the repo']));
    const secondFire = fire(second, NEXT_HOUR);

    // Not skipped: its row runs, says it waits, and its turn waits for a slot.
    await vi.waitFor(() => expect(runsOf(second.id)).toHaveLength(1));
    const [waiting] = runsOf(second.id);
    expect(waiting).toMatchObject({ status: 'running' });
    await vi.waitFor(() => {
      expect(turnRunOf(store.getRun(waiting!.id)!)).toMatchObject({
        status: 'queued',
        waitReason: 'machine_full',
      });
      expect(store.getRun(waiting!.id)!.outputSummary).toBe(SLOT_WAIT_TEXT);
    });
    expect(heard).toEqual(['Sweep the repo']);

    // The first turn ends: its slot frees, and the waiting fire starts at once.
    releaseLongTurn!();
    await Promise.all([firstFire, secondFire]);
    expect(store.getRun(waiting!.id)!.status).toBe('completed');
    expect(heard).toEqual(['Sweep the repo', 'Write the note']);
    expect(store.getRun(runsOf(first.id)[0]!.id)!.status).toBe('completed');
    expect(turnRunOf(store.getRun(waiting!.id)!)).toMatchObject({ ending: 'completed' });
  });

  it('stops a running turn through the port when the run is cancelled', async () => {
    // Purpose: fails if a cancel only abandons the events and leaves the turn running.
    runtime.withScenarios([long]);
    runtime.interruptQuery.mockImplementation(async (sessionId) => {
      releaseLongTurn?.();
      return { outcome: 'acked', runtime: runtime.type, ...(sessionId ? {} : {}) };
    });
    const task = store.createTask(taskInput({ name: 'Cancel me', cron: '0 * * * *' }));

    const fired = fire(task, FIRST_HOUR);
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    const [run] = runsOf(task.id);
    await vi.waitFor(() => expect(turnRunOf(store.getRun(run!.id)!)?.status).toBe('running'));

    await scheduler.cancelRun(run!.id);
    await fired;

    expect(store.getRun(run!.id)!.status).toBe('cancelled');
    expect(runtime.interruptQuery).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(turnRunOf(store.getRun(run!.id)!)).toMatchObject({ ending: 'stopped' })
    );
  });

  it('puts a Run now’s ask in front of the person, on the chat its row names', async () => {
    // Purpose: fails if an attended run's turn is projected nowhere, so its card reaches nobody.
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    runtime.withScenarios([
      async function* (content: string): AsyncGenerator<StreamEvent> {
        heard.push(content);
        yield {
          type: 'approval_required',
          data: {
            toolCallId: 'tool-1',
            toolName: 'Bash',
            input: JSON.stringify({ command: 'chmod 640 /tmp/x' }),
            timeoutMs: 600_000,
            startedAt: Date.now(),
            hasSuggestions: false,
          },
        } as unknown as StreamEvent;
        await answered;
        yield { type: 'text_delta', data: { text: 'tightened' } };
        yield { type: 'done', data: {} };
      },
    ]);
    const task = store.createTask(taskInput({ name: 'Tighten a file', cron: '0 3 * * *' }));

    const run = await scheduler.triggerManualRun(task.id);
    await vi.waitFor(() => expect(listPendingInteractionsAcrossSessions()).toHaveLength(1));

    const [pending] = listPendingInteractionsAcrossSessions();
    expect(pending!.sessionId).toBe(store.getRun(run!.id)!.sessionId);
    // Somebody is watching: the turn holds for the card rather than refusing it.
    expect(runtime.sendMessage.mock.calls[0]![2]).not.toHaveProperty('unattendedApprovals');
    getOrCreateProjector(pending!.sessionId).resolveInteraction('tool-1', 'approved');
    answer();
    await vi.waitFor(() => expect(store.getRun(run!.id)!.status).toBe('completed'));
    disposeProjector(pending!.sessionId);
  });
});
