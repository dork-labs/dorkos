import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseTasks } from '../task-reader.js';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));

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

/** Build a JSONL `user` line whose tool_result content is multiple text blocks. */
function toolResultBlocksLine(toolUseId: string, texts: string[]): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: texts.map((text) => ({ type: 'text', text })),
        },
      ],
    },
  });
}

describe('parseTasks', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

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

  /**
   * DOR-1441 S-A: a successful create is not the same thing as a failed one,
   * even when its confirmation text doesn't parse — deleting it would be
   * silent data loss for a call the SDK actually completed.
   */
  it('keeps the pending row and warns when a successful result does not match the SDK confirmation format', () => {
    const lines = [
      toolUseLine('TaskCreate', 'tu1', { subject: 'Odd wording' }),
      toolResultLine('tu1', 'Something unexpected happened'),
    ];

    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 'pending:tu1', subject: 'Odd wording' });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0]!.join(' ')).toContain('tu1');
  });

  it('keeps the pending row when the confirmation text is preceded by a leading empty text block', () => {
    const lines = [
      toolUseLine('TaskCreate', 'tu1', { subject: 'Ship it' }),
      toolResultBlocksLine('tu1', ['', 'Task #3 created successfully: Ship it']),
    ];

    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: '3', subject: 'Ship it' });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('keeps the pending row when the confirmation text has incidental leading whitespace', () => {
    const lines = [
      toolUseLine('TaskCreate', 'tu1', { subject: 'Ship it' }),
      toolResultLine('tu1', ' Task #3 created successfully: Ship it'),
    ];

    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: '3', subject: 'Ship it' });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  /**
   * DOR-1441 S-B: TodoWrite keys its rows positionally ("1".."N") — the same
   * id space `TaskCreate`/`TaskUpdate` confirmations use. Without namespacing
   * them apart, a confirmed `Task #1` would silently destroy a same-keyed
   * TodoWrite row (or vice versa).
   */
  it('does not let a confirmed TaskCreate collide with a same-numbered TodoWrite row', () => {
    const lines = [
      toolUseLine('TodoWrite', 'tu_todo', {
        todos: [{ content: 'Todo one', status: 'pending' }],
      }),
      toolUseLine('TaskCreate', 'tu1', { subject: 'Task one' }),
      toolResultLine('tu1', 'Task #1 created successfully: Task one'),
    ];

    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.subject === 'Todo one')).toBeDefined();
    expect(tasks.find((t) => t.subject === 'Task one')).toMatchObject({ id: '1' });
  });
});
