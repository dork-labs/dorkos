import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePorcelainOutput } from '../git-status.js';

vi.mock('../../lib/boundary.js', () => ({
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parsePorcelainOutput', () => {
  it('correctly parses clean repo', () => {
    const output = '## main...origin/main\n';
    const result = parsePorcelainOutput(output);
    expect(result).toEqual({
      branch: 'main',
      ahead: 0,
      behind: 0,
      modified: 0,
      staged: 0,
      untracked: 0,
      conflicted: 0,
      clean: true,
      detached: false,
      tracking: 'origin/main',
    });
  });

  it('extracts ahead/behind from branch line', () => {
    const output = '## main...origin/main [ahead 2, behind 1]\n';
    const result = parsePorcelainOutput(output);
    expect(result.ahead).toBe(2);
    expect(result.behind).toBe(1);
  });

  it('extracts ahead only', () => {
    const output = '## main...origin/main [ahead 3]\n';
    const result = parsePorcelainOutput(output);
    expect(result.ahead).toBe(3);
    expect(result.behind).toBe(0);
  });

  it('extracts behind only', () => {
    const output = '## main...origin/main [behind 5]\n';
    const result = parsePorcelainOutput(output);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(5);
  });

  it('handles detached HEAD', () => {
    const output = '## HEAD (no branch)\n M file.txt\n';
    const result = parsePorcelainOutput(output);
    expect(result.detached).toBe(true);
    expect(result.branch).toBe('HEAD');
    expect(result.tracking).toBeNull();
  });

  it('handles no tracking branch', () => {
    const output = '## main\n';
    const result = parsePorcelainOutput(output);
    expect(result.branch).toBe('main');
    expect(result.tracking).toBeNull();
  });

  it('counts modified, staged, untracked, conflicted correctly', () => {
    const output = [
      '## main...origin/main',
      ' M file1.txt',
      'M  file2.txt',
      'A  file3.txt',
      '?? file4.txt',
      'UU file5.txt',
      '',
    ].join('\n');
    const result = parsePorcelainOutput(output);
    expect(result.modified).toBe(1);
    expect(result.staged).toBe(2); // M + A
    expect(result.untracked).toBe(1);
    expect(result.conflicted).toBe(1);
    expect(result.clean).toBe(false);
  });

  it('deduplicates files staged AND modified (MM)', () => {
    const output = '## main\nMM file.txt\n';
    const result = parsePorcelainOutput(output);
    expect(result.staged).toBe(1);
    expect(result.modified).toBe(1);
  });

  it('handles deleted files', () => {
    const output = ['## main', 'D  deleted-staged.txt', ' D deleted-unstaged.txt', ''].join('\n');
    const result = parsePorcelainOutput(output);
    expect(result.staged).toBe(1);
    expect(result.modified).toBe(1);
  });
});

describe('getGitStatus', () => {
  // Integration test — calls real git CLI
  it('returns not_git_repo error for non-existent directory', async () => {
    const { getGitStatus } = await import('../git-status.js');
    const result = await getGitStatus('/nonexistent-path-that-does-not-exist');
    expect(result).toEqual({ error: 'not_git_repo' });
  });

  it('returns parsed status for real git repo', async () => {
    const { getGitStatus } = await import('../git-status.js');
    // This test runs in the project repo itself
    const result = await getGitStatus(process.cwd());
    // Should not be an error since we're in a git repo
    expect(result).not.toHaveProperty('error');
    expect(result).toHaveProperty('branch');
    expect(result).toHaveProperty('clean');
    expect(result).toHaveProperty('tracking');
  });
});
