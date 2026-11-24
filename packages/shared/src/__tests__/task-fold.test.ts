import { describe, it, expect } from 'vitest';
import { applyTaskEvent, createTaskFoldState } from '../task-fold.js';

describe('applyTaskEvent', () => {
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

  /**
   * DOR-1441 S-B: TodoWrite rows and Task-tool ids fold into the same map.
   * When the caller namespaces TodoWrite ids (`todo:<n>`, see
   * `build-task-event.ts`'s `todoItemId`), a confirmed `TaskCreate` landing
   * on the same positional number must not destroy the TodoWrite row.
   */
  it('a namespaced TodoWrite row and a same-numbered TaskCreate id coexist', () => {
    const state = createTaskFoldState();
    applyTaskEvent(
      state,
      {
        action: 'snapshot',
        task: { id: 'todo:1', subject: 'Todo one', status: 'pending' },
        tasks: [{ id: 'todo:1', subject: 'Todo one', status: 'pending' }],
      },
      1
    );
    applyTaskEvent(
      state,
      { action: 'create', task: { id: 'pending:tu1', subject: 'Task one', status: 'pending' } },
      2
    );
    applyTaskEvent(
      state,
      {
        action: 'id_assigned',
        task: { id: '1', subject: '', status: 'pending' },
        previousId: 'pending:tu1',
      },
      3
    );

    expect(state.tasks.size).toBe(2);
    expect(state.tasks.get('todo:1')).toMatchObject({ subject: 'Todo one' });
    expect(state.tasks.get('1')).toMatchObject({ subject: 'Task one' });
  });
});
