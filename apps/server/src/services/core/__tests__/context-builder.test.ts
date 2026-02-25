import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../git-status.js', () => ({
  getGitStatus: vi.fn(),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
}));

import { buildSystemPromptAppend } from '../context-builder.js';
import { getGitStatus } from '../git-status.js';
import type { GitStatusResponse } from '@dorkos/shared/types';

const mockedGetGitStatus = vi.mocked(getGitStatus);

function makeGitStatus(overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return {
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
    ...overrides,
  };
}

describe('buildSystemPromptAppend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockedGetGitStatus.mockResolvedValue(makeGitStatus());
  });

  it('returns string containing <env> block', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('</env>');
  });

  it('<env> contains all required fields', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Working directory: /test/dir');
    expect(result).toContain('Product: DorkOS');
    expect(result).toMatch(/Version: /);
    expect(result).toMatch(/Port: /);
    expect(result).toMatch(/Platform: /);
    expect(result).toMatch(/OS Version: /);
    expect(result).toMatch(/Node\.js: /);
    expect(result).toMatch(/Hostname: /);
    expect(result).toMatch(/Date: /);
  });

  it('Date field is valid ISO 8601', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    const dateMatch = result.match(/Date: (.+)/);
    expect(dateMatch).not.toBeNull();
    const parsed = new Date(dateMatch![1]);
    expect(parsed.toISOString()).toBe(dateMatch![1]);
  });

  it('Version defaults to "development" when env unset', async () => {
    delete process.env.DORKOS_VERSION;
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Version: development');
  });

  it('<git_status> shows "Is git repo: false" for non-git dirs', async () => {
    mockedGetGitStatus.mockResolvedValue({ error: 'not_git_repo' as const });
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<git_status>');
    expect(result).toContain('Is git repo: false');
    expect(result).toContain('</git_status>');
  });

  it('<git_status> shows branch when git repo', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ branch: 'feat/my-feature' }));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Is git repo: true');
    expect(result).toContain('Current branch: feat/my-feature');
  });

  it('omits "Ahead of origin" when ahead=0', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ ahead: 0 }));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).not.toContain('Ahead of origin');
  });

  it('shows "Ahead of origin" when ahead>0', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ ahead: 3 }));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Ahead of origin: 3 commits');
  });

  it('shows "Working tree: clean" when all counts zero', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ clean: true }));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Working tree: clean');
  });

  it('shows "Working tree: dirty" with only non-zero counts', async () => {
    mockedGetGitStatus.mockResolvedValue(
      makeGitStatus({
        clean: false,
        modified: 2,
        staged: 0,
        untracked: 3,
        conflicted: 0,
      })
    );
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Working tree: dirty (2 modified, 3 untracked)');
    expect(result).not.toContain('staged');
    expect(result).not.toContain('conflicted');
  });

  it('shows "Detached HEAD" only when detached', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ detached: false }));
    let result = await buildSystemPromptAppend('/test/dir');
    expect(result).not.toContain('Detached HEAD');

    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ detached: true, branch: 'HEAD' }));
    result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Detached HEAD: true');
  });

  it('git failure still returns env block (no throw)', async () => {
    mockedGetGitStatus.mockRejectedValue(new Error('git not found'));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('</env>');
  });
});
