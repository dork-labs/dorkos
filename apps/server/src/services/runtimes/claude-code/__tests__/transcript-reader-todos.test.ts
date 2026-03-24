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
vi.mock('../../../../lib/boundary.js', () => ({
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
vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));

import fs from 'fs/promises';
import { logger } from '../../../../lib/logger.js';

const mockFs = vi.mocked(fs);
const mockLogger = vi.mocked(logger);

describe('TranscriptReader.readTodosFromFile', () => {
  let reader: TranscriptReader;
  const sessionId = 'abc-123-def';

  beforeEach(() => {
    reader = new TranscriptReader();
    vi.clearAllMocks();
  });

  it('returns null when todo file does not exist (ENOENT)', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    mockFs.readFile.mockRejectedValue(err);

    const result = await reader.readTodosFromFile(sessionId);
    expect(result).toBeNull();
  });

  it('throws on non-ENOENT filesystem errors', async () => {
    const err = new Error('EACCES') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    mockFs.readFile.mockRejectedValue(err);

    await expect(reader.readTodosFromFile(sessionId)).rejects.toThrow('EACCES');
  });

  it('returns null and logs warning on malformed JSON', async () => {
    mockFs.readFile.mockResolvedValue('not valid json {{{');

    const result = await reader.readTodosFromFile(sessionId);
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[readTodosFromFile] malformed JSON in todo file',
      expect.objectContaining({ sessionId })
    );
  });

  it('returns null and logs warning when file contains non-array JSON', async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ status: 'completed' }));

    const result = await reader.readTodosFromFile(sessionId);
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[readTodosFromFile] expected array in todo file',
      expect.objectContaining({ sessionId })
    );
  });

  it('returns empty array for empty JSON array', async () => {
    mockFs.readFile.mockResolvedValue('[]');

    const result = await reader.readTodosFromFile(sessionId);
    expect(result).toEqual([]);
  });

  it('maps SDK todo entries to TaskItem with all fields', async () => {
    const todos = [
      { id: 'task-1', content: 'Build feature', status: 'completed', activeForm: 'Building' },
      { id: 'task-2', content: 'Write tests', status: 'in_progress', activeForm: 'Testing' },
    ];
    mockFs.readFile.mockResolvedValue(JSON.stringify(todos));

    const result = await reader.readTodosFromFile(sessionId);
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({
      id: 'task-1',
      subject: 'Build feature',
      status: 'completed',
      activeForm: 'Building',
    });
    expect(result![1]).toEqual({
      id: 'task-2',
      subject: 'Write tests',
      status: 'in_progress',
      activeForm: 'Testing',
    });
  });

  it('assigns auto-incrementing IDs when entries lack id field', async () => {
    const todos = [
      { content: 'First task', status: 'pending' },
      { content: 'Second task', status: 'completed' },
    ];
    mockFs.readFile.mockResolvedValue(JSON.stringify(todos));

    const result = await reader.readTodosFromFile(sessionId);
    expect(result).toHaveLength(2);
    expect(result![0].id).toBe('1');
    expect(result![1].id).toBe('2');
  });

  it('uses defaults for missing optional fields', async () => {
    const todos = [{ content: 'Bare minimum' }];
    mockFs.readFile.mockResolvedValue(JSON.stringify(todos));

    const result = await reader.readTodosFromFile(sessionId);
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      id: '1',
      subject: 'Bare minimum',
      status: 'pending',
      activeForm: undefined,
    });
  });
});

describe('TranscriptReader.getTodoFileETag', () => {
  let reader: TranscriptReader;
  const sessionId = 'abc-123-def';

  beforeEach(() => {
    reader = new TranscriptReader();
    vi.clearAllMocks();
  });

  it('returns ETag string from file stat', async () => {
    mockFs.stat.mockResolvedValue({
      mtimeMs: 1700000000000,
      size: 512,
    } as Awaited<ReturnType<typeof fs.stat>>);

    const etag = await reader.getTodoFileETag(sessionId);
    expect(etag).toBe('"1700000000000-512"');
  });

  it('returns null when todo file does not exist', async () => {
    mockFs.stat.mockRejectedValue(new Error('ENOENT'));

    const etag = await reader.getTodoFileETag(sessionId);
    expect(etag).toBeNull();
  });
});

