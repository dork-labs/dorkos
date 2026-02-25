import { describe, it, expect } from 'vitest';
import { buildTaskEvent } from '../build-task-event.js';

describe('buildTaskEvent', () => {
  it('returns a create event for TaskCreate', () => {
    const result = buildTaskEvent('TaskCreate', {
      subject: 'Fix the bug',
      description: 'A detailed description',
      activeForm: 'Fixing the bug',
    });

    expect(result).toEqual({
      action: 'create',
      task: {
        id: '',
        subject: 'Fix the bug',
        description: 'A detailed description',
        activeForm: 'Fixing the bug',
        status: 'pending',
      },
    });
  });

  it('returns an update event for TaskUpdate', () => {
    const result = buildTaskEvent('TaskUpdate', {
      taskId: '3',
      status: 'completed',
      activeForm: 'Done fixing',
    });

    expect(result).toEqual({
      action: 'update',
      task: {
        id: '3',
        subject: '',
        status: 'completed',
        activeForm: 'Done fixing',
      },
    });
  });

  it('handles TaskUpdate with blockedBy and blocks', () => {
    const result = buildTaskEvent('TaskUpdate', {
      taskId: '5',
      addBlockedBy: ['1', '2'],
      addBlocks: ['7'],
    });

    expect(result).not.toBeNull();
    expect(result!.task.blockedBy).toEqual(['1', '2']);
    expect(result!.task.blocks).toEqual(['7']);
  });

  it('uses empty-string sentinel for absent status/subject in TaskUpdate', () => {
    const result = buildTaskEvent('TaskUpdate', {
      taskId: '2',
      activeForm: 'Working',
    });

    expect(result).not.toBeNull();
    // Empty strings signal "not provided" — the client strips these during merge
    expect(result!.task.status).toBe('');
    expect(result!.task.subject).toBe('');
    expect(result!.task.activeForm).toBe('Working');
  });

  it('returns null for unknown tool names', () => {
    expect(buildTaskEvent('Read', {})).toBeNull();
    expect(buildTaskEvent('TaskList', {})).toBeNull();
    expect(buildTaskEvent('TaskGet', {})).toBeNull();
  });

  it('handles TaskCreate with minimal input', () => {
    const result = buildTaskEvent('TaskCreate', {});

    expect(result).toEqual({
      action: 'create',
      task: {
        id: '',
        subject: '',
        description: undefined,
        activeForm: undefined,
        status: 'pending',
      },
    });
  });
});
