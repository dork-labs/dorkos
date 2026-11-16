/**
 * One of our agents on a Trusted install changing an approved schedule's work
 * parks substituted prompts and runtimes for a person (DOR-3651). `TaskApprovals.settleApprovedWorkChange`.
 *
 * @module services/tasks/approvals/__tests__/settle-trusted-agent
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import type { Task } from '@dorkos/shared/schemas';
import { TaskStore } from '../../task-store.js';
import { CHANGED_REASON, taskWorkOf } from '../../schedule-permission-clamp.js';

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
  it('parks a prompt substitution even on the agent’s own Trusted schedule', () => {
    const approved = approvedSchedule();
    store.updateTask(approved.id, { approvedAllow: ['Bash(/abs/path/script.sh --once)'] });
    const { settled, after } = agentEdits(store.getTask(approved.id)!, true);

    expect(settled).toBe('parked');
    expect(after.status).toBe('pending_approval');
    const row = db.select().from(pulseSchedules).where(eq(pulseSchedules.id, after.id)).get()!;
    expect(row.approvedContentKey).toBeNull();
    expect(row.approvedAllow).toBeNull();
  });

  it('parks a schedule that came from a file, even for our agent, and clears its record', () => {
    const approved = approvedSchedule('file');
    expect(approved.approvedAt).not.toBeNull();
    const { settled, after } = agentEdits(approved, true);

    expect(settled).toBe('parked');
    expect(after.status).toBe('pending_approval');
    // The person's yes covered the old work, not this (Security Should C-1).
    expect(after).toMatchObject({ approvedAt: null, approvedBy: null, approvedVia: null });
  });

  it('clears the record wherever a person withdraws the grant', () => {
    const task = approvedSchedule();
    store.updateTask(task.id, { status: 'pending_approval' });

    expect(store.getTask(task.id)).toMatchObject({
      approvedAt: null,
      approvedBy: null,
      approvedVia: null,
    });
  });

  it('re-stamps a vouched re-key as the trusted agent, not the earlier person', () => {
    const task = approvedSchedule();
    db.update(pulseSchedules)
      .set({ approvedBy: JSON.stringify({ kind: 'person', userId: null, name: 'Sam' }) })
      .where(eq(pulseSchedules.id, task.id))
      .run();
    const before = { ...taskWorkOf(task), status: task.status };
    store.updateTask(task.id, { prompt: 'Post the digest, and the weather.' });
    const settled = store.approvals.settleApprovedWorkChange(task.id, before, {
      trusted: false,
      armsAgentWork: true,
      ownAgentVouches: true,
    });
    const after = store.getTask(task.id)!;

    expect(settled).toBe('rekeyed');
    expect(after.status).toBe('active');
    expect(after.approvedBy).toEqual({ kind: 'policy' });
    expect(after.approvedVia).toBe('trusted_agent');
    expect(after.approvedAt).not.toBeNull();
  });

  it('parks when the agent is not one whose work arms (Careful, or an outsider)', () => {
    const { settled, after } = agentEdits(approvedSchedule(), false);

    expect(settled).toBe('parked');
    expect(after.status).toBe('pending_approval');
  });

  it('keeps a park the file sync made mid-request', () => {
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

    expect(settled).toBe('parked');
    const after = store.getTask(task.id)!;
    expect(after.status).toBe('pending_approval');
    expect(after.reason).not.toBeNull();
  });

  it('re-stamps as the trusted agent when its vouched edit re-arms a parked task', () => {
    const task = approvedSchedule();
    const before = { ...taskWorkOf(task), status: task.status };
    const approvedKey = db
      .select()
      .from(pulseSchedules)
      .where(eq(pulseSchedules.id, task.id))
      .get()!.approvedContentKey;
    store.updateTask(task.id, { prompt: 'Post the digest, and the weather.' });
    db.update(pulseSchedules)
      .set({
        status: 'pending_approval',
        approvedContentKey: null,
        previousApprovalKey: approvedKey,
      })
      .where(eq(pulseSchedules.id, task.id))
      .run();

    const settled = store.approvals.settleApprovedWorkChange(task.id, before, {
      trusted: false,
      armsAgentWork: true,
      ownAgentVouches: true,
    });

    expect(settled).toBe('rekeyed');
    // The agent's trust re-armed new work; the earlier person's yes no longer
    // describes it (Security Should C-1).
    const after = store.getTask(task.id)!;
    expect(after).toMatchObject({
      status: 'active',
      approvedBy: { kind: 'policy' },
      approvedVia: 'trusted_agent',
    });
  });

  it('clears approved rules only when a vouched edit substitutes the task work', () => {
    const rule = 'Bash(/abs/path/script.sh --once)';
    const task = approvedSchedule();
    store.updateTask(task.id, { approvedAllow: [rule] });
    const beforePromptEdit = { ...taskWorkOf(store.getTask(task.id)!), status: task.status };
    store.updateTask(task.id, { prompt: 'Post a replacement digest.' });

    expect(
      store.approvals.settleApprovedWorkChange(task.id, beforePromptEdit, {
        trusted: false,
        armsAgentWork: true,
        ownAgentVouches: true,
      })
    ).toBe('rekeyed');
    expect(store.getTask(task.id)?.approvedAllow).toBeNull();

    store.updateTask(task.id, { approvedAllow: [rule] });
    const beforeNameEdit = { ...taskWorkOf(store.getTask(task.id)!), status: task.status };
    store.updateTask(task.id, { name: 'Morning digest' });

    expect(
      store.approvals.settleApprovedWorkChange(task.id, beforeNameEdit, {
        trusted: false,
        armsAgentWork: true,
        ownAgentVouches: true,
      })
    ).toBe('rekeyed');
    expect(store.getTask(task.id)?.approvedAllow).toEqual([rule]);
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
