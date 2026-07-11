import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

function taskInput(name: string): CreateTaskStoreInput {
  return {
    name,
    description: 'test',
    prompt: 'test',
    agentId: 'agent-1',
    filePath: `/tmp/tasks/${name}/SKILL.md`,
  };
}

/** Wait for the fire-and-forget queueMicrotask dispatch to settle. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TaskStore run-terminal hook (DOR-240)', () => {
  let store: TaskStore;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  it('fires exactly once on a non-terminal → terminal transition, with run and task', async () => {
    const task = store.createTask(taskInput('nightly'));
    const created = store.createRun(task.id, 'scheduled');
    const listener = vi.fn();
    store.setOnRunTerminal(listener);

    store.updateRun(created.id, { status: 'completed', durationMs: 1000 });
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);
    const [run, passedTask] = listener.mock.calls[0];
    expect(run.id).toBe(created.id);
    expect(run.status).toBe('completed');
    expect(passedTask?.id).toBe(task.id);
    expect(passedTask?.agentId).toBe('agent-1');
  });

  it('does NOT fire on a running (non-terminal) write', async () => {
    const task = store.createTask(taskInput('idle'));
    const created = store.createRun(task.id, 'scheduled');
    const listener = vi.fn();
    store.setOnRunTerminal(listener);

    store.updateRun(created.id, { status: 'running', sessionId: 'sess-1' });
    await flush();

    expect(listener).not.toHaveBeenCalled();
  });

  it('does NOT fire again on the already-terminal no-op (DOR-248 stomp path)', async () => {
    const task = store.createTask(taskInput('double'));
    const created = store.createRun(task.id, 'scheduled');
    const listener = vi.fn();
    store.setOnRunTerminal(listener);

    // First terminal write fires the hook.
    store.updateRun(created.id, { status: 'completed', durationMs: 1000 });
    // A later stomp (e.g. the scheduler's post-publish status:'running') is
    // ignored by the terminal guard and must NOT re-fire the hook.
    store.updateRun(created.id, { status: 'running' });
    store.updateRun(created.id, { status: 'failed', error: 'late' });
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);
    // The run's terminal outcome is unchanged by the later stomps.
    expect(store.getRun(created.id)?.status).toBe('completed');
  });

  it('a throwing listener does not break the DB write or the returned run', async () => {
    const task = store.createTask(taskInput('throws'));
    const created = store.createRun(task.id, 'scheduled');
    store.setOnRunTerminal(() => {
      throw new Error('listener boom');
    });

    const returned = store.updateRun(created.id, { status: 'completed', durationMs: 1000 });
    await flush();

    expect(returned?.status).toBe('completed');
    expect(store.getRun(created.id)?.status).toBe('completed');
  });

  it('does nothing when no listener is registered (unchanged behavior)', async () => {
    const task = store.createTask(taskInput('nolistener'));
    const created = store.createRun(task.id, 'scheduled');
    const returned = store.updateRun(created.id, { status: 'completed', durationMs: 1000 });
    await flush();
    expect(returned?.status).toBe('completed');
  });
});
