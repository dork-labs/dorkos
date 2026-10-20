/**
 * One of our agents on a Trusted install changing an approved schedule's work
 * keeps it live and re-approves it, as a person's change does, unless the
 * schedule came from a file, a Shape or a package (ADR 261006-225605, spec
 * `trusted-by-default-flip` §5.4). `TaskApprovals.settleApprovedWorkChange`.
 *
 * @module services/tasks/approvals/__tests__/settle-trusted-agent
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import type { Task } from '@dorkos/shared/schemas';
import { TaskStore } from '../../task-store.js';
import { CHANGED_REASON, scheduleContentKey, taskWorkOf } from '../../schedule-permission-clamp.js';

let db: Db;
let store: TaskStore;

beforeEach(() => {
  db = createTestDb();
  store = new TaskStore(db);
});

/** An approved, live schedule; `origin: 'file'` when discovery made it. */
function approvedSchedule(origin: 'file' | null = null): Task {
  const task = store.createTask({
    name: 'digest',
    description: 'digest',
    prompt: 'Post the digest.',
    cron: '0 7 * * *',
    filePath: '/skills/digest/SKILL.md',
  });
  if (origin) {
    db.update(pulseSchedules).set({ origin }).where(eq(pulseSchedules.id, task.id)).run();
  }
  return store.getTask(task.id)!;
}

/** The agent's edit: a new prompt, then the settle the doors call after it. */
function agentEdits(task: Task, armsAgentWork: boolean) {
  const before = { ...taskWorkOf(task), status: task.status };
  store.updateTask(task.id, { prompt: 'Post the digest, and the weather.' });
  const settled = store.approvals.settleApprovedWorkChange(task.id, before, {
    trusted: false,
    armsAgentWork,
  });
  return { settled, after: store.getTask(task.id)! };
}

describe('an agent changing the work of an approved schedule', () => {
  it('re-approves a schedule that did not come from a file, and keeps it live', () => {
    const { settled, after } = agentEdits(approvedSchedule(), true);

    expect(settled).toBe('rekeyed');
    expect(after.status).toBe('active');
    const row = db.select().from(pulseSchedules).where(eq(pulseSchedules.id, after.id)).get()!;
    expect(row.approvedContentKey).toBe(scheduleContentKey(taskWorkOf(after)));
  });

  it('parks a schedule that came from a file, even for our agent', () => {
    const { settled, after } = agentEdits(approvedSchedule('file'), true);

    expect(settled).toBe('parked');
    expect(after.status).toBe('pending_approval');
  });

  it('parks when the agent is not one whose work arms (Careful, or an outsider)', () => {
    const { settled, after } = agentEdits(approvedSchedule(), false);

    expect(settled).toBe('parked');
    expect(after.status).toBe('pending_approval');
  });

  it('undoes a park the file sync made mid-request, and drops its sentence', () => {
    const task = approvedSchedule();
    const before = { ...taskWorkOf(task), status: task.status };
    const approvedKey = db
      .select()
      .from(pulseSchedules)
      .where(eq(pulseSchedules.id, task.id))
      .get()!.approvedContentKey;
    store.updateTask(task.id, { prompt: 'Post the digest, and the weather.' });
    // What the watcher writes when it syncs the new file against the old grant.
    db.update(pulseSchedules)
      .set({
        status: 'pending_approval',
        approvedContentKey: null,
        previousApprovalKey: approvedKey,
        reason: CHANGED_REASON,
        reasonSource: 'dorkos',
      })
      .where(eq(pulseSchedules.id, task.id))
      .run();

    const settled = store.approvals.settleApprovedWorkChange(task.id, before, {
      trusted: false,
      armsAgentWork: true,
    });

    expect(settled).toBe('rekeyed');
    const after = store.getTask(task.id)!;
    expect(after.status).toBe('active');
    expect(after.reason).toBeNull();
  });

  it('leaves a schedule nobody approved waiting', () => {
    const task = approvedSchedule();
    store.updateTask(task.id, { status: 'pending_approval' });
    const parked = store.getTask(task.id)!;

    const { settled, after } = agentEdits(parked, true);

    expect(settled).toBe('unchanged');
    expect(after.status).toBe('pending_approval');
  });
});
