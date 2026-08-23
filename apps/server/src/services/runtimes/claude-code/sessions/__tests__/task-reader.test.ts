import { describe, it, expect } from 'vitest';
import { parseTasks } from '../task-reader.js';

/** Build a JSONL `assistant` line with a single tool_use block. */
function toolUseLine(name: string, id: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, id, input }] },
  });
}

/** Build a JSONL `user` line with a single tool_result block. */
function toolResultLine(toolUseId: string, content: string, isError = false): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  });
}

describe('parseTasks', () => {
  it('materializes a TaskCreate under the SDK id its tool_result confirms', () => {
    const lines = [
      toolUseLine('TaskCreate', 'tu1', { subject: 'First task' }),
      toolResultLine('tu1', 'Task #1 created successfully: First task'),
      toolUseLine('TaskCreate', 'tu2', { subject: 'Second task' }),
      toolResultLine('tu2', 'Task #2 created successfully: Second task'),
      toolUseLine('TaskUpdate', 'tu3', { taskId: '2', status: 'in_progress' }),
    ];

    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.id === '2')).toMatchObject({
      subject: 'Second task',
      status: 'in_progress',
    });
  });

  it('holds a TaskCreate under its provisional key when its tool_result never arrives (e.g. a truncated transcript)', () => {
    const lines = [toolUseLine('TaskCreate', 'tu1', { subject: 'Pending forever' })];
    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'pending:tu1',
      subject: 'Pending forever',
      status: 'pending',
    });
  });

  it('drops a TaskCreate whose tool_result reports failure', () => {
    const lines = [
      toolUseLine('TaskCreate', 'tu1', { subject: 'Rejected' }),
      toolResultLine('tu1', 'Error: permission denied', true),
    ];
    expect(parseTasks(lines)).toEqual([]);
  });

  it('treats is_error as authoritative even when the result text looks like a success confirmation', () => {
    const lines = [
      toolUseLine('TaskCreate', 'tu1', { subject: 'Rejected' }),
      toolResultLine('tu1', 'Task #5 created successfully: Rejected', true),
    ];
    expect(parseTasks(lines)).toEqual([]);
  });

  /**
   * DOR-1441 wrong-hit regression: two SDK ids are dense sequential integers,
   * so a naive tool_use call-count diverging from the SDK's own count (here,
   * Alpha's create never resolves, so it never consumes real id "1") must
   * not let an update for real id "1" land on Alpha instead of Beta.
   */
  it('does not let an update land on the wrong task when an earlier create never resolved', () => {
    const lines = [
      toolUseLine('TaskCreate', 'tu_alpha', { subject: 'Alpha' }),
      // No tool_result for Alpha — it stays under its provisional key and
      // never claims a real numeric id.
      toolUseLine('TaskCreate', 'tu_beta', { subject: 'Beta' }),
      toolResultLine('tu_beta', 'Task #1 created successfully: Beta'),
      toolUseLine('TaskUpdate', 'tu_update', { taskId: '1', status: 'completed' }),
    ];

    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.subject === 'Beta')).toMatchObject({
      id: '1',
      status: 'completed',
    });
    expect(tasks.find((t) => t.subject === 'Alpha')).toMatchObject({
      id: 'pending:tu_alpha',
      status: 'pending',
    });
  });

  it('does not apply a TaskUpdate with no matching id', () => {
    const lines = [
      toolUseLine('TaskCreate', 'tu1', { subject: 'Only task' }),
      toolResultLine('tu1', 'Task #1 created successfully: Only task'),
      toolUseLine('TaskUpdate', 'tu2', { taskId: '9', status: 'completed' }),
    ];

    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: '1', subject: 'Only task', status: 'pending' });
  });

  it('supports duplicate subjects without cross-updating (ids are exact, no subject matching)', () => {
    const lines = [
      toolUseLine('TaskCreate', 'tu1', { subject: 'Dup' }),
      toolResultLine('tu1', 'Task #1 created successfully: Dup'),
      toolUseLine('TaskCreate', 'tu2', { subject: 'Dup' }),
      toolResultLine('tu2', 'Task #2 created successfully: Dup'),
      toolUseLine('TaskUpdate', 'tu3', { taskId: '2', status: 'completed' }),
    ];

    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.id === '1')).toMatchObject({ status: 'pending' });
    expect(tasks.find((t) => t.id === '2')).toMatchObject({ status: 'completed' });
  });
});
