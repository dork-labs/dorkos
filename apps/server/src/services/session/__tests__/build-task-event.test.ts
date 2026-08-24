import { describe, it, expect } from 'vitest';
import {
  buildTaskEvent,
  buildTaskIdAssignedEvent,
  buildTaskRemovedEvent,
  buildTodoWriteEvent,
  extractTaskResultText,
  parseCreatedTaskId,
  pendingTaskId,
  todoItemId,
} from '../../runtimes/claude-code/sdk/build-task-event.js';

describe('buildTaskEvent', () => {
  it('returns a create event keyed by the provisional (pending) id for TaskCreate', () => {
    const result = buildTaskEvent(
      'TaskCreate',
      {
        subject: 'Fix the bug',
        description: 'A detailed description',
        activeForm: 'Fixing the bug',
      },
      'toolu_abc123'
    );

    expect(result).toEqual({
      action: 'create',
      task: {
        id: 'pending:toolu_abc123',
        subject: 'Fix the bug',
        description: 'A detailed description',
        activeForm: 'Fixing the bug',
        status: 'pending',
      },
    });
  });

  it('falls back to an empty id when no toolUseId is supplied', () => {
    const result = buildTaskEvent('TaskCreate', { subject: 'Fix the bug' });
    expect(result?.task.id).toBe('');
  });

  it('returns an update event carrying the SDK id as-is', () => {
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
    // Empty strings signal "not provided" — the fold strips these during merge
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
    const result = buildTaskEvent('TaskCreate', {}, 'toolu_min');

    expect(result).toEqual({
      action: 'create',
      task: {
        id: 'pending:toolu_min',
        subject: '',
        description: undefined,
        activeForm: undefined,
        status: 'pending',
      },
    });
  });
});

describe('pendingTaskId', () => {
  it('prefixes the tool_use id so it can never collide with a real SDK id', () => {
    expect(pendingTaskId('toolu_xyz')).toBe('pending:toolu_xyz');
  });
});

describe('parseCreatedTaskId', () => {
  it('parses the real id out of the SDK confirmation text', () => {
    // Verified format, drawn from a real recorded transcript.
    expect(
      parseCreatedTaskId('Task #1 created successfully: SPECIFY: chat-touch-chips 02-spec.md')
    ).toBe('1');
    expect(parseCreatedTaskId('Task #42 created successfully: Ship it')).toBe('42');
  });

  it('returns null for text that is not a create confirmation', () => {
    expect(parseCreatedTaskId('Updated task #2 status')).toBeNull();
    expect(parseCreatedTaskId('')).toBeNull();
    expect(parseCreatedTaskId('Error: permission denied')).toBeNull();
  });
});

describe('extractTaskResultText', () => {
  it('returns a plain string content unchanged', () => {
    expect(extractTaskResultText('Task #1 created successfully: X')).toBe(
      'Task #1 created successfully: X'
    );
  });

  it('joins text blocks from an array content', () => {
    expect(extractTaskResultText([{ type: 'text', text: 'Task #1 created successfully: X' }])).toBe(
      'Task #1 created successfully: X'
    );
  });

  it('returns empty string for missing or non-text content', () => {
    expect(extractTaskResultText(undefined)).toBe('');
    expect(extractTaskResultText(null)).toBe('');
    expect(extractTaskResultText(42)).toBe('');
  });
});

describe('buildTaskIdAssignedEvent', () => {
  it('re-keys the provisional id to the confirmed real id', () => {
    expect(buildTaskIdAssignedEvent('toolu_abc', '7')).toEqual({
      action: 'id_assigned',
      task: { id: '7', subject: '', status: 'pending' },
      previousId: 'pending:toolu_abc',
    });
  });
});

describe('buildTaskRemovedEvent', () => {
  it('targets the provisional id for removal', () => {
    expect(buildTaskRemovedEvent('toolu_abc')).toEqual({
      action: 'remove',
      task: { id: 'pending:toolu_abc', subject: '', status: 'pending' },
    });
  });
});

describe('todoItemId', () => {
  it('namespaces the positional index so it can never collide with a real SDK task id', () => {
    // DOR-1441 S-B: an unprefixed "1" is indistinguishable from the SDK's
    // own TaskCreate numbering, which folds into the same task map.
    expect(todoItemId(0)).toBe('todo:1');
    expect(todoItemId(1)).toBe('todo:2');
  });
});

describe('buildTodoWriteEvent', () => {
  it('keys each todo by its namespaced positional id', () => {
    const result = buildTodoWriteEvent({
      todos: [
        { content: 'First', status: 'pending' },
        { content: 'Second', status: 'in_progress', activeForm: 'Doing second' },
      ],
    });

    expect(result).toEqual({
      action: 'snapshot',
      task: { id: 'todo:1', subject: 'First', status: 'pending', activeForm: undefined },
      tasks: [
        { id: 'todo:1', subject: 'First', status: 'pending', activeForm: undefined },
        {
          id: 'todo:2',
          subject: 'Second',
          status: 'in_progress',
          activeForm: 'Doing second',
        },
      ],
    });
  });

  it('returns null for an empty or missing todos array', () => {
    expect(buildTodoWriteEvent({ todos: [] })).toBeNull();
    expect(buildTodoWriteEvent({})).toBeNull();
  });
});
