import { describe, it, expect, beforeEach } from 'vitest';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { pulseSchedules, pulseRuns, pulseDispatchLog } from '@dorkos/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { eq } from 'drizzle-orm';

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

describe('TaskStore', () => {
  let store: TaskStore;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  // === Task CRUD ===

  describe('task CRUD', () => {
    it('starts with empty tasks', () => {
      expect(store.getTasks()).toEqual([]);
    });

    it('creates a task', () => {
      const task = store.createTask(
        taskInput({
          name: 'Daily cleanup',
          description: 'Clean up temp files',
          prompt: 'Clean up temp files',
          cron: '0 2 * * *',
        })
      );

      expect(task.id).toBeDefined();
      expect(task.name).toBe('Daily cleanup');
      expect(task.prompt).toBe('Clean up temp files');
      expect(task.cron).toBe('0 2 * * *');
      expect(task.enabled).toBe(true);
      expect(task.status).toBe('active');
      expect(task.permissionMode).toBe('acceptEdits');
      expect(task.timezone).toBe('UTC');
      expect(task.maxRuntime).toBeNull();
      expect(task.nextRun).toBeNull();
    });

    it('carries an agent proposal — the reason, the session, the directory (DOR-1394)', () => {
      const created = store.createTask(
        taskInput({
          name: 'Nightly sweep',
          prompt: 'sweep the backlog',
          cron: '0 3 * * *',
          reason: 'The overnight backlog needs sweeping before you start.',
          proposedBySessionId: 'ses-42',
          proposedByAgentPath: '/tmp/agents/nightly-bot',
        })
      );

      // Round-tripped through SQLite, not just echoed back by the insert.
      const read = store.getTask(created.id)!;
      expect(read.reason).toBe('The overnight backlog needs sweeping before you start.');
      expect(read.proposedBySessionId).toBe('ses-42');
      expect(read.proposedByAgentPath).toBe('/tmp/agents/nightly-bot');
      // Both resolved by whoever READS the task, so the store leaves them empty
      // rather than caching an answer that can go stale.
      expect(read.proposedByName).toBeNull();
      expect(read.nextRuns).toEqual([]);
    });

    it('leaves provenance null for a task nobody proposed', () => {
      const created = store.createTask(
        taskInput({ name: 'Operator task', prompt: 'do a thing', cron: '0 3 * * *' })
      );

      const read = store.getTask(created.id)!;
      expect(read.reason).toBeNull();
      expect(read.proposedBySessionId).toBeNull();
      expect(read.proposedByAgentPath).toBeNull();
    });

    it('keeps a proposal intact when the task is later approved', () => {
      const created = store.createTask(
        taskInput({
          name: 'Nightly sweep',
          prompt: 'sweep the backlog',
          cron: '0 3 * * *',
          reason: 'The overnight backlog needs sweeping.',
          proposedByAgentPath: '/tmp/agents/nightly-bot',
        })
      );
      store.updateTask(created.id, { status: 'pending_approval' });

      // Approving is a status write; it must not erase the case the agent made
      // for the schedule, which is the record of why it exists at all.
      const approved = store.updateTask(created.id, { status: 'active' })!;
      expect(approved.reason).toBe('The overnight backlog needs sweeping.');
      expect(approved.proposedByAgentPath).toBe('/tmp/agents/nightly-bot');
    });

    it('persists tasks in the database', () => {
      store.createTask(
        taskInput({
          name: 'Test',
          description: 'Run tests',
          prompt: 'Run tests',
          cron: '*/5 * * * *',
        })
      );

      // Verify directly via Drizzle query
      const rows = db.select().from(pulseSchedules).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Test');
    });

    it('reads created tasks back', () => {
      store.createTask(taskInput({ name: 'A', prompt: 'a', cron: '* * * * *' }));
      store.createTask(taskInput({ name: 'B', prompt: 'b', cron: '* * * * *' }));

      const all = store.getTasks();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.name)).toEqual(['A', 'B']);
    });

    it('gets a single task by ID', () => {
      const created = store.createTask(taskInput({ name: 'One', prompt: 'p', cron: '* * * * *' }));
      const found = store.getTask(created.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('One');
    });

    it('returns null for missing task', () => {
      expect(store.getTask('nonexistent')).toBeNull();
    });

    it('updates a task', () => {
      const created = store.createTask(taskInput({ name: 'Old', prompt: 'p', cron: '* * * * *' }));
      const updated = store.updateTask(created.id, { name: 'New', enabled: false });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('New');
      expect(updated!.enabled).toBe(false);
      expect(updated!.prompt).toBe('p');
    });

    it('turns a cleared cron into the on-demand empty string, not null', () => {
      // `pulse_schedules.cron` is NOT NULL and `''` is what "on demand" means in
      // it — `createTask` and `upsertFromFile` both already write `?? ''`. This
      // path did not, so `{ cron: null }` threw a NOT NULL constraint error
      // straight out of the store. The cockpit's edit form sends exactly that
      // on every save of a task with no cron (`TaskFormInner.tsx`).
      const created = store.createTask(taskInput({ name: 'OnDemand', prompt: 'p', cron: '' }));

      const updated = store.updateTask(created.id, { cron: null, prompt: 'edited' });

      expect(updated).not.toBeNull();
      expect(updated!.cron).toBe('');
      expect(updated!.prompt).toBe('edited');
    });

    it('returns null when updating nonexistent task', () => {
      expect(store.updateTask('nope', { name: 'X' })).toBeNull();
    });

    it('deletes a task', () => {
      const created = store.createTask(taskInput({ name: 'Del', prompt: 'p', cron: '* * * * *' }));
      expect(store.deleteTask(created.id)).toBe(true);
      expect(store.getTasks()).toHaveLength(0);
    });

    it('returns false when deleting nonexistent task', () => {
      expect(store.deleteTask('nope')).toBe(false);
    });

    it('deletes a task that has run history, taking its runs with it', () => {
      const created = store.createTask(taskInput({ name: 'Has runs' }));
      store.createRun(created.id, 'manual');
      store.createRun(created.id, 'scheduled');

      expect(() => store.deleteTask(created.id)).not.toThrow();
      expect(store.getTasks()).toHaveLength(0);
      expect(
        db.select().from(pulseRuns).where(eq(pulseRuns.scheduleId, created.id)).all()
      ).toHaveLength(0);
    });

    it('deletes the task dispatch-dedup rows too, so they cannot outlive the task', () => {
      const created = store.createTask(taskInput({ name: 'Has dispatches' }));
      const other = store.createTask(taskInput({ name: 'Untouched' }));
      store.claimScheduledRun(created.id, 1_700_000_000_000, { status: 'running' });
      store.claimScheduledRun(other.id, 1_700_000_000_000, { status: 'running' });

      store.deleteTask(created.id);

      const remaining = db.select().from(pulseDispatchLog).all();
      expect(remaining.map((r) => r.taskId)).toEqual([other.id]);
    });

    it('leaves other tasks runs untouched', () => {
      const doomed = store.createTask(taskInput({ name: 'Doomed' }));
      const survivor = store.createTask(taskInput({ name: 'Survivor' }));
      store.createRun(doomed.id, 'manual');
      const keptRun = store.createRun(survivor.id, 'manual');

      store.deleteTask(doomed.id);

      expect(store.getRun(keptRun.id)).not.toBeNull();
      expect(db.select().from(pulseRuns).all()).toHaveLength(1);
    });
  });

  // === Run CRUD ===

  describe('run CRUD', () => {
    // Helper: create a task so FK constraint is satisfied
    function createTestTask(id?: string) {
      const task = store.createTask(
        taskInput({
          name: `Task ${id ?? 'test'}`,
          prompt: 'test prompt',
          cron: '* * * * *',
        })
      );
      return task.id;
    }

    it('creates a run with running status', () => {
      const taskId = createTestTask();
      const run = store.createRun(taskId, 'scheduled');
      expect(run.id).toBeDefined();
      expect(run.scheduleId).toBe(taskId);
      expect(run.status).toBe('running');
      expect(run.trigger).toBe('scheduled');
      expect(run.startedAt).toBeDefined();
      expect(run.finishedAt).toBeNull();
    });

    it('gets a run by ID', () => {
      const taskId = createTestTask();
      const created = store.createRun(taskId, 'manual');
      const found = store.getRun(created.id);
      expect(found).not.toBeNull();
      expect(found!.trigger).toBe('manual');
    });

    it('returns null for missing run', () => {
      expect(store.getRun('nonexistent')).toBeNull();
    });

    it('updates run fields', () => {
      const taskId = createTestTask();
      const run = store.createRun(taskId, 'scheduled');
      const updated = store.updateRun(run.id, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        durationMs: 5000,
        outputSummary: 'All good',
        sessionId: 'session-123',
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.durationMs).toBe(5000);
      expect(updated!.outputSummary).toBe('All good');
      expect(updated!.sessionId).toBe('session-123');
    });

    it('returns null when updating nonexistent run', () => {
      expect(store.updateRun('nope', { status: 'failed' })).toBeNull();
    });

    it('lists runs with pagination', () => {
      const taskId = createTestTask();
      for (let i = 0; i < 5; i++) {
        store.createRun(taskId, 'scheduled');
      }

      const all = store.listRuns({ limit: 10 });
      expect(all).toHaveLength(5);

      const page = store.listRuns({ limit: 2, offset: 0 });
      expect(page).toHaveLength(2);

      const page2 = store.listRuns({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
    });

    it('lists runs filtered by task', () => {
      const taskId1 = createTestTask('1');
      const taskId2 = createTestTask('2');
      store.createRun(taskId1, 'scheduled');
      store.createRun(taskId2, 'scheduled');
      store.createRun(taskId1, 'manual');

      const task1Runs = store.listRuns({ taskId: taskId1 });
      expect(task1Runs).toHaveLength(2);

      const task2Runs = store.listRuns({ taskId: taskId2 });
      expect(task2Runs).toHaveLength(1);
    });

    it('gets running runs', () => {
      const taskId = createTestTask();
      const r1 = store.createRun(taskId, 'scheduled');
      store.createRun(taskId, 'scheduled');
      store.updateRun(r1.id, { status: 'completed' });

      const running = store.getRunningRuns();
      expect(running).toHaveLength(1);
    });

    it('counts runs', () => {
      const taskId1 = createTestTask('1');
      const taskId2 = createTestTask('2');
      store.createRun(taskId1, 'scheduled');
      store.createRun(taskId1, 'scheduled');
      store.createRun(taskId2, 'scheduled');

      expect(store.countRuns()).toBe(3);
      expect(store.countRuns(taskId1)).toBe(2);
      expect(store.countRuns(taskId2)).toBe(1);
    });
  });

  // === resolveTaskOrigins (session-origin-legibility) ===

  describe('resolveTaskOrigins', () => {
    it('resolves the task name for a session id backed by a Pulse run', () => {
      const task = store.createTask(
        taskInput({ name: 'daily-digest', prompt: 'p', cron: '0 9 * * *' })
      );
      const run = store.createRun(task.id, 'scheduled');
      store.updateRun(run.id, { sessionId: 'session-with-run' });

      const origins = store.resolveTaskOrigins(['session-with-run', 'unrelated-id']);

      expect(origins.size).toBe(1);
      expect(origins.get('session-with-run')).toEqual({ taskName: 'daily-digest' });
      expect(origins.has('unrelated-id')).toBe(false);
    });

    it('returns an empty map without querying for an empty input', () => {
      const origins = store.resolveTaskOrigins([]);
      expect(origins.size).toBe(0);
    });
  });

  // === Terminal-status guard (DOR-248) ===

  describe('updateRun terminal guard', () => {
    function createTestTask() {
      return store.createTask(
        taskInput({ name: 'Terminal Guard', prompt: 'test', cron: '* * * * *' })
      ).id;
    }

    it('does not let a post-terminal write downgrade status back to running', () => {
      // Reproduces the DOR-248 race: the handler writes the terminal status
      // first (synchronous in-process relay delivery), then a delayed caller
      // (the scheduler's post-publish write) tries to stamp 'running' again.
      const taskId = createTestTask();
      const run = store.createRun(taskId, 'scheduled');

      const completed = store.updateRun(run.id, {
        status: 'completed',
        finishedAt: '2026-07-10T02:44:10.310Z',
        durationMs: 10_307,
        outputSummary: 'ok',
        sessionId: 'session-1',
      });
      expect(completed!.status).toBe('completed');

      const stomped = store.updateRun(run.id, { status: 'running' });

      expect(stomped!.status).toBe('completed');
      expect(stomped!.finishedAt).toBe('2026-07-10T02:44:10.310Z');
      expect(stomped!.durationMs).toBe(10_307);
      expect(stomped!.outputSummary).toBe('ok');

      // Persisted state matches the returned value — this isn't just an
      // in-memory echo of the stale `existing` object.
      const reread = store.getRun(run.id);
      expect(reread!.status).toBe('completed');
      expect(reread!.finishedAt).toBe('2026-07-10T02:44:10.310Z');
    });

    it('ignores any update once a run is failed', () => {
      const taskId = createTestTask();
      const run = store.createRun(taskId, 'scheduled');
      store.updateRun(run.id, {
        status: 'failed',
        finishedAt: '2026-07-10T00:00:00.000Z',
        error: 'boom',
      });

      store.updateRun(run.id, { status: 'running', error: 'clobbered?' });

      const found = store.getRun(run.id);
      expect(found!.status).toBe('failed');
      expect(found!.error).toBe('boom');
    });

    it('ignores any update once a run is cancelled', () => {
      const taskId = createTestTask();
      const run = store.createRun(taskId, 'scheduled');
      store.updateRun(run.id, { status: 'cancelled', finishedAt: '2026-07-10T00:00:00.000Z' });

      store.updateRun(run.id, { status: 'completed', outputSummary: 'too late' });

      const found = store.getRun(run.id);
      expect(found!.status).toBe('cancelled');
      expect(found!.outputSummary).toBeNull();
    });

    it('still allows updates while a run is running (non-terminal)', () => {
      const taskId = createTestTask();
      const run = store.createRun(taskId, 'scheduled');

      const updated = store.updateRun(run.id, { sessionId: 'session-mid-run' });

      expect(updated!.status).toBe('running');
      expect(updated!.sessionId).toBe('session-mid-run');
    });
  });

  // === Retention pruning ===

  describe('pruneRuns', () => {
    function createTestTask() {
      return store.createTask(taskInput({ name: 'Prune Test', prompt: 'test', cron: '* * * * *' }))
        .id;
    }

    /**
     * A run that is OVER — which is the only kind retention may delete.
     *
     * These cases used to build their history out of bare `createRun` calls,
     * which leaves every row `running`. That made them assert the exact defect
     * DOR-1482 found: retention deleting live work. Pruning ran once at boot
     * back then, immediately after a sweep that had ended every running row, so
     * nothing could observe it — but the assertion was wrong even then.
     */
    function finishedRun(taskId: string): string {
      const run = store.createRun(taskId, 'scheduled');
      store.updateRun(run.id, { status: 'completed', finishedAt: new Date().toISOString() });
      return run.id;
    }

    it('prunes old runs keeping only retentionCount', () => {
      const taskId = createTestTask();
      for (let i = 0; i < 5; i++) finishedRun(taskId);

      const pruned = store.pruneRuns(taskId, 2);
      expect(pruned).toBe(3);
      expect(store.countRuns(taskId)).toBe(2);
    });

    it('never deletes a run that has not finished, however old it is', () => {
      // THE bug (DOR-1482 review): with retention on an hourly timer, a live run
      // that has fallen behind the retention window was deleted mid-flight. The
      // scheduler's terminal write then found no row, so the outcome was lost,
      // the run-terminal hook never fired, and the concurrency slot the run was
      // holding was handed back — the cap growing on its own.
      const taskId = createTestTask();
      const live = store.createRun(taskId, 'scheduled');
      // Plenty of newer, finished history: the live run is nowhere near the
      // newest `retentionCount` rows.
      for (let i = 0; i < 5; i++) finishedRun(taskId);

      const pruned = store.pruneRuns(taskId, 2);

      expect(store.getRun(live.id)).not.toBeNull();
      expect(store.getRun(live.id)!.status).toBe('running');
      // Only finished rows outside the newest two were deleted — five finished
      // rows, two kept — and the live one was never a candidate.
      expect(pruned).toBe(3);
      // And the run can still be completed for real afterwards.
      expect(store.updateRun(live.id, { status: 'completed' })!.status).toBe('completed');
    });

    it('spends every keeper slot on history, never on the run in flight', () => {
      // A run that just started is the NEWEST row in the table, so it used to
      // win a keeper slot — and a slot spent on a run that the delete predicate
      // protects anyway is a slot not spent on history. "Keep the last 2" kept
      // 1 whenever a run was in flight. Timestamps are set explicitly because
      // `created_at` is an ISO string at millisecond resolution with no
      // tiebreaker: rows written in the same millisecond order arbitrarily,
      // which is what made this flake rather than fail outright.
      const taskId = createTestTask();
      const finished = [finishedRun(taskId), finishedRun(taskId), finishedRun(taskId)];
      finished.forEach((id, i) => {
        db.update(pulseRuns)
          .set({ createdAt: `2026-08-24T12:00:0${i}.000Z` })
          .where(eq(pulseRuns.id, id))
          .run();
      });
      const live = store.createRun(taskId, 'scheduled');
      db.update(pulseRuns)
        .set({ createdAt: '2026-08-24T12:00:09.000Z' }) // newest of all
        .where(eq(pulseRuns.id, live.id))
        .run();

      // Only the oldest finished run goes: the other two are the retained
      // history, and the live run was never a candidate for either list.
      expect(store.pruneRuns(taskId, 2)).toBe(1);
      expect(store.getRun(live.id)!.status).toBe('running');
      expect(finished.filter((id) => store.getRun(id) !== null)).toHaveLength(2);
    });

    it('prunes a skipped run like any other finished one', () => {
      const taskId = createTestTask();
      store.claimScheduledRun(taskId, 1_700_000_000_000, {
        status: 'skipped',
        reason: 'DorkOS was busy',
      });
      for (let i = 0; i < 3; i++) finishedRun(taskId);

      expect(store.pruneRuns(taskId, 1)).toBe(3);
    });

    it('keeps a live run even when retentionCount is 0', () => {
      // The branch that used to delete the task's whole history unconditionally.
      const taskId = createTestTask();
      const live = store.createRun(taskId, 'scheduled');
      finishedRun(taskId);

      expect(store.pruneRuns(taskId, 0)).toBe(1);
      expect(store.getRun(live.id)!.status).toBe('running');
    });

    it('does not prune other tasks', () => {
      const taskId1 = createTestTask();
      const taskId2 = store.createTask(
        taskInput({ name: 'Other', prompt: 'test', cron: '* * * * *' })
      ).id;

      for (let i = 0; i < 3; i++) finishedRun(taskId1);
      finishedRun(taskId2);

      store.pruneRuns(taskId1, 1);
      expect(store.countRuns(taskId1)).toBe(1);
      expect(store.countRuns(taskId2)).toBe(1);
    });

    it('returns 0 when nothing to prune', () => {
      const taskId = createTestTask();
      finishedRun(taskId);
      expect(store.pruneRuns(taskId, 10)).toBe(0);
    });
  });

  // === Crash recovery ===

  describe('markRunsInterrupted', () => {
    /**
     * What the crash sweep passes: every run the store currently believes is
     * running. Which of those a given process is ENTITLED to end is decided in
     * `crash-recovery.ts` and tested there (DOR-1482); these cases are about
     * what the write itself does once that decision is made.
     */
    function everyRunningRun() {
      return store.getRunningRuns().map((run) => run.id);
    }

    function createTestTask() {
      return store.createTask(
        taskInput({ name: 'Recovery Test', prompt: 'test', cron: '* * * * *' })
      ).id;
    }

    it('marks running runs as failed', () => {
      const taskId = createTestTask();
      store.createRun(taskId, 'scheduled');
      store.createRun(taskId, 'scheduled');

      const changed = store.markRunsInterrupted(everyRunningRun());
      expect(changed).toBe(2);

      const running = store.getRunningRuns();
      expect(running).toHaveLength(0);

      const runs = store.listRuns();
      expect(runs.every((r) => r.status === 'failed')).toBe(true);
      expect(runs.every((r) => r.error === 'Interrupted by server restart')).toBe(true);
    });

    it('does not affect completed runs', () => {
      const taskId = createTestTask();
      const run = store.createRun(taskId, 'scheduled');
      store.updateRun(run.id, { status: 'completed' });

      const changed = store.markRunsInterrupted(everyRunningRun());
      expect(changed).toBe(0);

      const found = store.getRun(run.id);
      expect(found!.status).toBe('completed');
    });

    it('DOR-249: does not clobber a finished run stuck in "running" status', () => {
      // Simulates the DOR-248 failure mode directly at the row level (belt
      // and suspenders — the sweep must not assume every writer already
      // carries the updateRun terminal guard): a run genuinely finished
      // (real finishedAt/durationMs/outputSummary) but its status column
      // never advanced past 'running'. The restart sweep must recognize it
      // as finished via `finishedAt` and leave it alone.
      const taskId = createTestTask();
      const run = store.createRun(taskId, 'scheduled');
      db.update(pulseRuns)
        .set({
          status: 'running',
          finishedAt: '2026-07-10T02:44:10.310Z',
          durationMs: 10_307,
          output: 'ok',
        })
        .where(eq(pulseRuns.id, run.id))
        .run();

      const changed = store.markRunsInterrupted(everyRunningRun());
      expect(changed).toBe(0);

      const found = store.getRun(run.id);
      expect(found!.status).toBe('running');
      expect(found!.finishedAt).toBe('2026-07-10T02:44:10.310Z');
      expect(found!.durationMs).toBe(10_307);
      expect(found!.error).toBeNull();
    });

    it('still sweeps genuinely unfinished running runs alongside finished ones', () => {
      const taskId = createTestTask();
      const crashed = store.createRun(taskId, 'scheduled'); // finishedAt stays null
      const stuckButFinished = store.createRun(taskId, 'scheduled');
      db.update(pulseRuns)
        .set({ status: 'running', finishedAt: '2026-07-10T02:44:10.310Z', output: 'ok' })
        .where(eq(pulseRuns.id, stuckButFinished.id))
        .run();

      const changed = store.markRunsInterrupted(everyRunningRun());
      expect(changed).toBe(1);

      expect(store.getRun(crashed.id)!.status).toBe('failed');
      expect(store.getRun(crashed.id)!.error).toBe('Interrupted by server restart');
      expect(store.getRun(stuckButFinished.id)!.status).toBe('running');
      expect(store.getRun(stuckButFinished.id)!.finishedAt).toBe('2026-07-10T02:44:10.310Z');
    });
  });

  // === Shared Db lifecycle ===

  describe('shared database', () => {
    it('works with a second TaskStore sharing the same db', () => {
      const store2 = new TaskStore(db);
      store.createTask(taskInput({ name: 'From store 1', prompt: 'p', cron: '* * * * *' }));
      const tasks = store2.getTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].name).toBe('From store 1');
    });
  });

  // === ULID IDs ===

  describe('ID generation', () => {
    it('generates ULID IDs (no UUID hyphens)', () => {
      const task = store.createTask(
        taskInput({ name: 'ULID test', prompt: 'p', cron: '* * * * *' })
      );
      expect(task.id).toMatch(/^[0-9A-Z]{26}$/i);
      expect(task.id).not.toContain('-');

      const run = store.createRun(task.id, 'manual');
      expect(run.id).toMatch(/^[0-9A-Z]{26}$/i);
      expect(run.id).not.toContain('-');
    });
  });

  // === agentId field ===

  describe('agentId field', () => {
    it('creates task with agentId', () => {
      const task = store.createTask(
        taskInput({
          name: 'Agent test',
          prompt: 'test prompt',
          cron: '* * * * *',
          agentId: 'agent-123',
        })
      );
      expect(task.agentId).toBe('agent-123');
    });

    it('defaults agentId to null when not provided', () => {
      const task = store.createTask(
        taskInput({
          name: 'No agent',
          prompt: 'test prompt',
          cron: '* * * * *',
        })
      );
      expect(task.agentId).toBeNull();
    });

    it('preserves agentId on unrelated updates', () => {
      const task = store.createTask(
        taskInput({
          name: 'Preserve agent',
          prompt: 'test prompt',
          cron: '* * * * *',
          agentId: 'agent-789',
        })
      );
      const updated = store.updateTask(task.id, { name: 'Renamed' });
      expect(updated!.agentId).toBe('agent-789');
      expect(updated!.name).toBe('Renamed');
    });

    it('includes agentId in getTasks list', () => {
      store.createTask(
        taskInput({
          name: 'Listed',
          prompt: 'test prompt',
          cron: '* * * * *',
          agentId: 'agent-list',
        })
      );
      const tasks = store.getTasks();
      expect(tasks[0].agentId).toBe('agent-list');
    });
  });

  // === disableTasksByAgentId ===

  describe('disableTasksByAgentId', () => {
    it('disables matching enabled tasks', () => {
      const task = store.createTask(
        taskInput({
          name: 'Agent task',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-1',
        })
      );
      const count = store.disableTasksByAgentId('agent-1');
      expect(count).toBe(1);
      const updated = store.getTask(task.id);
      expect(updated!.enabled).toBe(false);
      expect(updated!.status).toBe('paused');
    });

    it('returns 0 when no matching tasks', () => {
      store.createTask(
        taskInput({
          name: 'Other agent',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-2',
        })
      );
      const count = store.disableTasksByAgentId('nonexistent');
      expect(count).toBe(0);
    });

    it('does not re-disable already disabled tasks', () => {
      store.createTask(
        taskInput({
          name: 'Already disabled',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-3',
          enabled: false,
        })
      );
      const count = store.disableTasksByAgentId('agent-3');
      expect(count).toBe(0);
    });

    it('only disables tasks for the specified agent', () => {
      const s1 = store.createTask(
        taskInput({
          name: 'Agent A',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-a',
        })
      );
      const s2 = store.createTask(
        taskInput({
          name: 'Agent B',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-b',
        })
      );
      store.disableTasksByAgentId('agent-a');
      expect(store.getTask(s1.id)!.enabled).toBe(false);
      expect(store.getTask(s2.id)!.enabled).toBe(true);
    });

    it('disables multiple tasks for the same agent', () => {
      store.createTask(
        taskInput({
          name: 'S1',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-multi',
        })
      );
      store.createTask(
        taskInput({
          name: 'S2',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-multi',
        })
      );
      store.createTask(
        taskInput({
          name: 'S3',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-multi',
        })
      );
      const count = store.disableTasksByAgentId('agent-multi');
      expect(count).toBe(3);
    });
  });

  describe('markRemovedByFilePath', () => {
    /** Two tasks sharing a slug across different tasks directories. */
    function createSlugTwins(slug: string) {
      const globalPath = `/home/u/.dork/tasks/${slug}/SKILL.md`;
      const projectPath = `/home/u/code/proj/.dork/tasks/${slug}/SKILL.md`;
      return {
        globalTask: store.createTask(taskInput({ name: slug, prompt: 'p', filePath: globalPath })),
        projectTask: store.createTask(
          taskInput({ name: slug, prompt: 'p', filePath: projectPath })
        ),
        globalPath,
        projectPath,
      };
    }

    it('pauses only the exact file, never a same-slug task elsewhere', () => {
      const { globalTask, projectTask, globalPath } = createSlugTwins('flow-drain');

      expect(store.markRemovedByFilePath(globalPath)).toBe(1);

      expect(store.getTask(globalTask.id)?.status).toBe('paused');
      expect(store.getTask(globalTask.id)?.enabled).toBe(false);
      // The live task in the other checkout is untouched.
      expect(store.getTask(projectTask.id)?.status).toBe('active');
      expect(store.getTask(projectTask.id)?.enabled).toBe(true);
    });

    it('reports zero when no task owns that path', () => {
      expect(store.markRemovedByFilePath('/nowhere/SKILL.md')).toBe(0);
    });
  });

  describe('upsertFromFile status recovery', () => {
    /** A parsed definition for a file at `filePath`. */
    function definition(name: string, filePath: string) {
      return {
        name,
        meta: {
          name,
          description: 'd',
          timezone: 'UTC',
          enabled: true,
          permissions: 'acceptEdits',
        },
        body: 'do it',
        filePath,
        dirPath: filePath.replace(`/${SKILL_FILENAME}`, ''),
        scope: 'global',
      } as Parameters<TaskStore['upsertFromFile']>[0];
    }

    it('un-pauses a task whose file came back', () => {
      const filePath = '/home/u/.dork/tasks/back-again/SKILL.md';
      const task = store.createTask(taskInput({ name: 'back-again', filePath }));
      store.markRemovedByFilePath(filePath);
      expect(store.getTask(task.id)?.status).toBe('paused');

      store.upsertFromFile(definition('back-again', filePath));

      // The scheduler requires BOTH — restoring only `enabled` leaves a task
      // that reads as live and never fires.
      expect(store.getTask(task.id)?.status).toBe('active');
      expect(store.getTask(task.id)?.enabled).toBe(true);
      expect(store.getTask(task.id)?.id).toBe(task.id);
    });

    it('leaves pending_approval alone — only a person clears that gate', () => {
      const filePath = '/home/u/.dork/tasks/needs-ok/SKILL.md';
      const task = store.createTask(taskInput({ name: 'needs-ok', filePath }));
      store.updateTask(task.id, { status: 'pending_approval' });

      store.upsertFromFile(definition('needs-ok', filePath));

      expect(store.getTask(task.id)?.status).toBe('pending_approval');
    });

    it('still honours enabled: false from the file', () => {
      const filePath = '/home/u/.dork/tasks/off/SKILL.md';
      const task = store.createTask(taskInput({ name: 'off', filePath }));
      store.markRemovedByFilePath(filePath);

      const def = definition('off', filePath);
      def.meta.enabled = false;
      store.upsertFromFile(def);

      // A person pausing a task writes `enabled: false` in the file; the
      // status recovery must not override that choice.
      expect(store.getTask(task.id)?.enabled).toBe(false);
    });
  });

  // === ISO 8601 timestamps ===

  describe('timestamps', () => {
    it('stores ISO 8601 timestamps', () => {
      const task = store.createTask(taskInput({ name: 'TS test', prompt: 'p', cron: '* * * * *' }));
      expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(task.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      const run = store.createRun(task.id, 'scheduled');
      expect(run.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('dispatch idempotency (ADR-285)', () => {
    const running = { status: 'running' } as const;

    it('claims a tick once — a duplicate (taskId, tick) does not claim again', () => {
      const task = store.createTask(taskInput({ name: 'Dedup', prompt: 'x', cron: '0 * * * *' }));
      const tick = 1_700_000_000_000;
      expect(store.claimScheduledRun(task.id, tick, running)).not.toBeNull();
      expect(store.claimScheduledRun(task.id, tick, running)).toBeNull();
    });

    it('distinct ticks for the same task both claim', () => {
      const task = store.createTask(taskInput({ name: 'Dedup2', prompt: 'x', cron: '0 * * * *' }));
      expect(store.claimScheduledRun(task.id, 1_700_000_000_000, running)).not.toBeNull();
      expect(store.claimScheduledRun(task.id, 1_700_000_060_000, running)).not.toBeNull();
    });

    it('opens the run row in the same transaction as the claim (DOR-1482)', () => {
      // The crash window this closes: a claim written, then a process death
      // before the run row existed, left the occurrence consumed for seven days
      // with nothing anywhere to show it had ever been dispatched.
      const task = store.createTask(taskInput({ name: 'Atomic', prompt: 'x', cron: '0 * * * *' }));
      const run = store.claimScheduledRun(task.id, 1_700_000_000_000, running);

      expect(run).not.toBeNull();
      expect(run!.status).toBe('running');
      expect(run!.trigger).toBe('scheduled');
      expect(store.listRuns({ taskId: task.id })).toHaveLength(1);
      expect(db.select().from(pulseDispatchLog).all()).toHaveLength(1);
    });

    it('a claim whose run row cannot be written claims nothing at all (DOR-1482)', () => {
      // Proves the atomicity rather than asserting it: the run insert is forced
      // to fail, and the dispatch-log row must roll back with it — otherwise the
      // tick would be permanently consumed by a dispatch that never happened.
      const task = store.createTask(
        taskInput({ name: 'Rollback', prompt: 'x', cron: '0 * * * *' })
      );
      const tick = 1_700_000_120_000;
      // A run row's schedule_id is a foreign key; deleting the task under it
      // makes the insert fail exactly where a crash would have.
      const doomedTaskId = task.id;
      store.deleteTask(doomedTaskId);

      expect(() => store.claimScheduledRun(doomedTaskId, tick, running)).toThrow();
      expect(db.select().from(pulseDispatchLog).all()).toHaveLength(0);
    });

    it('records a tick the scheduler deliberately did not run (DOR-1482)', () => {
      const task = store.createTask(taskInput({ name: 'Busy', prompt: 'x', cron: '0 * * * *' }));
      const run = store.claimScheduledRun(task.id, 1_700_000_000_000, {
        status: 'skipped',
        reason: 'DorkOS was already running 4 tasks at once, which is its limit',
      });

      expect(run!.status).toBe('skipped');
      expect(run!.finishedAt).not.toBeNull();
      expect(run!.durationMs).toBe(0);
      expect(run!.error).toContain('already running 4 tasks');
      // Terminal on arrival: nothing may later "finish" a run that never ran.
      expect(store.updateRun(run!.id, { status: 'completed' })!.status).toBe('skipped');
    });

    it('pruneDispatchLog removes ticks older than the TTL and keeps fresh ones', () => {
      const task = store.createTask(taskInput({ name: 'Prune', prompt: 'x', cron: '0 * * * *' }));
      const oldTick = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
      const freshTick = Date.now();
      store.claimScheduledRun(task.id, oldTick, running);
      store.claimScheduledRun(task.id, freshTick, running);

      expect(store.pruneDispatchLog(7 * 24 * 60 * 60 * 1000)).toBe(1); // only the 10-day-old row

      // The pruned tick is reclaimable; the fresh one is still blocked.
      expect(store.claimScheduledRun(task.id, oldTick, running)).not.toBeNull();
      expect(store.claimScheduledRun(task.id, freshTick, running)).toBeNull();
    });
  });

  describe('getScheduleReliability (DOR-166)', () => {
    function createTestTask(name: string) {
      const task = store.createTask(taskInput({ name, prompt: 'test prompt', cron: '* * * * *' }));
      return task.id;
    }

    it('returns [] when there is no run history', () => {
      expect(store.getScheduleReliability()).toEqual([]);
    });

    it('excludes schedules whose runs are all still running', () => {
      const taskId = createTestTask('Still running');
      store.createRun(taskId, 'scheduled'); // status stays 'running'

      expect(store.getScheduleReliability()).toEqual([]);
    });

    it('computes success rate and p95 duration over terminal runs, verified against hand-computed values', () => {
      const taskId = createTestTask('Reliability check');

      // 7 completed + 3 failed, durations 100ms..1000ms in 100ms steps —
      // successRate = 7/10 = 0.7, independently of the query under test.
      const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
      const statuses: Array<'completed' | 'failed'> = [
        'completed',
        'completed',
        'completed',
        'completed',
        'completed',
        'completed',
        'completed',
        'failed',
        'failed',
        'failed',
      ];
      for (let i = 0; i < durations.length; i++) {
        const run = store.createRun(taskId, 'scheduled');
        store.updateRun(run.id, {
          status: statuses[i],
          finishedAt: new Date().toISOString(),
          durationMs: durations[i],
        });
      }
      // A still-running run must not affect success rate or the duration set.
      store.createRun(taskId, 'scheduled');

      // Hand-computed p95 via the standard percentile_cont linear-interpolation
      // formula over the sorted duration set [100, 200, ..., 1000] (n=10):
      //   rank = 0.95 * (n - 1) = 8.55 -> interpolate between values[8]=900
      //   and values[9]=1000 at fraction 0.55 -> 900 + 0.55*100 = 955.
      const sorted = [...durations].sort((a, b) => a - b);
      const rank = 0.95 * (sorted.length - 1);
      const lo = Math.floor(rank);
      const hi = Math.ceil(rank);
      const handComputedP95 = sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);

      const result = store.getScheduleReliability();
      expect(result).toHaveLength(1);
      expect(result[0].scheduleId).toBe(taskId);
      expect(result[0].totalRuns).toBe(10); // the still-running 11th run is excluded
      expect(result[0].successRate).toBeCloseTo(0.7, 10);
      expect(result[0].p95DurationMs).toBeCloseTo(handComputedP95, 6); // 955
    });

    it('keeps each schedule’s reliability independent', () => {
      const taskA = createTestTask('Schedule A');
      const taskB = createTestTask('Schedule B');

      const runA = store.createRun(taskA, 'scheduled');
      store.updateRun(runA.id, { status: 'completed', durationMs: 1000 });

      const runB1 = store.createRun(taskB, 'scheduled');
      store.updateRun(runB1.id, { status: 'failed', durationMs: 2000 });
      const runB2 = store.createRun(taskB, 'scheduled');
      store.updateRun(runB2.id, { status: 'failed', durationMs: 3000 });

      const result = store.getScheduleReliability();
      expect(result).toHaveLength(2);

      const a = result.find((r) => r.scheduleId === taskA)!;
      expect(a.totalRuns).toBe(1);
      expect(a.successRate).toBe(1);

      const b = result.find((r) => r.scheduleId === taskB)!;
      expect(b.totalRuns).toBe(2);
      expect(b.successRate).toBe(0);
    });

    it('filters to a single schedule when scheduleId is given', () => {
      const taskA = createTestTask('Filter A');
      const taskB = createTestTask('Filter B');
      const runA = store.createRun(taskA, 'scheduled');
      store.updateRun(runA.id, { status: 'completed', durationMs: 500 });
      const runB = store.createRun(taskB, 'scheduled');
      store.updateRun(runB.id, { status: 'completed', durationMs: 700 });

      const result = store.getScheduleReliability(taskA);
      expect(result).toHaveLength(1);
      expect(result[0].scheduleId).toBe(taskA);
    });

    it('does not fabricate a p95 when no terminal run has a recorded duration', () => {
      const taskId = createTestTask('No durations');
      const run = store.createRun(taskId, 'scheduled');
      // Terminal, but durationMs was never set.
      store.updateRun(run.id, { status: 'cancelled' });

      const result = store.getScheduleReliability();
      expect(result).toHaveLength(1);
      expect(result[0].totalRuns).toBe(1);
      expect(result[0].p95DurationMs).toBeNull();
    });

    it("counts a DB-only 'timeout' row as a terminal failure, not ignoring it", () => {
      const taskId = createTestTask('Timeout rows');
      const ok = store.createRun(taskId, 'scheduled');
      store.updateRun(ok.id, { status: 'completed', durationMs: 100 });

      // No writer produces 'timeout' today (the shared TaskRunStatus type
      // omits it), but the DB column enum allows it -- write it directly to
      // simulate such a row.
      const timedOut = store.createRun(taskId, 'scheduled');
      db.update(pulseRuns)
        .set({ status: 'timeout', durationMs: 5000 })
        .where(eq(pulseRuns.id, timedOut.id))
        .run();

      const result = store.getScheduleReliability(taskId);
      expect(result).toHaveLength(1);
      expect(result[0].totalRuns).toBe(2); // the timeout row is included...
      expect(result[0].successRate).toBeCloseTo(0.5, 10); // ...and counts as a failure
    });
  });
});
