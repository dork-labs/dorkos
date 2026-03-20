import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoist mock functions so they are accessible inside vi.mock() factory closures.
const { mockReadTranscript, mockLoggerWarn, transcriptReaderFactory } = vi.hoisted(() => {
  const mockReadTranscript = vi.fn();
  const mockLoggerWarn = vi.fn();
  const transcriptReaderFactory = () => ({
    TranscriptReader: vi.fn().mockImplementation(() => ({
      readTranscript: mockReadTranscript,
      hasTranscript: vi.fn().mockResolvedValue(false),
      getProjectSlug: vi.fn().mockReturnValue('mock-slug'),
      getTranscriptsDir: vi.fn().mockReturnValue('/mock/.claude/projects/mock-slug'),
    })),
  });
  return { mockReadTranscript, mockLoggerWarn, transcriptReaderFactory };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../transcript-reader.js', transcriptReaderFactory);
vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
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

type HistoryMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

describe('ClaudeCodeRuntime.getLastMessageIds', () => {
  let runtime: InstanceType<typeof import('../claude-code-runtime.js').ClaudeCodeRuntime>;

  beforeEach(async () => {
    vi.resetModules();
    mockReadTranscript.mockReset();
    mockLoggerWarn.mockReset();

    const mod = await import('../claude-code-runtime.js');
    runtime = new mod.ClaudeCodeRuntime('/mock/cwd');
  });

  it('returns last user and assistant IDs from a multi-turn transcript', async () => {
    const messages: HistoryMessage[] = [
      { id: 'user-1', role: 'user', content: 'Hello' },
      { id: 'asst-1', role: 'assistant', content: 'Hi there' },
      { id: 'user-2', role: 'user', content: 'How are you?' },
      { id: 'asst-2', role: 'assistant', content: 'Good!' },
    ];
    mockReadTranscript.mockResolvedValue(messages);

    const result = await runtime.getLastMessageIds('session-1');

    expect(result).toEqual({ user: 'user-2', assistant: 'asst-2' });
  });

  it('returns the single user and assistant IDs from a one-turn transcript', async () => {
    const messages: HistoryMessage[] = [
      { id: 'user-only', role: 'user', content: 'Single question' },
      { id: 'asst-only', role: 'assistant', content: 'Single answer' },
    ];
    mockReadTranscript.mockResolvedValue(messages);

    const result = await runtime.getLastMessageIds('session-2');

    expect(result).toEqual({ user: 'user-only', assistant: 'asst-only' });
  });

  it('returns null when transcript is empty', async () => {
    mockReadTranscript.mockResolvedValue([]);

    const result = await runtime.getLastMessageIds('session-empty');

    expect(result).toBeNull();
  });

  it('returns null when only user messages exist', async () => {
    const messages: HistoryMessage[] = [{ id: 'user-1', role: 'user', content: 'Hello' }];
    mockReadTranscript.mockResolvedValue(messages);

    const result = await runtime.getLastMessageIds('session-no-asst');

    expect(result).toBeNull();
  });

  it('returns null when only assistant messages exist', async () => {
    const messages: HistoryMessage[] = [
      { id: 'asst-1', role: 'assistant', content: 'Unsolicited response' },
    ];
    mockReadTranscript.mockResolvedValue(messages);

    const result = await runtime.getLastMessageIds('session-no-user');

    expect(result).toBeNull();
  });

  it('returns null and logs a warning when readTranscript throws', async () => {
    mockReadTranscript.mockRejectedValue(new Error('ENOENT: file not found'));

    const result = await runtime.getLastMessageIds('session-error');

    expect(result).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[getLastMessageIds] failed to read transcript',
      expect.objectContaining({
        sessionId: 'session-error',
        error: 'ENOENT: file not found',
      })
    );
  });

  it('uses session cwd when session is tracked in memory', async () => {
    const messages: HistoryMessage[] = [
      { id: 'u1', role: 'user', content: 'Hi' },
      { id: 'a1', role: 'assistant', content: 'Hello' },
    ];
    mockReadTranscript.mockResolvedValue(messages);

    // Register a session with a specific cwd
    runtime.ensureSession('session-cwd', { permissionMode: 'default', cwd: '/project/dir' });

    await runtime.getLastMessageIds('session-cwd');

    // readTranscript should have been called with the session's cwd
    expect(mockReadTranscript).toHaveBeenCalledWith('/project/dir', 'session-cwd');
  });

  it('falls back to constructor cwd when session is not in memory', async () => {
    const messages: HistoryMessage[] = [
      { id: 'u1', role: 'user', content: 'Hi' },
      { id: 'a1', role: 'assistant', content: 'Hello' },
    ];
    mockReadTranscript.mockResolvedValue(messages);

    await runtime.getLastMessageIds('unknown-session');

    // readTranscript should fall back to the constructor cwd
    expect(mockReadTranscript).toHaveBeenCalledWith('/mock/cwd', 'unknown-session');
  });

  it('handles non-Error thrown values gracefully', async () => {
    mockReadTranscript.mockRejectedValue('string error');

    const result = await runtime.getLastMessageIds('session-string-err');

    expect(result).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[getLastMessageIds] failed to read transcript',
      expect.objectContaining({ error: 'string error' })
    );
  });
});
