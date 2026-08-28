import { describe, it, expect, beforeEach } from 'vitest';
import { sweepInterruptedRuns } from '../crash-recovery.js';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import { SCHEDULER_LOCK_STALE_TTL_MS, type LeaderLock } from '../scheduler-lock.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseRuns, type Db } from '@dorkos/db';
import { eq } from 'drizzle-orm';

/** Build a minimal CreateTaskStoreInput with defaults for required fields. */
function taskInput(
  overrides: Partial<CreateTaskStoreInput> & { name: string }
): CreateTaskStoreInput {
  return {
    description: 'test',
    prompt: 'test',
    filePath: `/tmp/tasks/${overrides.name.toLowerCase().replace(/\s+/g, '-')}/SKILL.md`,
    ...overrides,
  };
}

const leader: LeaderLock = {
  tryAcquire: () => true,
  heartbeat: () => {},
  release: () => {},
  isLeaderNow: true,
};

const follower: LeaderLock = {
  tryAcquire: () => false,
  heartbeat: () => {},
  release: () => {},
  isLeaderNow: false,
};

describe('sweepInterruptedRuns (DOR-1482)', () => {
  let db: Db;
  let store: TaskStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  /** Backdate a run's start, the way a run that began before this boot would be. */
  function startedAgo(runId: string, ms: number): void {
    db.update(pulseRuns)
      .set({ startedAt: new Date(Date.now() - ms).toISOString() })
      .where(eq(pulseRuns.id, runId))
      .run();
  }

  it('a follower touches nothing — another process is running these', () => {
    // THE bug (D5): every process swept the whole table on boot, so a second
    // server sharing this dorkHome marked the LEADER's live runs failed. The
    // terminal guard then threw away their real outcome, and the terminal hook
    // fired a failure notification for a run that was working perfectly.
    const task = store.createTask(taskInput({ name: 'Long one', cron: '0 * * * *' }));
    const live = store.createRun(task.id, 'scheduled');
    const alsoLive = store.createRun(task.id, 'manual');

    const result = sweepInterruptedRuns(store, follower);

    expect(result.swept).toBe(0);
    expect(store.getRun(live.id)!.status).toBe('running');
    expect(store.getRun(alsoLive.id)!.status).toBe('running');
    // And the real outcome can still be written when the run finishes.
    expect(store.updateRun(live.id, { status: 'completed' })!.status).toBe('completed');
  });

  it('with no leader lock at all, every unfinished run is this process own', () => {
    // Single-process installs and tests: nothing else could have written these.
    const task = store.createTask(taskInput({ name: 'Solo', cron: '0 * * * *' }));
    const scheduled = store.createRun(task.id, 'scheduled');
    const manual = store.createRun(task.id, 'manual');

    expect(sweepInterruptedRuns(store, null).swept).toBe(2);
    expect(store.getRun(scheduled.id)!.status).toBe('failed');
    expect(store.getRun(scheduled.id)!.error).toBe('Interrupted by server restart');
    expect(store.getRun(manual.id)!.status).toBe('failed');
  });

  it('a leader ends the scheduled runs a dead leader left behind', () => {
    // Only a leader creates a scheduled run, and leadership is exclusive — so a
    // scheduled run still saying `running` when we take over has no live owner.
    const task = store.createTask(taskInput({ name: 'Nightly', cron: '0 3 * * *' }));
    const orphan = store.createRun(task.id, 'scheduled');

    expect(sweepInterruptedRuns(store, leader).swept).toBe(1);
    expect(store.getRun(orphan.id)!.status).toBe('failed');
    expect(store.getRun(orphan.id)!.error).toBe('Interrupted by server restart');
  });

  it('a leader leaves another process live manual run alone', () => {
    // A manual run can be started by ANY process — the dev server on :6242, the
    // desktop app — and nothing on the row says which. Ending it because this
    // process happens to be the leader is the same defect wearing a hat.
    const task = store.createTask(taskInput({ name: 'By hand', cron: '0 * * * *' }));
    const live = store.createRun(task.id, 'manual');
    startedAgo(live.id, 45 * 60_000); // 45 minutes in, no deadline of its own

    const result = sweepInterruptedRuns(store, leader);

    expect(result.swept).toBe(0);
    expect(result.left).toBe(1);
    expect(store.getRun(live.id)!.status).toBe('running');
  });

  it('a leader ends any run that has outlived its own time limit', () => {
    // Whoever owns this run would have aborted it at its deadline, so past the
    // deadline plus the window in which a dead leader is still believed alive,
    // no live process can still be running it.
    const task = store.createTask(
      taskInput({ name: 'Bounded', cron: '0 * * * *', maxRuntime: 60_000 })
    );
    const overdue = store.createRun(task.id, 'manual');
    startedAgo(overdue.id, 60_000 + SCHEDULER_LOCK_STALE_TTL_MS + 5_000);
    const withinLimit = store.createRun(task.id, 'manual');

    expect(sweepInterruptedRuns(store, leader).swept).toBe(1);
    expect(store.getRun(overdue.id)!.status).toBe('failed');
    expect(store.getRun(withinLimit.id)!.status).toBe('running');
  });

  it('never ends a run THIS process is executing, whatever the rules say', () => {
    // The promotion case (DOR-1482 review). A process that stalls past the
    // lock's stale TTL — a closed laptop is enough — has its lock stolen, and
    // is promoted again on the next heartbeat. Rule 2 would then fail its OWN
    // live scheduled run: written failed while its AbortController is still
    // held, its real completion refused by the terminal guard, and a phone
    // buzzing about work that is still going.
    const task = store.createTask(taskInput({ name: 'Mine', cron: '0 * * * *' }));
    const mine = store.createRun(task.id, 'scheduled');
    const orphan = store.createRun(task.id, 'scheduled');

    const result = sweepInterruptedRuns(store, leader, new Set([mine.id]));

    expect(store.getRun(mine.id)!.status).toBe('running');
    // A genuinely orphaned run beside it is still swept.
    expect(store.getRun(orphan.id)!.status).toBe('failed');
    expect(result.swept).toBe(1);
    // And the run this process is driving can still finish for real.
    expect(store.updateRun(mine.id, { status: 'completed' })!.status).toBe('completed');
  });

  it('excludes this process own runs even with no lock at all', () => {
    const task = store.createTask(taskInput({ name: 'Solo mine', cron: '0 * * * *' }));
    const mine = store.createRun(task.id, 'manual');

    expect(sweepInterruptedRuns(store, null, new Set([mine.id])).swept).toBe(0);
    expect(store.getRun(mine.id)!.status).toBe('running');
  });

  it('never overwrites the finishedAt of a run that had already ended', () => {
    const task = store.createTask(taskInput({ name: 'Stuck', cron: '0 * * * *' }));
    const finished = store.createRun(task.id, 'scheduled');
    db.update(pulseRuns)
      .set({ status: 'running', finishedAt: '2026-07-10T02:44:10.310Z', output: 'ok' })
      .where(eq(pulseRuns.id, finished.id))
      .run();

    expect(sweepInterruptedRuns(store, leader).swept).toBe(0);
    expect(store.getRun(finished.id)!.finishedAt).toBe('2026-07-10T02:44:10.310Z');
  });
});
