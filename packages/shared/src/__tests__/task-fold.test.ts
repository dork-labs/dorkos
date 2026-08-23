import { describe, it, expect } from 'vitest';
import { applyTaskEvent, createTaskFoldState } from '../task-fold.js';
import type { TaskUpdateEvent } from '../schemas.js';

describe('applyTaskEvent', () => {
  it('creates a task under its provisional key and re-keys it once an id is assigned', () => {
    const state = createTaskFoldState();
    applyTaskEvent(
      state,
      {
        action: 'create',
        task: { id: 'pending:tu1', subject: 'One', status: 'pending' },
      },
      1000
    );
    expect(state.tasks.has('pending:tu1')).toBe(true);

    applyTaskEvent(
      state,
      {
        action: 'id_assigned',
        task: { id: '1', subject: '', status: 'pending' },
        previousId: 'pending:tu1',
      },
      1001
    );

    expect(state.tasks.has('pending:tu1')).toBe(false);
    expect(state.tasks.get('1')).toMatchObject({ id: '1', subject: 'One' });
  });

  it('a later create can never clobber a re-keyed task, even under dense sequential real ids', () => {
    // Regression for the reviewed B1 finding: re-keying "One" to real id "2"
    // must not be overwritten when a later TaskCreate is independently
    // assigned that same real id "2" by its own tool_result.
    const state = createTaskFoldState();
    applyTaskEvent(
      state,
      { action: 'create', task: { id: 'pending:tu1', subject: 'One', status: 'pending' } },
      1
    );
    applyTaskEvent(
      state,
      {
        action: 'id_assigned',
        task: { id: '2', subject: '', status: 'pending' },
        previousId: 'pending:tu1',
      },
      2
    );
    applyTaskEvent(
      state,
      { action: 'update', task: { id: '2', subject: 'One', status: 'in_progress' } },
      3
    );

    // A second, unrelated create — provisional keys are per-tool_use, so this
    // can never collide with "2" regardless of what real id it is later
    // assigned.
    applyTaskEvent(
      state,
      { action: 'create', task: { id: 'pending:tu2', subject: 'Two', status: 'pending' } },
      4
    );

    expect(state.tasks.get('2')).toMatchObject({ subject: 'One', status: 'in_progress' });
    expect(state.tasks.get('pending:tu2')).toMatchObject({ subject: 'Two' });
    expect(state.tasks.size).toBe(2);
  });

  it('update only matches the exact SDK id — never a wrong hit via subject or position', () => {
    // Two tasks, both re-keyed to dense sequential real ids "1" and "2".
    const state = createTaskFoldState();
    applyTaskEvent(
      state,
      { action: 'create', task: { id: 'pending:a', subject: 'Alpha', status: 'pending' } },
      1
    );
    applyTaskEvent(
      state,
      {
        action: 'id_assigned',
        task: { id: '1', subject: '', status: 'pending' },
        previousId: 'pending:a',
      },
      2
    );
    applyTaskEvent(
      state,
      { action: 'create', task: { id: 'pending:b', subject: 'Beta', status: 'pending' } },
      3
    );
    applyTaskEvent(
      state,
      {
        action: 'id_assigned',
        task: { id: '2', subject: '', status: 'pending' },
        previousId: 'pending:b',
      },
      4
    );

    // Update targets exactly id "2" (Beta) — Alpha ("1") must be untouched.
    applyTaskEvent(
      state,
      { action: 'update', task: { id: '2', subject: '', status: 'completed' } },
      5
    );

    expect(state.tasks.get('1')).toMatchObject({ subject: 'Alpha', status: 'pending' });
    expect(state.tasks.get('2')).toMatchObject({ subject: 'Beta', status: 'completed' });
  });

  it('remove drops a pending create whose tool call failed', () => {
    const state = createTaskFoldState();
    applyTaskEvent(
      state,
      {
        action: 'create',
        task: { id: 'pending:tu1', subject: 'Never happens', status: 'pending' },
      },
      1
    );
    applyTaskEvent(
      state,
      { action: 'remove', task: { id: 'pending:tu1', subject: '', status: 'pending' } },
      2
    );

    expect(state.tasks.size).toBe(0);
  });

  it('update is a no-op when the id is unknown (no fallback, by design)', () => {
    const state = createTaskFoldState();
    applyTaskEvent(
      state,
      { action: 'create', task: { id: 'pending:tu1', subject: 'Only task', status: 'pending' } },
      1
    );
    applyTaskEvent(
      state,
      {
        action: 'id_assigned',
        task: { id: '1', subject: '', status: 'pending' },
        previousId: 'pending:tu1',
      },
      2
    );

    applyTaskEvent(
      state,
      { action: 'update', task: { id: '9', subject: '', status: 'completed' } },
      3
    );

    expect(state.tasks.get('1')).toMatchObject({ status: 'pending' });
    expect(state.tasks.size).toBe(1);
  });

  it('re-keying preserves blockedBy/blocks references pointing at other tasks', () => {
    const state = createTaskFoldState();
    applyTaskEvent(
      state,
      { action: 'create', task: { id: 'pending:dep', subject: 'Dep', status: 'pending' } },
      1
    );
    applyTaskEvent(
      state,
      {
        action: 'id_assigned',
        task: { id: '1', subject: '', status: 'pending' },
        previousId: 'pending:dep',
      },
      2
    );
    applyTaskEvent(
      state,
      {
        action: 'create',
        task: { id: 'pending:blocked', subject: 'Blocked', status: 'pending' },
      },
      3
    );
    applyTaskEvent(
      state,
      {
        action: 'id_assigned',
        task: { id: '2', subject: '', status: 'pending' },
        previousId: 'pending:blocked',
      },
      4
    );
    applyTaskEvent(
      state,
      { action: 'update', task: { id: '2', subject: '', status: 'pending', blockedBy: ['1'] } },
      5
    );

    expect(state.tasks.get('2')?.blockedBy).toEqual(['1']);
    // The dependency id "1" still resolves to a real task in the map.
    expect(state.tasks.has('1')).toBe(true);
  });

  it('carries the status timestamp across a re-key instead of dropping it', () => {
    const state = createTaskFoldState();
    applyTaskEvent(
      state,
      { action: 'create', task: { id: 'pending:tu1', subject: 'One', status: 'pending' } },
      100
    );
    applyTaskEvent(
      state,
      {
        action: 'id_assigned',
        task: { id: '5', subject: '', status: 'pending' },
        previousId: 'pending:tu1',
      },
      200
    );

    expect(state.statusTimestamps.has('pending:tu1')).toBe(false);
    expect(state.statusTimestamps.get('5')).toEqual({ status: 'pending', since: 100 });
  });

  it('a rename-only update (no status change) does not touch the status timestamp', () => {
    const state = createTaskFoldState();
    applyTaskEvent(
      state,
      { action: 'create', task: { id: 'pending:tu1', subject: 'One', status: 'pending' } },
      100
    );
    applyTaskEvent(
      state,
      {
        action: 'id_assigned',
        task: { id: '1', subject: '', status: 'pending' },
        previousId: 'pending:tu1',
      },
      100
    );
    // status: '' is the "not provided" sentinel — a subject-only rename.
    const renameOnly: TaskUpdateEvent = {
      action: 'update',
      task: { id: '1', subject: 'Renamed', status: '' as TaskUpdateEvent['task']['status'] },
    };
    applyTaskEvent(state, renameOnly, 999);

    expect(state.tasks.get('1')).toMatchObject({ subject: 'Renamed', status: 'pending' });
    expect(state.statusTimestamps.get('1')).toEqual({ status: 'pending', since: 100 });
  });

  it('snapshot (TodoWrite) clears prior task state and rebuilds from the full list', () => {
    const state = createTaskFoldState();
    applyTaskEvent(
      state,
      { action: 'create', task: { id: 'pending:tu1', subject: 'Stale', status: 'pending' } },
      1
    );
    applyTaskEvent(
      state,
      {
        action: 'snapshot',
        task: { id: '1', subject: 'Buy milk', status: 'pending' },
        tasks: [{ id: '1', subject: 'Buy milk', status: 'pending' }],
      },
      2
    );

    expect(state.tasks.size).toBe(1);
    expect(state.tasks.get('1')).toMatchObject({ subject: 'Buy milk' });
  });
});
