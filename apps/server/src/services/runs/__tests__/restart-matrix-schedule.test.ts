/**
 * Tier A, a scheduled task's run a restart cut (spec `turns-survive-restarts`
 * §7.3 steps 4 to 6, §8 K15; DOR-5496). The scheduler that read the turn died
 * with its boot, so the run record ends the task's run itself, with the turn
 * run's ending, through the scheduler's word source: the task's run history
 * says what happened, its terminal consumers hear it once, and nothing
 * continues. Past the age bound the ending is written and nothing wakes. The
 * scheduler's boot sweep leaves alone what the record still owes, so one writer
 * ends each task run.
 *
 * Booted as startup orders it: the record, then Tasks (whose door registers
 * the scheduler's source), then recovery, then the worker, then the sweep.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, notifications } from '@dorkos/db';
import { createAwakeClock } from '@dorkos/shared/awake-clock';
import type { TaskRun } from '@dorkos/shared/types';
import { RUNS } from '../../../config/constants.js';
import { resetMessageDispatcher } from '../../session/message-dispatcher.js';
import { disposeProjector } from '../../session/session-state-projector.js';
import { TaskStore } from '../../tasks/task-store.js';
import { sweepInterruptedRuns } from '../../tasks/crash-recovery.js';
import { portTaskTurns, type TaskTurns } from '../../tasks/execution/task-turns.js';
import { turnPort, uninstallRunRecord } from '../index.js';
import { RUN_LEASE_MS } from '../run-store.js';
import {
  AGENT,
  boot,
  deadBoot,
  h,
  kill,
  pass,
  runningRun,
  setUpHarness,
  tearDownHarness,
} from './restart-harness.js';

let tasks: TaskStore;
/** Every task run the terminal consumers heard: the schedule's notice and its agent's beat. */
let heard: TaskRun[];
/** Every task run the schedule's room notice heard. */
let noticed: TaskRun[];

/** A scheduled fire's task run, `running`. */
function taskRun(): TaskRun {
  const task = tasks.createTask({
    name: `nightly-${crypto.randomUUID().slice(0, 8)}`,
    description: 'test',
    prompt: 'tidy the inbox',
    filePath: `/tmp/tasks/${crypto.randomUUID()}/SKILL.md`,
  });
  return tasks.createRun(task.id, 'scheduled');
}

/** The scheduler's source for a task run's words. */
const sourceOf = (run: TaskRun): string => `task-run:${run.id}`;

/** The next process, as startup orders it: the record, Tasks' door, recovery. */
function bootWithTasks(): TaskTurns {
  boot({}, { recover: false });
  const turns = portTaskTurns(turnPort, tasks);
  h.record!.recovery.recoverAtBoot();
  return turns;
}

/** The scheduler's boot sweep, as `endInterruptedRuns` runs it on a single process. */
function sweep(turns?: TaskTurns) {
  const clock = createAwakeClock();
  clock.dispose();
  return sweepInterruptedRuns(tasks, null, new Set(), clock, turns);
}

/** Every inbox row of the restart notice. */
function restartRows() {
  return h.db.select().from(notifications).where(eq(notifications.kind, 'turn.restarted')).all();
}

beforeEach(async () => {
  await setUpHarness();
  tasks = new TaskStore(h.db);
  heard = [];
  noticed = [];
  tasks.setOnRunTerminal((run) => heard.push(run));
  tasks.runNotices.terminal = (run) => noticed.push(run);
  h.declares.continuesInterruptedTurn = false;
});

afterEach(async () => {
  await tearDownHarness();
});

