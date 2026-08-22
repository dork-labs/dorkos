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

// Mock app store. `useAgentSessions` MUST key its own query on the agent's
// projectPath, never on the window's `selectedCwd` — this ref lets a test point
// the window somewhere else and prove the hook ignores it (DOR-929).
const { appStore } = vi.hoisted(() => ({
  appStore: { selectedCwd: '/test/cwd' as string | null },
}));
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: () => ({ selectedCwd: appStore.selectedCwd }),
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
    appStore.selectedCwd = '/test/cwd';
  });

  // The DOR-929 regression, isolated: the window is pointed at one directory and
  // the agent lives in another. The hook must fetch the AGENT's directory, so an
  // agent this window has never opened still shows its real conversations. The
  // old hook borrowed `useSessions()` (hard-keyed on `selectedCwd`) and filtered
  // that list, so it fetched the window's directory and always came back empty —
  // this test fails red against it and green only once the query keys on the
  // agent's own path.
  it("fetches the agent's own directory, not the window's selected one (DOR-929)", async () => {
    appStore.selectedCwd = '/window/cwd'; // window is looking at a DIFFERENT agent
    const agentSession = makeSession({ id: 'agent-session', cwd: '/agent/cwd' });
    const listSessions = vi.fn((cwd?: string) =>
      Promise.resolve({ sessions: cwd === '/agent/cwd' ? [agentSession] : [] })
    );
    const transport = createMockTransport({ listSessions });

    const { result } = renderHook(() => useAgentSessions('/agent/cwd'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.sessions.map((s) => s.id)).toEqual(['agent-session']);
    });
    // The list was fetched for the AGENT's directory, never the window's.
    expect(listSessions).toHaveBeenCalledWith('/agent/cwd');
    expect(listSessions).not.toHaveBeenCalledWith('/window/cwd');
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

  it('treats a whitespace-only title as blank, not as a name', () => {
    expect(sessionDisplayTitle('   ')).toBe(UNTITLED_SESSION_LABEL);
    expect(sessionDisplayTitle('\n\t')).toBe(UNTITLED_SESSION_LABEL);
  });

  it('calls an unnamed session new rather than untitled', () => {
    expect(UNTITLED_SESSION_LABEL).toBe('New session');
  });
});
