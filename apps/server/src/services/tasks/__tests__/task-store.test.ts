import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { pulseRuns, pulseDispatchLog, pulseSchedules } from '@dorkos/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { eq } from 'drizzle-orm';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import type { TaskFileSync } from '../sync/task-file-sync.js';

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

/** A parsed definition for a file at `filePath`, with optional extra schedule fields. */
function fileDefinition(
  name: string,
  filePath: string,
  schedule: Record<string, unknown> = {}
): Parameters<TaskFileSync['upsertFromFile']>[0] {
  return {
    name,
    meta: {
      name,
      description: 'd',
      schedule: { timezone: 'UTC', enabled: true, permissions: 'acceptEdits', ...schedule },
    },
    body: 'do it',
    filePath,
    dirPath: filePath.replace(`/${SKILL_FILENAME}`, ''),
    scope: 'global',
  } as Parameters<TaskFileSync['upsertFromFile']>[0];
}

describe('TaskStore', () => {
  let store: TaskStore;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  /** Create a task with an every-minute cron and return its id. */
  function newTaskId(name = 'Task test'): string {
    return store.createTask(taskInput({ name, prompt: 'test prompt', cron: '* * * * *' })).id;
  }

  /** A run on `taskId` that has ended with `status`. */
  function endedRun(
    taskId: string,
    status: 'completed' | 'failed' | 'cancelled' = 'completed',
    durationMs?: number
  ): string {
    const run = store.createRun(taskId, 'scheduled');
    store.updateRun(run.id, { status, finishedAt: new Date().toISOString(), durationMs });
    return run.id;
  }

  describe('tasks', () => {
    it('creates a task with its defaults and reads it back', () => {
      const task = store.createTask(
        taskInput({ name: 'Daily cleanup', cron: '0 2 * * *', agentId: 'agent-123' })
      );

      expect(task).toMatchObject({
        name: 'Daily cleanup',
        enabled: true,
        status: 'active',
        permissionMode: 'acceptEdits',
        timezone: 'UTC',
        agentId: 'agent-123',
      });
      expect(store.getTask(task.id)?.name).toBe('Daily cleanup');
      expect(store.getTask('nonexistent')).toBeNull();
      expect(store.updateTask('nope', { name: 'X' })).toBeNull();
      expect(store.deleteTask('nope')).toBe(false);
    });

    it('carries an agent proposal — the reason, the session, the directory (DOR-1394)', () => {
      const created = store.createTask(
        taskInput({
          name: 'Nightly sweep',
          cron: '0 3 * * *',
          reason: 'The overnight backlog needs sweeping before you start.',
          proposedBySessionId: 'ses-42',
          proposedByAgentPath: '/tmp/agents/nightly-bot',
        })
      );

      const read = store.getTask(created.id)!;
      expect(read.reason).toBe('The overnight backlog needs sweeping before you start.');
      expect(read.proposedBySessionId).toBe('ses-42');
      expect(read.proposedByAgentPath).toBe('/tmp/agents/nightly-bot');
      // Resolved by whoever READS the task, so the store leaves them empty.
      expect(read.proposedByName).toBeNull();
      expect(read.nextRuns).toEqual([]);
    });

    it('turns a cleared cron into the on-demand empty string, not null', () => {
      // `pulse_schedules.cron` is NOT NULL; the edit form sends `cron: null` on
      // every save of a task with no cron (`TaskFormInner.tsx`).
      const created = store.createTask(taskInput({ name: 'OnDemand', cron: '' }));

      const updated = store.updateTask(
        created.id,
        { cron: null, prompt: 'edited' },
        { timingLandsOn: 'file' }
      );

      expect(updated!.cron).toBe('');
      expect(updated!.prompt).toBe('edited');
    });

    it("deletes a task with its runs and dispatch rows, leaving other tasks' alone", () => {
      const doomed = store.createTask(taskInput({ name: 'Doomed' }));
      const survivor = store.createTask(taskInput({ name: 'Survivor' }));
      store.createRun(doomed.id, 'manual');
      const keptRun = store.createRun(survivor.id, 'manual');
      store.claimScheduledRun(doomed.id, 1_700_000_000_000, { status: 'running' });
      store.claimScheduledRun(survivor.id, 1_700_000_000_000, { status: 'running' });

      expect(store.deleteTask(doomed.id)).toBe(true);

      expect(store.getTasks().map((t) => t.id)).toEqual([survivor.id]);
      expect(
        db.select().from(pulseRuns).where(eq(pulseRuns.scheduleId, doomed.id)).all()
      ).toHaveLength(0);
      expect(store.getRun(keptRun.id)).not.toBeNull();
      expect(
        db
          .select()
          .from(pulseDispatchLog)
          .all()
          .map((r) => r.taskId)
      ).toEqual([survivor.id]);
    });

    it("pauses every task of an agent, only that agent's, and leaves the switch alone (DOR-2082)", () => {
      const a = store.createTask(taskInput({ name: 'A1', agentId: 'agent-a' }));
      const b = store.createTask(taskInput({ name: 'B', agentId: 'agent-b' }));

      expect(store.disableTasksByAgentId('agent-a')).toBe(1);

      // Only `status` stops the clock; the person's switch stays as it was.
      expect(store.getTask(a.id)).toMatchObject({ status: 'paused', enabled: true });
      expect(store.getTask(b.id)).toMatchObject({ status: 'active', enabled: true });
    });
  });

  describe('runs', () => {
    it('creates, lists and counts runs per task', () => {
      const taskId1 = newTaskId('1');
      const taskId2 = newTaskId('2');
      const run = store.createRun(taskId1, 'scheduled');
      store.createRun(taskId2, 'scheduled');
      store.createRun(taskId1, 'manual');

      expect(run).toMatchObject({ scheduleId: taskId1, status: 'running', finishedAt: null });
      expect(store.listRuns({ taskId: taskId1 })).toHaveLength(2);
      expect(store.listRuns({ limit: 2, offset: 2 })).toHaveLength(1);
      expect(store.countRuns()).toBe(3);
      expect(store.countRuns(taskId2)).toBe(1);
    });

    it('resolves the task name for a session id backed by a run', () => {
      const task = store.createTask(taskInput({ name: 'daily-digest' }));
      const run = store.createRun(task.id, 'scheduled');
      store.updateRun(run.id, { sessionId: 'session-with-run' });

      const origins = store.resolveTaskOrigins(['session-with-run', 'unrelated-id']);

      expect(origins.size).toBe(1);
      expect(origins.get('session-with-run')).toEqual({ taskName: 'daily-digest' });
    });

    it('does not let a post-terminal write downgrade status back to running (DOR-248)', () => {
      const run = store.createRun(newTaskId(), 'scheduled');
      store.updateRun(run.id, {
        status: 'completed',
        finishedAt: '2026-07-10T02:44:10.310Z',
        durationMs: 10_307,
        outputSummary: 'ok',
      });

      store.updateRun(run.id, { status: 'running' });

      expect(store.getRun(run.id)).toMatchObject({
        status: 'completed',
        finishedAt: '2026-07-10T02:44:10.310Z',
        durationMs: 10_307,
        outputSummary: 'ok',
      });
    });

    it('prunes finished history to retentionCount, per task', () => {
      const taskId1 = newTaskId('Prune 1');
      const taskId2 = newTaskId('Prune 2');
      for (let i = 0; i < 5; i++) endedRun(taskId1);
      endedRun(taskId2);

      expect(store.pruneRuns(taskId1, 2)).toBe(3);
      expect(store.countRuns(taskId1)).toBe(2);
      expect(store.countRuns(taskId2)).toBe(1);
    });

    it('never prunes a run that has not finished, however old it is (DOR-1482)', () => {
      // With retention on an hourly timer, a live run behind the retention
      // window was deleted mid-flight and its outcome lost.
      const taskId = newTaskId();
      const live = store.createRun(taskId, 'scheduled');
      for (let i = 0; i < 5; i++) endedRun(taskId);

      expect(store.pruneRuns(taskId, 2)).toBe(3);
      expect(store.getRun(live.id)!.status).toBe('running');
      expect(store.updateRun(live.id, { status: 'completed' })!.status).toBe('completed');
    });

    it('sweeps unfinished running runs but not a finished run stuck in "running" (DOR-249)', () => {
      const taskId = newTaskId();
      const crashed = store.createRun(taskId, 'scheduled');
      const stuckButFinished = store.createRun(taskId, 'scheduled');
      db.update(pulseRuns)
        .set({ status: 'running', finishedAt: '2026-07-10T02:44:10.310Z', output: 'ok' })
        .where(eq(pulseRuns.id, stuckButFinished.id))
        .run();

      const running = store.getRunningRuns().map((r) => r.id);
      expect(store.markRunsInterrupted(running)).toBe(1);

      expect(store.getRun(crashed.id)).toMatchObject({
        status: 'failed',
        error: 'Interrupted by server restart',
      });
      expect(store.getRun(stuckButFinished.id)).toMatchObject({
        status: 'running',
        finishedAt: '2026-07-10T02:44:10.310Z',
        error: null,
      });
    });
  });

  describe('dispatch (ADR-285)', () => {
    const running = { status: 'running' } as const;

    it('claims a tick once, opening its run row with the claim', () => {
      const taskId = newTaskId();
      const tick = 1_700_000_000_000;

      const run = store.claimScheduledRun(taskId, tick, running);
      expect(run).toMatchObject({ status: 'running', trigger: 'scheduled' });
      expect(store.claimScheduledRun(taskId, tick, running)).toBeNull();
      expect(store.claimScheduledRun(taskId, tick + 60_000, running)).not.toBeNull();
    });

    it('a claim whose run row cannot be written claims nothing at all (DOR-1482)', () => {
      // The run insert fails on its foreign key; the dispatch-log row must roll
      // back with it, or the tick is consumed by a dispatch that never happened.
      const doomedTaskId = newTaskId('Rollback');
      store.deleteTask(doomedTaskId);

      expect(() => store.claimScheduledRun(doomedTaskId, 1_700_000_120_000, running)).toThrow();
      expect(db.select().from(pulseDispatchLog).all()).toHaveLength(0);
    });

    it('pruneDispatchLog removes ticks older than the TTL and keeps fresh ones', () => {
      const taskId = newTaskId();
      const oldTick = Date.now() - 10 * 24 * 60 * 60 * 1000;
      const freshTick = Date.now();
      store.claimScheduledRun(taskId, oldTick, running);
      store.claimScheduledRun(taskId, freshTick, running);

      expect(store.pruneDispatchLog(7 * 24 * 60 * 60 * 1000)).toBe(1);
      expect(store.claimScheduledRun(taskId, oldTick, running)).not.toBeNull();
      expect(store.claimScheduledRun(taskId, freshTick, running)).toBeNull();
    });
  });

  it('computes success rate and p95 over terminal runs only (DOR-166)', () => {
    const taskId = newTaskId('Reliability check');
    // 7 completed + 3 failed, 100ms..1000ms; percentile_cont p95 over n=10:
    // rank 8.55 -> 900 + 0.55 * 100 = 955.
    [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].forEach((ms, i) =>
      endedRun(taskId, i < 7 ? 'completed' : 'failed', ms)
    );
    store.createRun(taskId, 'scheduled'); // still running: excluded

    const [result] = store.getScheduleReliability();
    expect(result.scheduleId).toBe(taskId);
    expect(result.totalRuns).toBe(10);
    expect(result.successRate).toBeCloseTo(0.7, 10);
    expect(result.p95DurationMs).toBeCloseTo(955, 6);
  });

  describe('file sync', () => {
    /** A task whose file went away: created at `filePath`, then marked removed. */
    function removedTask(name: string) {
      const filePath = `/home/u/.dork/tasks/${name}/SKILL.md`;
      const task = store.createTask(taskInput({ name, filePath }));
      store.fileSync.markRemovedByFilePath(filePath);
      return { id: task.id, filePath };
    }

    it('pauses only the exact file, never a same-slug task elsewhere', () => {
      const globalPath = '/home/u/.dork/tasks/flow-drain/SKILL.md';
      const projectPath = '/home/u/code/proj/.dork/tasks/flow-drain/SKILL.md';
      const globalTask = store.createTask(taskInput({ name: 'flow-drain', filePath: globalPath }));
      const projectTask = store.createTask(
        taskInput({ name: 'flow-drain', filePath: projectPath })
      );

      expect(store.fileSync.markRemovedByFilePath(globalPath)).toBe(1);

      // Paused, with the person's own switch left as it was (FB-26).
      expect(store.getTask(globalTask.id)).toMatchObject({ status: 'paused', enabled: true });
      expect(store.getTask(projectTask.id)?.status).toBe('active');
    });

    it('un-pauses a task whose file came back', () => {
      const { id, filePath } = removedTask('back-again');

      store.fileSync.upsertFromFile(fileDefinition('back-again', filePath));

      // The scheduler requires BOTH.
      expect(store.getTask(id)).toMatchObject({ status: 'active', enabled: true });
    });

    it('stamps the un-pause as an approval, never leaving the old receipt or none (DOR-3641)', () => {
      const { id, filePath } = removedTask('stamped');
      db.update(pulseSchedules)
        .set({ approvedAt: null, approvedBy: null, approvedVia: null })
        .where(eq(pulseSchedules.id, id))
        .run();
      const person = { kind: 'person', userId: 'user-1', name: null } as const;

      store.fileSync.upsertFromFile(fileDefinition('stamped', filePath), undefined, {
        source: 'operator',
        approval: { approvedBy: person, approvedVia: 'created' },
      });
      expect(store.getTask(id)).toMatchObject({ status: 'active', approvedBy: person });

      // The same file back with no approver named: the person's receipt stays.
      store.fileSync.markRemovedByFilePath(filePath);
      store.fileSync.upsertFromFile(fileDefinition('stamped', filePath));
      expect(store.getTask(id)).toMatchObject({ status: 'active', approvedBy: person });

      // Changed content with no approver named: the policy's stamp.
      store.fileSync.markRemovedByFilePath(filePath);
      const changed = fileDefinition('stamped', filePath);
      changed.body = 'do something else';
      store.fileSync.upsertFromFile(changed);
      expect(store.getTask(id)).toMatchObject({
        status: 'active',
        approvedBy: { kind: 'policy' },
        approvedVia: 'unknown',
      });
    });

    it('brings a paused task back waiting when the write approves nothing', () => {
      const { id, filePath } = removedTask('parked-create');

      store.fileSync.upsertFromFile(fileDefinition('parked-create', filePath), undefined, {
        source: 'operator',
        approval: null,
      });

      expect(store.getTask(id)).toMatchObject({ status: 'pending_approval', approvedBy: null });
    });

    it('leaves pending_approval alone — only a person clears that gate', () => {
      const filePath = '/home/u/.dork/tasks/needs-ok/SKILL.md';
      const task = store.createTask(taskInput({ name: 'needs-ok', filePath }));
      store.updateTask(task.id, { status: 'pending_approval' });

      store.fileSync.upsertFromFile(fileDefinition('needs-ok', filePath));

      expect(store.getTask(task.id)?.status).toBe('pending_approval');
    });
  });

  describe('sticky (DOR-1571)', () => {
    it("caches the file's schedule.sticky through upsertFromFile", () => {
      const filePath = '/home/u/.dork/tasks/from-file/SKILL.md';
      const created = store.fileSync.upsertFromFile(
        fileDefinition('from-file', filePath, { sticky: true })
      );
      expect(store.getTask(created.id)?.sticky).toBe(true);

      store.fileSync.upsertFromFile(fileDefinition('from-file', filePath, { sticky: false }));
      expect(store.getTask(created.id)?.sticky).toBe(false);
    });

    it("hasRunningRunForTask and latestStickyRun follow the newest finished run's SDK id", () => {
      const taskId = newTaskId('resume');
      expect(store.latestStickyRun(taskId)).toBeNull();

      const run1 = store.createRun(taskId, 'scheduled');
      expect(store.hasRunningRunForTask(taskId)).toBe(true);
      // A running run has no session id yet, so it is not a resume target.
      expect(store.latestStickyRun(taskId)).toBeNull();
      store.updateRun(run1.id, { status: 'completed', sessionId: 'sdk-uuid-1' });
      expect(store.hasRunningRunForTask(taskId)).toBe(false);

      const run2 = store.createRun(taskId, 'scheduled');
      store.updateRun(run2.id, { status: 'completed', sessionId: 'sdk-uuid-2' });
      // A later skipped run (no session id) never becomes the target.
      const run3 = store.createRun(taskId, 'scheduled');
      store.updateRun(run3.id, { status: 'skipped' });

      expect(store.latestStickyRun(taskId)?.sessionId).toBe('sdk-uuid-2');
    });
  });
});
