import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { useSessions } from '../model/use-sessions';

// Mock useSessionId (nuqs-backed)
let mockSessionId: string | null = null;
const mockSetSessionId = vi.fn((id: string | null) => {
  mockSessionId = id;
});
vi.mock('@/layers/entities/session/model/use-session-id', () => ({
  useSessionId: () => [mockSessionId, mockSetSessionId] as const,
}));

// Mock app store (selectedCwd)
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: () => ({ selectedCwd: '/test/cwd' }),
}));

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
    getConfig: vi.fn().mockResolvedValue({ version: '1.0.0', port: 6942, uptime: 0, workingDirectory: '/test', nodeVersion: 'v20.0.0', claudeCliPath: null, tunnel: { enabled: false, connected: false, url: null, authEnabled: false, tokenConfigured: false } }),
    getGitStatus: vi.fn().mockResolvedValue({ error: 'not_git_repo' as const }),
    ...overrides,
  };
}

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionId = null;
  });

  it('lists sessions via React Query', async () => {
    const sessions = [
      { id: 's1', title: 'Session 1', createdAt: '2024-01-01', updatedAt: '2024-01-01', permissionMode: 'default' as const },
    ];
    const transport = createMockTransport({ listSessions: vi.fn().mockResolvedValue(sessions) });

    const { result } = renderHook(() => useSessions(), { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    expect(result.current.sessions[0].title).toBe('Session 1');
  });

  it('returns empty array while loading', async () => {
    const transport = createMockTransport();

    const { result } = renderHook(() => useSessions(), { wrapper: createWrapper(transport) });

    expect(result.current.sessions).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it('createSession mutation sets active session on success', async () => {
    const newSession = { id: 'new-1', title: 'New Session', createdAt: '2024-01-01', updatedAt: '2024-01-01', permissionMode: 'default' as const };
    const transport = createMockTransport({
      createSession: vi.fn().mockResolvedValue(newSession),
      listSessions: vi.fn().mockResolvedValue([newSession]),
    });

    const { result } = renderHook(() => useSessions(), { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    result.current.createSession.mutate({ permissionMode: 'default' });

    await waitFor(() => {
      expect(mockSetSessionId).toHaveBeenCalledWith('new-1');
    });
  });

  it('exposes setActiveSession', async () => {
    const transport = createMockTransport();

    const { result } = renderHook(() => useSessions(), { wrapper: createWrapper(transport) });

    act(() => {
      result.current.setActiveSession('test-id');
    });

    expect(mockSetSessionId).toHaveBeenCalledWith('test-id');
  });
});
