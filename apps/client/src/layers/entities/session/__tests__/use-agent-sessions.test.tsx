import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { Session } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useAgentSessions } from '../model/use-agent-sessions';
import { sessionDisplayTitle, UNTITLED_SESSION_LABEL } from '../lib/session-display-title';

// Mock useSessionId (TanStack Router search params)
vi.mock('@/layers/entities/session/model/use-session-id', () => ({
  useSessionId: () => [null, vi.fn()] as const,
}));

// Mock app store (selectedCwd drives the underlying useSessions query)
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: () => ({ selectedCwd: '/test/cwd' }),
}));

function makeSession(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    title: 'Test session',
    createdAt: '2026-02-07T10:00:00Z',
    updatedAt: '2026-02-07T14:00:00Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: '/test/cwd',
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
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useAgentSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only sessions whose cwd matches the project path, newest first', async () => {
    const transport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [
          makeSession({ id: 'older', updatedAt: '2026-02-06T10:00:00Z' }),
          makeSession({ id: 'newer', updatedAt: '2026-02-07T10:00:00Z' }),
          makeSession({ id: 'foreign', cwd: '/other/project' }),
        ],
      }),
    });

    const { result } = renderHook(() => useAgentSessions('/test/cwd'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.sessions.map((s) => s.id)).toEqual(['newer', 'older']);
    });
  });

  it('drops cwd-less sessions — they belong to no agent (DOR-202)', async () => {
    const ghost = makeSession({ id: 'ghost', title: '' });
    delete ghost.cwd;
    const transport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [ghost, makeSession({ id: 'real' })],
      }),
    });

    const { result } = renderHook(() => useAgentSessions('/test/cwd'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.sessions.map((s) => s.id)).toEqual(['real']);
    });
  });

  it('returns an empty list when no agent is selected (null projectPath)', async () => {
    const transport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({ sessions: [makeSession({ id: 's1' })] }),
    });

    const { result } = renderHook(() => useAgentSessions(null), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.sessions).toEqual([]);
  });
});

describe('sessionDisplayTitle', () => {
  it('passes a real title through', () => {
    expect(sessionDisplayTitle('Fix the flaky test')).toBe('Fix the flaky test');
  });

  it('falls back to the untitled label for a blank title', () => {
    expect(sessionDisplayTitle('')).toBe(UNTITLED_SESSION_LABEL);
  });
});
