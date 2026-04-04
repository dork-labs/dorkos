import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

// Must import after mock setup
const { checkClaude } = await import('../check-claude.js');

describe('checkClaude', () => {
  let mockConsoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    mockConsoleWarn.mockRestore();
  });

  it('returns true when claude CLI is available', () => {
    mockExecSync.mockReturnValue(Buffer.from('1.0.0'));

    const result = checkClaude();

    expect(result).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith('claude --version', { stdio: 'pipe' });
    expect(mockConsoleWarn).not.toHaveBeenCalled();
  });

  it('returns false when claude CLI is not found', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });

    const result = checkClaude();

    expect(result).toBe(false);
  });

  it('prints install instructions when claude CLI is not found', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });

    checkClaude();

    const output = mockConsoleWarn.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Claude Code CLI not found');
    expect(output).toContain('Install it with');
  });
});
