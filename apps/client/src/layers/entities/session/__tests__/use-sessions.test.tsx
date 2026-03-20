import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useSessions } from '../model/use-sessions';

// Mock useSessionId (TanStack Router search params)
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

describe('useSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionId = null;
  });

  it('lists sessions via React Query', async () => {
    const sessions = [
      {
        id: 's1',
        title: 'Session 1',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        permissionMode: 'default' as const,
      },
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

  it('exposes setActiveSession', async () => {
    const transport = createMockTransport();

    const { result } = renderHook(() => useSessions(), { wrapper: createWrapper(transport) });

    act(() => {
      result.current.setActiveSession('test-id');
    });

    expect(mockSetSessionId).toHaveBeenCalledWith('test-id');
  });
});
