// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';

import { TransportProvider } from '@/layers/shared/model';
import { useRegisteredAgents } from '../model/use-mesh-agents';
import { useRegisterAgent } from '../model/use-mesh-register';
import { useDenyAgent } from '../model/use-mesh-deny';
import { useUnregisterAgent } from '../model/use-mesh-unregister';
import { useUpdateAgent } from '../model/use-mesh-update';
import { useDeniedAgents } from '../model/use-mesh-denied';
// useMeshEnabled tests removed — hook now always returns true (ADR-0062).

// The app-wide failure toast is what `meta.errorLabel` composes into, so the
// label test needs to see it land rather than only that the mutation errored.
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(toasts.message, { success: toasts.success, error: toasts.error }),
}));

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return {
    queryClient,
    Wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  };
}

// useDiscoverAgents tests removed — replaced by SSE-based useDiscoveryScan (entities/discovery).

// --------------------------------------------------------------------------- useRegisterAgent
// ---------------------------------------------------------------------------
describe('useRegisterAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates agents query on success', async () => {
    const transport = createMockTransport({
      registerMeshAgent: vi.fn().mockResolvedValue({ id: 'new-agent' }),
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
    });
    const { Wrapper } = createWrapper(transport);

    // Prime the agents cache
    const { result: agentsResult } = renderHook(() => useRegisteredAgents(), { wrapper: Wrapper });
    await waitFor(() => {
      expect(agentsResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useRegisterAgent(), { wrapper: Wrapper });

    result.current.mutate({ path: '/agents/new' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Cache invalidation triggers a refetch
    await waitFor(() => {
      expect(transport.listMeshAgents).toHaveBeenCalledTimes(2);
    });
  });
});

// --------------------------------------------------------------------------- useDenyAgent
// ---------------------------------------------------------------------------
describe('useDenyAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates denied query on success', async () => {
    const transport = createMockTransport({
      denyMeshAgent: vi.fn().mockResolvedValue({ success: true }),
      listDeniedMeshAgents: vi.fn().mockResolvedValue({ denied: [] }),
    });
    const { Wrapper } = createWrapper(transport);

    // Prime the denied cache
    const { result: deniedResult } = renderHook(() => useDeniedAgents(), { wrapper: Wrapper });
    await waitFor(() => {
      expect(deniedResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useDenyAgent(), { wrapper: Wrapper });

    result.current.mutate({ path: '/agents/bad' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Cache invalidation triggers a refetch
    await waitFor(() => {
      expect(transport.listDeniedMeshAgents).toHaveBeenCalledTimes(2);
    });
  });
});

// --------------------------------------------------------------------------- useUnregisterAgent
// ---------------------------------------------------------------------------
describe('useUnregisterAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates agents query on success', async () => {
    const transport = createMockTransport({
      unregisterMeshAgent: vi.fn().mockResolvedValue({ success: true }),
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
    });
    const { Wrapper } = createWrapper(transport);

    // Prime the agents cache
    const { result: agentsResult } = renderHook(() => useRegisteredAgents(), { wrapper: Wrapper });
    await waitFor(() => {
      expect(agentsResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useUnregisterAgent(), { wrapper: Wrapper });

    result.current.mutate('agent-1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    await waitFor(() => {
      expect(transport.listMeshAgents).toHaveBeenCalledTimes(2);
    });
  });

  it('sweeps the sidebar rows and the manifest caches too, not just the listing', async () => {
    // DOR-2052.
    const transport = createMockTransport({
      unregisterMeshAgent: vi.fn().mockResolvedValue({ success: true }),
    });
    const { Wrapper, queryClient } = createWrapper(transport);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUnregisterAgent(), { wrapper: Wrapper });
    result.current.mutate('agent-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const asked = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(asked).toContain(JSON.stringify(['mesh', 'agents']));
    expect(asked).toContain(JSON.stringify(['mesh', 'agent-paths']));
    expect(asked).toContain(JSON.stringify(['agents']));
    expect(asked).toContain(JSON.stringify(['team']));
  });

  it('calls transport.unregisterMeshAgent with agent id', async () => {
    const transport = createMockTransport({
      unregisterMeshAgent: vi.fn().mockResolvedValue({ success: true }),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useUnregisterAgent(), { wrapper: Wrapper });

    result.current.mutate('agent-1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.unregisterMeshAgent).toHaveBeenCalledWith('agent-1');
  });
});

// --------------------------------------------------------------------------- useUpdateAgent
// ---------------------------------------------------------------------------
describe('useUpdateAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sweeps the agent manifest caches even when the caller unmounted mid-write', async () => {
    // DOR-1736.
    let settle: (value: { id: string }) => void = () => {};
    const transport = createMockTransport({
      updateMeshAgent: vi.fn().mockImplementation(
        () =>
          new Promise<{ id: string }>((resolve) => {
            settle = resolve;
          })
      ),
    });
    const { Wrapper, queryClient } = createWrapper(transport);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result, unmount } = renderHook(() => useUpdateAgent(), { wrapper: Wrapper });
    result.current.mutate({ id: 'agent-1', updates: { account: 'work' } });
    await waitFor(() => expect(transport.updateMeshAgent).toHaveBeenCalled());

    unmount();
    settle({ id: 'agent-1' });

    await waitFor(() => {
      const asked = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
      // `['agents']` — the prefix `entities/agent`'s `agentKeys.all` spells, and the one covering
      // both `byPath` and `resolved`.
      expect(asked).toContain(JSON.stringify(['agents']));
    });
  });
});