describe('readTasks() file-first fallback', () => {
  let reader: TranscriptReader;
  const sessionId = 'abc-123-def';
  const vaultRoot = '/mock/vault';

  beforeEach(() => {
    reader = new TranscriptReader();
    vi.clearAllMocks();
  });

  it('returns file data without reading JSONL when todo file exists', async () => {
    const fileTasks = [{ id: 'task-1', content: 'From file', status: 'completed' }];
    // readTodosFromFile reads from ~/.claude/todos/
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify(fileTasks));

    const result = await reader.readTasks(vaultRoot, sessionId);

    expect(result).toEqual([
      { id: 'task-1', subject: 'From file', status: 'completed', activeForm: undefined },
    ]);
    // readFile should only have been called once (for the todo file),
    // NOT a second time for the JSONL transcript
    expect(mockFs.readFile).toHaveBeenCalledTimes(1);
  });

  it('falls back to JSONL parsing when todo file does not exist', async () => {
    // First call: readTodosFromFile — ENOENT
    const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    mockFs.readFile.mockRejectedValueOnce(enoent);

    // Second call: readFile for the JSONL transcript (fallback path)
    // Return an empty file so parseTasks returns []
    mockFs.readFile.mockResolvedValueOnce('');

    const result = await reader.readTasks(vaultRoot, sessionId);

    expect(result).toEqual([]);
    // Both the todo file and the JSONL file should have been read
    expect(mockFs.readFile).toHaveBeenCalledTimes(2);
  });
});

describe('getSessionETag() combination', () => {
  let reader: TranscriptReader;
  const sessionId = 'abc-123-def';
  const vaultRoot = '/mock/vault';

  /**
   * Mirror the ETag combination logic from ClaudeCodeRuntime.getSessionETag.
   * Tested here at the TranscriptReader level to avoid mocking the full runtime.
   */
  function combineETags(transcriptETag: string | null, todoETag: string | null): string | null {
    if (transcriptETag && todoETag) {
      const bare = (tag: string) => tag.replace(/^"|"$/g, '');
      return `"${bare(transcriptETag)}-${bare(todoETag)}"`;
    }
    return transcriptETag ?? todoETag;
  }

  beforeEach(() => {
    reader = new TranscriptReader();
    vi.clearAllMocks();
  });

  it('combines both ETags when both transcript and todo file exist', async () => {
    vi.spyOn(reader, 'getTranscriptETag').mockResolvedValue('"1700000000000-1024"');
    vi.spyOn(reader, 'getTodoFileETag').mockResolvedValue('"1700000001000-512"');

    const [transcriptETag, todoETag] = await Promise.all([
      reader.getTranscriptETag(vaultRoot, sessionId),
      reader.getTodoFileETag(sessionId),
    ]);

    expect(combineETags(transcriptETag, todoETag)).toBe('"1700000000000-1024-1700000001000-512"');
  });

  it('returns only transcript ETag when todo file does not exist', async () => {
    vi.spyOn(reader, 'getTranscriptETag').mockResolvedValue('"1700000000000-1024"');
    vi.spyOn(reader, 'getTodoFileETag').mockResolvedValue(null);

    const [transcriptETag, todoETag] = await Promise.all([
      reader.getTranscriptETag(vaultRoot, sessionId),
      reader.getTodoFileETag(sessionId),
    ]);

    expect(combineETags(transcriptETag, todoETag)).toBe('"1700000000000-1024"');
  });

  it('returns only todo ETag when transcript does not exist', async () => {
    vi.spyOn(reader, 'getTranscriptETag').mockResolvedValue(null);
    vi.spyOn(reader, 'getTodoFileETag').mockResolvedValue('"1700000001000-512"');

    const [transcriptETag, todoETag] = await Promise.all([
      reader.getTranscriptETag(vaultRoot, sessionId),
      reader.getTodoFileETag(sessionId),
    ]);

    expect(combineETags(transcriptETag, todoETag)).toBe('"1700000001000-512"');
  });

  it('returns null when neither transcript nor todo file exist', async () => {
    vi.spyOn(reader, 'getTranscriptETag').mockResolvedValue(null);
    vi.spyOn(reader, 'getTodoFileETag').mockResolvedValue(null);

    const [transcriptETag, todoETag] = await Promise.all([
      reader.getTranscriptETag(vaultRoot, sessionId),
      reader.getTodoFileETag(sessionId),
    ]);

    expect(combineETags(transcriptETag, todoETag)).toBeNull();
  });
});