describe('K15: a scheduled turn a restart cut', () => {
  it('ends its task run with the restart, told once, and no person’s notice beside it', async () => {
    const fire = taskRun();
    const turn = runningRun(deadBoot().store, {
      origin: { kind: 'schedule' },
      sourceRef: sourceOf(fire),
    });
    kill();
    const turns = bootWithTasks();
    await pass();

    expect(h.record!.store.get(turn.id)).toMatchObject({
      ending: 'process_died',
      endingDetail: { restart: 'not_resumable' },
    });
    expect(tasks.getRun(fire.id)).toMatchObject({
      status: 'failed',
      error: 'Interrupted by server restart',
    });
    expect(heard.map((run) => run.id)).toEqual([fire.id]);
    expect(noticed.map((run) => run.id)).toEqual([fire.id]);
    expect(restartRows()).toEqual([]);
    expect(sweep(turns).swept).toBe(0);

    // A second boot decides nothing twice and tells nothing twice.
    kill();
    sweep(bootWithTasks());
    await pass();
    expect(heard).toHaveLength(1);
    expect(tasks.getRun(fire.id)?.error).toBe('Interrupted by server restart');
  });

  it('never continues, even on a runtime that declares it can: its task run already settled', async () => {
    h.declares.continuesInterruptedTurn = true;
    const fire = taskRun();
    const turn = runningRun(deadBoot().store, {
      origin: { kind: 'schedule' },
      sourceRef: sourceOf(fire),
    });
    kill();
    bootWithTasks();
    await pass();

    expect(h.record!.store.get(turn.id)?.endingDetail.restart).toBe('quiet');
    const continuations = h
      .record!.store.listForChat(h.sessionId)
      .filter((run) => run.continuesRunId === turn.id);
    expect(continuations).toEqual([]);
    expect(h.answered).toEqual([]);
    expect(tasks.getRun(fire.id)?.status).toBe('failed');
    expect(heard).toHaveLength(1);
  });

  it('past the age bound: its ending is written, and nothing is told or woken', async () => {
    const fire = taskRun();
    runningRun(deadBoot().store, { origin: { kind: 'schedule' }, sourceRef: sourceOf(fire) });
    kill();
    h.now += 2 * RUNS.RESTART_AGE_BOUND_MS;
    bootWithTasks();
    await pass();

    expect(tasks.getRun(fire.id)).toMatchObject({
      status: 'failed',
      error: 'Interrupted by server restart',
    });
    expect(heard).toEqual([]);
    expect(noticed).toEqual([]);
    expect(restartRows()).toEqual([]);
    expect(h.answered).toEqual([]);
  });

  it('a turn whose turn_end was seen before the kill ends its task run with that ending', async () => {
    const fire = taskRun();
    const dying = deadBoot();
    const turn = runningRun(dying.store, {
      origin: { kind: 'schedule' },
      sourceRef: sourceOf(fire),
    });
    dying.store.annotate(turn.id, { ending: 'completed' });
    kill();
    bootWithTasks();
    await pass();

    expect(h.record!.store.get(turn.id)?.ending).toBe('completed');
    expect(tasks.getRun(fire.id)?.status).toBe('completed');
    expect(heard.map((run) => run.status)).toEqual(['completed']);
  });

  it('a start the restart lost ends its task run as not started, told once', async () => {
    const fire = taskRun();
    const { runId } = deadBoot().port.start({
      sessionId: h.sessionId,
      cwd: AGENT.home,
      content: 'tidy the inbox',
      origin: { kind: 'schedule' },
      tier: 'owner',
      sourceRef: sourceOf(fire),
      task: { permissionMode: 'acceptEdits' },
    });
    kill();
    const turns = bootWithTasks();
    // Its start is still open: the record owes the task run its ending.
    expect(sweep(turns).swept).toBe(0);
    await pass();

    expect(h.record!.store.get(runId)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'start_lost' },
    });
    expect(tasks.getRun(fire.id)).toMatchObject({
      status: 'failed',
      error: 'The run did not start: DorkOS restarted before it began.',
    });
    expect(heard).toHaveLength(1);
    expect(restartRows()).toEqual([]);
    expect(h.answered).toEqual([]);
  });

  it('a quick crash: the boot sweep leaves the run the record owes, and the record ends it once its lease runs out', async () => {
    const fire = taskRun();
    const unported = taskRun();
    runningRun(deadBoot().store, { origin: { kind: 'schedule' }, sourceRef: sourceOf(fire) });
    // Killed with its lease still running: this boot cannot call the run dead yet.
    resetMessageDispatcher();
    uninstallRunRecord();
    disposeProjector(h.sessionId);
    const turns = bootWithTasks();

    // The sweep ends only the run whose turn never reached the port.
    expect(sweep(turns).swept).toBe(1);
    expect(tasks.getRun(fire.id)?.status).toBe('running');
    expect(tasks.getRun(unported.id)?.status).toBe('failed');

    // Its lease runs out: the worker's next pass retires and decides it.
    h.now += RUN_LEASE_MS + 1;
    await pass();
    expect(tasks.getRun(fire.id)).toMatchObject({
      status: 'failed',
      error: 'Interrupted by server restart',
    });
    expect(heard.map((run) => run.id)).toEqual([fire.id]);
  });
});
