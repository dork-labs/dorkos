/**
 * A change to an agent's runtime, model or effort made outside DorkOS re-asks
 * for every approved schedule that follows the agent for that part (DOR-2337).
 *
 * A schedule that leaves its runtime, model or effort unset runs on its agent's,
 * and its approval records "follow the agent", not the agent's value. So an edit
 * to `.dork/agent.json` that DorkOS did not make would move approved work with
 * nobody asked. These cases pin the store half: which schedules park, what the
 * card is told, and that nothing is ever switched on.
 *
 * @module services/tasks/approvals/__tests__/agent-followers-park
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import { TaskStore } from '../../task-store.js';
import { AGENT_DEFAULTS_CHANGED_OUTSIDE_REASON } from '../../schedule-permission-clamp.js';

const AGENT = 'agent-1';

describe('parking the schedules that follow an agent', () => {
  let db: Db;
  let store: TaskStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  /** An approved schedule for an agent; unset settings follow the agent. */
  function schedule(
    name: string,
    own: { model?: string; runtime?: string; effort?: string } = {},
    agentId = AGENT
  ) {
    return store.createTask({
      name,
      description: name,
      prompt: `Do ${name}.`,
      cron: '0 7 * * *',
      agentId,
      filePath: `/skills/${name}/SKILL.md`,
      ...own,
    });
  }

  function row(id: string) {
    return db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get()!;
  }

  const MODEL_CHANGE = [{ field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4' }] as const;

  it('parks an approved follower, keeps its approval for the card, and says why', () => {
    const task = schedule('digest');
    const grant = row(task.id).approvedContentKey;

    const outcome = store.approvals.parkAgentFollowers(AGENT, [...MODEL_CHANGE]);

    expect(outcome.parked).toEqual([task.id]);
    const after = row(task.id);
    expect(after.status).toBe('pending_approval');
    expect(after.approvedContentKey).toBeNull();
    expect(after.previousApprovalKey).toBe(grant);
    expect(after.reason).toBe(AGENT_DEFAULTS_CHANGED_OUTSIDE_REASON);
    expect(after.reasonSource).toBe('dorkos');
    expect(store.getTask(task.id)!.approvalChanges).toEqual([
      { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'agent' },
    ]);
  });

  it('leaves a schedule that names its own value for that part running', () => {
    const own = schedule('own-model', { model: 'claude-haiku-4' });
    const follower = schedule('follower');

    const outcome = store.approvals.parkAgentFollowers(AGENT, [...MODEL_CHANGE]);

    expect(outcome.parked).toEqual([follower.id]);
    expect(row(own.id).status).toBe('active');
    expect(row(own.id).approvedContentKey).not.toBeNull();
  });

  it('parks a switched-off approved schedule without switching it on', () => {
    const task = schedule('dormant');
    store.updateTask(task.id, { enabled: false });

    store.approvals.parkAgentFollowers(AGENT, [...MODEL_CHANGE]);

    expect(row(task.id).status).toBe('pending_approval');
    expect(row(task.id).enabled).toBe(false);
  });

  it('never touches a paused schedule, or another agent’s', () => {
    // Paused the way a vanished file pauses it (`markRemovedByFilePath`).
    const paused = schedule('paused');
    store.fileSync.markRemovedByFilePath(paused.filePath);
    const other = schedule('other', {}, 'agent-2');

    const outcome = store.approvals.parkAgentFollowers(AGENT, [...MODEL_CHANGE]);

    expect(outcome.parked).toEqual([]);
    expect(row(paused.id).status).toBe('paused');
    expect(row(other.id).status).toBe('active');
  });

  it('keeps the first value and follows the latest across two changes', () => {
    const task = schedule('digest');
    store.approvals.parkAgentFollowers(AGENT, [...MODEL_CHANGE]);

    const outcome = store.approvals.parkAgentFollowers(AGENT, [
      { field: 'model', from: 'claude-opus-4', to: 'gpt-5' },
    ]);

    expect(outcome).toEqual({ parked: [], updated: [task.id] });
    expect(store.getTask(task.id)!.approvalChanges).toEqual([
      { field: 'model', from: 'claude-sonnet-4', to: 'gpt-5', via: 'agent' },
    ]);
  });

  it('stays parked when the agent is changed back, and shows nothing left to compare', () => {
    // Purpose: an agent that edits, gets caught, and reverts must not get its
    // schedule running again on its own; only a person switches anything on.
    const task = schedule('digest');
    store.approvals.parkAgentFollowers(AGENT, [...MODEL_CHANGE]);

    store.approvals.parkAgentFollowers(AGENT, [
      { field: 'model', from: 'claude-opus-4', to: 'claude-sonnet-4' },
    ]);

    expect(row(task.id).status).toBe('pending_approval');
    expect(row(task.id).reason).toBe(AGENT_DEFAULTS_CHANGED_OUTSIDE_REASON);
    expect(store.getTask(task.id)!.approvalChanges).toEqual([]);
  });

  it('starts afresh once a person approves', () => {
    const task = schedule('digest');
    store.approvals.parkAgentFollowers(AGENT, [...MODEL_CHANGE]);
    store.updateTask(task.id, { status: 'active' });

    expect(row(task.id).followedAgentChanges).toBeNull();
    expect(store.getTask(task.id)!.approvalChanges).toEqual([]);

    store.approvals.parkAgentFollowers(AGENT, [{ field: 'effort', from: null, to: 'max' }]);
    expect(store.getTask(task.id)!.approvalChanges).toEqual([
      { field: 'effort', from: null, to: 'max', via: 'agent' },
    ]);
  });

  it('keeps its sentence and its changes through the next file sync', () => {
    // Purpose: the watcher and the five-minute reconciler re-sync every
    // schedule's file. For a schedule DorkOS found in a file, a sync that
    // rewrote a park it did not make would say "DorkOS found this schedule in
    // a file" over the real reason (DOR-2313).
    const def = {
      name: 'digest',
      meta: {
        name: 'digest',
        description: 'digest',
        schedule: { cron: '0 7 * * *', timezone: 'UTC', enabled: true, permissions: 'acceptEdits' },
      },
      body: 'Do digest.',
      filePath: '/skills/digest/SKILL.md',
      dirPath: '/skills/digest',
      scope: 'global',
    } as Parameters<typeof store.fileSync.upsertFromFile>[0];
    const found = store.fileSync.upsertFromFile(def, AGENT, { source: 'discovery' });
    store.updateTask(found.id, { status: 'active' });
    expect(row(found.id).origin).toBe('file');
    store.approvals.parkAgentFollowers(AGENT, [...MODEL_CHANGE]);

    store.fileSync.upsertFromFile(def, AGENT, { source: 'discovery' });

    const after = row(found.id);
    expect(after.status).toBe('pending_approval');
    expect(after.reason).toBe(AGENT_DEFAULTS_CHANGED_OUTSIDE_REASON);
    expect(store.getTask(found.id)!.approvalChanges).toEqual([
      { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'agent' },
    ]);
  });

  it('shows the agent’s change even when the withdrawn approval is in a format this build cannot read', () => {
    const task = schedule('digest');
    store.approvals.parkAgentFollowers(AGENT, [...MODEL_CHANGE]);
    db.update(pulseSchedules)
      .set({ previousApprovalKey: '["an older key"]' })
      .where(eq(pulseSchedules.id, task.id))
      .run();

    expect(store.getTask(task.id)!.approvalChanges).toEqual([
      { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'agent' },
    ]);
  });

  it('attaches nothing to a proposal nobody has approved yet', () => {
    // A person approving it will approve what the agent runs on then; there is
    // no approved value for a change to be measured from.
    const task = schedule('proposal');
    store.updateTask(task.id, { status: 'pending_approval' });

    const outcome = store.approvals.parkAgentFollowers(AGENT, [...MODEL_CHANGE]);

    expect(outcome).toEqual({ parked: [], updated: [] });
    expect(row(task.id).followedAgentChanges).toBeNull();
  });
});
