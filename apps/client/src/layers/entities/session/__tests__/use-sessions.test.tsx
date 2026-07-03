import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useSessions, useSessionListWarnings } from '../model/use-sessions';
import { useSessionRuntime } from '../model/use-session-runtime';

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

  afterEach(() => {
    vi.useRealTimers();
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
    // Transport returns the aggregated-list envelope (ADR-0310); the hook
    // unwraps `sessions` into the `['sessions', cwd]` cache.
    const transport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({ sessions }),
    });

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

  // Per-runtime degradations ride the aggregated envelope (ADR-0310) and are
  // stashed on a sibling cache key so the `['sessions', cwd]` cache can stay a
  // bare Session[] for its many array-patching consumers.
  it('surfaces per-runtime warnings through useSessionListWarnings', async () => {
    const warnings = [{ runtime: 'opencode', message: 'OpenCode server is starting' }];
    const transport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({ sessions: [], warnings }),
    });
    const wrapper = createWrapper(transport);

    const { result } = renderHook(
      () => ({ list: useSessions(), warnings: useSessionListWarnings() }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.warnings).toEqual(warnings);
    });
  });

  it('reports no warnings when the envelope omits them', async () => {
    const transport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    });
    const wrapper = createWrapper(transport);

    const { result } = renderHook(
      () => ({ list: useSessions(), warnings: useSessionListWarnings() }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.list.isLoading).toBe(false);
    });
    expect(result.current.warnings).toEqual([]);
  });

  // Regression guard: the timer poll was removed (ADR-0265) — live updates now
  // arrive via the global stream. Advancing well past the old 60s interval must
  // NOT trigger a refetch, so listSessions stays at its single cold-load call.
  it('does not poll the session list on a timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    const transport = createMockTransport({ listSessions });

    renderHook(() => useSessions(), { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(listSessions).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(listSessions).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// useSessionRuntime — resolves a session's owning runtime from its list row
// (never a fetch; see the hook's TSDoc for the infer-on-miss staleness trap).
// ---------------------------------------------------------------------------
describe('useSessionRuntime', () => {
  const sessions = [
    {
      id: 's-codex',
      title: 'Codex session',
      createdAt: '2026-07-01',
      updatedAt: '2026-07-01',
      permissionMode: 'default' as const,
      runtime: 'codex',
    },
    {
      id: 's-claude',
      title: 'Claude session',
      createdAt: '2026-07-01',
      updatedAt: '2026-07-01',
      permissionMode: 'default' as const,
      runtime: 'claude-code',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionId = null;
  });

  it("returns the session row's runtime", async () => {
    const transport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({ sessions }),
    });
    const wrapper = createWrapper(transport);

    const { result } = renderHook(() => useSessionRuntime('s-codex'), { wrapper });

    await waitFor(() => {
      expect(result.current).toBe('codex');
    });
  });

  it('returns undefined for a session with no row yet (pre-launch)', async () => {
    const listSessions = vi.fn().mockResolvedValue({ sessions });
    const transport = createMockTransport({ listSessions });
    const wrapper = createWrapper(transport);

    const { result } = renderHook(() => useSessionRuntime('minted-but-unstarted'), { wrapper });

    await waitFor(() => {
      expect(listSessions).toHaveBeenCalled();
    });
    expect(result.current).toBeUndefined();
    // Never falls back to a per-session inference fetch.
    expect(transport.getSessionRuntimeType).not.toHaveBeenCalled();
  });

  it('returns undefined for a nullish session id', async () => {
    const transport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({ sessions }),
    });
    const wrapper = createWrapper(transport);

    const { result } = renderHook(() => useSessionRuntime(null), { wrapper });

    expect(result.current).toBeUndefined();
  });
});
