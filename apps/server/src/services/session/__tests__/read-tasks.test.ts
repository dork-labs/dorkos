import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriptReader } from '../transcript-reader.js';

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

describe('TranscriptReader.readTasks', () => {
  let reader: TranscriptReader;
  const vaultRoot = '/test/vault';

  beforeEach(() => {
    reader = new TranscriptReader();
    vi.clearAllMocks();
  });

  it('returns empty array when file does not exist', async () => {
    mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
    const tasks = await reader.readTasks(vaultRoot, 'nonexistent');
    expect(tasks).toEqual([]);
  });

  it('parses TaskCreate tool_use blocks', async () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TaskCreate',
              id: 'tc1',
              input: {
                subject: 'First task',
                description: 'Do something',
                activeForm: 'Doing something',
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TaskCreate',
              id: 'tc2',
              input: { subject: 'Second task' },
            },
          ],
        },
      }),
    ];

    mockFs.readFile.mockResolvedValue(lines.join('\n'));

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

  it('applies TaskUpdate to existing tasks', async () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'TaskCreate', id: 'tc1', input: { subject: 'Task A' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TaskUpdate',
              id: 'tc2',
              input: { taskId: '1', status: 'in_progress', activeForm: 'Working on A' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TaskUpdate',
              id: 'tc3',
              input: { taskId: '1', status: 'completed' },
            },
          ],
        },
      }),
    ];

    mockFs.readFile.mockResolvedValue(lines.join('\n'));

    const tasks = await reader.readTasks(vaultRoot, 'session-1');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: '1',
      subject: 'Task A',
      status: 'completed',
      activeForm: 'Working on A',
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

    mockFs.readFile.mockResolvedValue(lines.join('\n'));

    const tasks = await reader.readTasks(vaultRoot, 'session-1');
    expect(tasks).toEqual([]);
  });

  it('ignores TaskUpdate for nonexistent tasks', async () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TaskUpdate',
              id: 'tc1',
              input: { taskId: '99', status: 'completed' },
            },
          ],
        },
      }),
    ];

    mockFs.readFile.mockResolvedValue(lines.join('\n'));

    const tasks = await reader.readTasks(vaultRoot, 'session-1');
    expect(tasks).toEqual([]);
  });

  it('handles malformed JSON lines gracefully', async () => {
    const lines = [
      'not valid json',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'TaskCreate', id: 'tc1', input: { subject: 'Valid task' } },
          ],
        },
      }),
    ];

    mockFs.readFile.mockResolvedValue(lines.join('\n'));

    const tasks = await reader.readTasks(vaultRoot, 'session-1');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe('Valid task');
  });
});
