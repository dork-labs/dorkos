import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

// Must import after mock setup
const { checkClaude } = await import('../check-claude.js');

describe('checkClaude', () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  it('does nothing when claude CLI is available', () => {
    mockExecSync.mockReturnValue(Buffer.from('1.0.0'));

    checkClaude();

    expect(mockExecSync).toHaveBeenCalledWith('claude --version', { stdio: 'pipe' });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('exits with code 1 when claude CLI is not found', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });

    checkClaude();

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('prints install instructions when claude CLI is not found', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });

    checkClaude();

    const output = mockConsoleError.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Claude Code CLI not found');
    expect(output).toContain('npm install -g @anthropic-ai/claude-code');
  });
});
