// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/lib';
import { useGitStatus, isGitStatusOk } from '../model/use-git-status';
import type { GitStatusResponse, GitStatusError } from '@dorkos/shared/types';

function createMockTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    getSession: vi.fn(),
    getMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    denyTool: vi.fn(),
    submitAnswers: vi.fn().mockResolvedValue({ ok: true }),
    getCommands: vi.fn(),
    health: vi.fn(),
    updateSession: vi.fn(),
    browseDirectory: vi.fn().mockResolvedValue({ path: '/test', entries: [], parent: null }),
    getDefaultCwd: vi.fn().mockResolvedValue({ path: '/test/cwd' }),
    listFiles: vi.fn().mockResolvedValue({ files: [], truncated: false, total: 0 }),
    getGitStatus: vi.fn().mockResolvedValue({ error: 'not_git_repo' as const }),
    getConfig: vi.fn().mockResolvedValue({ version: '1.0.0', port: 6942, uptime: 0, workingDirectory: '/test', nodeVersion: 'v20.0.0', claudeCliPath: null, tunnel: { enabled: false, connected: false, url: null, authEnabled: false, tokenConfigured: false } }),
    ...overrides,
  };
}

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useGitStatus', () => {
  it('calls transport.getGitStatus with cwd', async () => {
    const mockStatus: GitStatusResponse = {
      branch: 'main', ahead: 0, behind: 0,
      modified: 1, staged: 0, untracked: 0, conflicted: 0,
      clean: false, detached: false, tracking: 'origin/main',
    };
    const transport = createMockTransport({
      getGitStatus: vi.fn().mockResolvedValue(mockStatus),
    });
    const { result } = renderHook(() => useGitStatus('/test/dir'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(transport.getGitStatus).toHaveBeenCalledWith('/test/dir');
    expect(result.current.data).toEqual(mockStatus);
  });

  it('does not fetch when cwd is null', () => {
    const transport = createMockTransport();
    renderHook(() => useGitStatus(null), {
      wrapper: createWrapper(transport),
    });
    expect(transport.getGitStatus).not.toHaveBeenCalled();
  });
});

describe('isGitStatusOk', () => {
  it('returns true for valid status', () => {
    const status: GitStatusResponse = {
      branch: 'main', ahead: 0, behind: 0,
      modified: 0, staged: 0, untracked: 0, conflicted: 0,
      clean: true, detached: false, tracking: null,
    };
    expect(isGitStatusOk(status)).toBe(true);
  });

  it('returns false for error response', () => {
    const error: GitStatusError = { error: 'not_git_repo' };
    expect(isGitStatusOk(error)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isGitStatusOk(undefined)).toBe(false);
  });
});
