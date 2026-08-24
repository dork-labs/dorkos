import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriptReader } from '../../runtimes/claude-code/sessions/transcript-reader.js';

vi.mock('fs/promises', () => ({
  default: {
    readdir: vi.fn(),
    stat: vi.fn(),
    open: vi.fn(),
    readFile: vi.fn(),
  },
}));
vi.mock('../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/path'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/path'),
  getBoundary: vi.fn().mockReturnValue('/mock/boundary'),
  initBoundary: vi.fn().mockResolvedValue('/mock/boundary'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));

import fs from 'fs/promises';

const mockFs = vi.mocked(fs);

/** Build an `assistant` JSONL line with a single tool_use block. */
function toolUseLine(name: string, id: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, id, input }] },
  });
}

/** Build a `user` JSONL line with a single tool_result block (the SDK's real shape). */
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

describe('TranscriptReader.readTasks', () => {
  let reader: TranscriptReader;
  const vaultRoot = '/test/vault';

  /** Create an ENOENT error for the todo file (readTodosFromFile returns null). */
  function enoentError(): NodeJS.ErrnoException {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    return err;
  }

  beforeEach(() => {
    reader = new TranscriptReader();
    vi.clearAllMocks();
  });

  it('returns empty array when file does not exist', async () => {
    mockFs.readFile.mockRejectedValue(enoentError());
    const tasks = await reader.readTasks(vaultRoot, 'nonexistent');
    expect(tasks).toEqual([]);
  });

  it('parses TaskCreate once its tool_result confirms the real SDK id (real-shaped transcript)', async () => {
    // Drawn from a real recorded transcript's TaskCreate/tool_result pair shape.
    const lines = [
      toolUseLine('TaskCreate', 'toolu_01L95htozh6DZGjbiQFWL3BD', {
        subject: 'First task',
        description: 'Do something',
        activeForm: 'Doing something',
      }),
      toolResultLine('toolu_01L95htozh6DZGjbiQFWL3BD', 'Task #1 created successfully: First task'),
      toolUseLine('TaskCreate', 'toolu_01UTa6VafF6MD1phwbhw4eAT', { subject: 'Second task' }),
      toolResultLine('toolu_01UTa6VafF6MD1phwbhw4eAT', 'Task #2 created successfully: Second task'),
    ];

    mockFs.readFile.mockRejectedValueOnce(enoentError()).mockResolvedValueOnce(lines.join('\n'));

    const tasks = await reader.readTasks(vaultRoot, 'session-1');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      id: '1',
      subject: 'First task',
      description: 'Do something',
      activeForm: 'Doing something',
      status: 'pending',
    });
    expect(tasks[1]).toMatchObject({
      id: '2',
      subject: 'Second task',
      status: 'pending',
    });
  });

  it('drops a TaskCreate whose tool_result reports failure', async () => {
    const lines = [
      toolUseLine('TaskCreate', 'toolu_fail', { subject: 'Never happens' }),
      toolResultLine('toolu_fail', 'Error: permission denied', true),
    ];

    mockFs.readFile.mockRejectedValueOnce(enoentError()).mockResolvedValueOnce(lines.join('\n'));

    const tasks = await reader.readTasks(vaultRoot, 'session-1');
    expect(tasks).toEqual([]);
  });

  it('applies TaskUpdate to a task confirmed by its tool_result', async () => {
    const lines = [
      toolUseLine('TaskCreate', 'toolu_a', { subject: 'Task A' }),
      toolResultLine('toolu_a', 'Task #1 created successfully: Task A'),
      toolUseLine('TaskUpdate', 'toolu_b', {
        taskId: '1',
        status: 'in_progress',
        activeForm: 'Working on A',
      }),
      toolUseLine('TaskUpdate', 'toolu_c', { taskId: '1', status: 'completed' }),
    ];

    mockFs.readFile.mockRejectedValueOnce(enoentError()).mockResolvedValueOnce(lines.join('\n'));

    const tasks = await reader.readTasks(vaultRoot, 'session-1');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: '1',
      subject: 'Task A',
      status: 'completed',
      activeForm: 'Working on A',
    });
  });

  /**
   * DOR-1441 wrong-hit regression: dense sequential SDK ids that diverge from
   * this reader's naive tool_use call count by one (a create whose tool_result
   * never confirmed a real id) must not let a later update land on the wrong
   * task.
   */
  it('does not let a later TaskUpdate land on the wrong task when an earlier TaskCreate never resolved', async () => {
    const lines = [
      toolUseLine('TaskCreate', 'toolu_alpha', { subject: 'Alpha' }),
      // Alpha's tool_result never arrives (e.g. an interrupted transcript) —
      // Alpha stays under its provisional key and never claims a real id, so
      // the SDK's real id "1" for Beta below cannot collide with it.
      toolUseLine('TaskCreate', 'toolu_beta', { subject: 'Beta' }),
      toolResultLine('toolu_beta', 'Task #1 created successfully: Beta'),
      toolUseLine('TaskUpdate', 'toolu_update', { taskId: '1', status: 'completed' }),
    ];

    mockFs.readFile.mockRejectedValueOnce(enoentError()).mockResolvedValueOnce(lines.join('\n'));

    const tasks = await reader.readTasks(vaultRoot, 'session-1');
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.subject === 'Beta')).toMatchObject({
      id: '1',
      status: 'completed',
    });
    expect(tasks.find((t) => t.subject === 'Alpha')).toMatchObject({
      id: 'pending:toolu_alpha',
      status: 'pending',
    });
  });

  it('ignores non-assistant messages and non-task tools', async () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'Hello' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', id: 'tc1', input: { file_path: '/foo' } }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Some response' }],
        },
      }),
    ];

    mockFs.readFile.mockRejectedValueOnce(enoentError()).mockResolvedValueOnce(lines.join('\n'));

    const tasks = await reader.readTasks(vaultRoot, 'session-1');
    expect(tasks).toEqual([]);
  });

  it('ignores TaskUpdate for nonexistent tasks', async () => {
    const lines = [toolUseLine('TaskUpdate', 'tc1', { taskId: '99', status: 'completed' })];

    mockFs.readFile.mockRejectedValueOnce(enoentError()).mockResolvedValueOnce(lines.join('\n'));

    const tasks = await reader.readTasks(vaultRoot, 'session-1');
    expect(tasks).toEqual([]);
  });

  it('handles malformed JSON lines gracefully', async () => {
    const lines = [
      'not valid json',
      toolUseLine('TaskCreate', 'tc1', { subject: 'Valid task' }),
      toolResultLine('tc1', 'Task #1 created successfully: Valid task'),
    ];

    mockFs.readFile.mockRejectedValueOnce(enoentError()).mockResolvedValueOnce(lines.join('\n'));

    const tasks = await reader.readTasks(vaultRoot, 'session-1');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe('Valid task');
  });
});
