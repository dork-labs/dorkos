// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { createQueryClientConfig } from '@/layers/shared/lib';
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

// ---------------------------------------------------------------------------
// useRegisteredAgents
// ---------------------------------------------------------------------------
describe('useRegisteredAgents', () => {
  const mockAgents = {
    agents: [
      { id: 'agent-1', name: 'Agent One', runtime: 'claude-code', capabilities: ['code'] },
      { id: 'agent-2', name: 'Agent Two', runtime: 'custom', capabilities: ['search'] },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches agents from transport.listMeshAgents', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue(mockAgents),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useRegisteredAgents(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockAgents);
    expect(transport.listMeshAgents).toHaveBeenCalledTimes(1);
    expect(transport.listMeshAgents).toHaveBeenCalledWith(undefined);
  });

  it('passes filters to transport', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue(mockAgents),
    });
    const { Wrapper } = createWrapper(transport);
    const filters = { runtime: 'claude-code', capability: 'code' };

    const { result } = renderHook(() => useRegisteredAgents(filters), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.listMeshAgents).toHaveBeenCalledWith(filters);
  });

  it('skips fetching when enabled is false', () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue(mockAgents),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useRegisteredAgents(undefined, false), {
      wrapper: Wrapper,
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
    expect(transport.listMeshAgents).not.toHaveBeenCalled();
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockRejectedValue(new Error('Fetch failed')),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useRegisteredAgents(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});

// useDiscoverAgents tests removed — replaced by SSE-based useDiscoveryScan (entities/discovery).

// ---------------------------------------------------------------------------
// useRegisterAgent
// ---------------------------------------------------------------------------
describe('useRegisterAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.registerMeshAgent with path and overrides', async () => {
    const mockResult = { id: 'new-agent', name: 'New Agent' };
    const transport = createMockTransport({
      registerMeshAgent: vi.fn().mockResolvedValue(mockResult),
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useRegisterAgent(), { wrapper: Wrapper });

    result.current.mutate({
      path: '/agents/new',
      overrides: { name: 'Custom' },
      approver: 'admin',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.registerMeshAgent).toHaveBeenCalledWith(
      '/agents/new',
      { name: 'Custom' },
      'admin',
      undefined
    );
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

// ---------------------------------------------------------------------------
// useDenyAgent
// ---------------------------------------------------------------------------
describe('useDenyAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.denyMeshAgent with path and reason', async () => {
    const transport = createMockTransport({
      denyMeshAgent: vi.fn().mockResolvedValue({ success: true }),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useDenyAgent(), { wrapper: Wrapper });

    result.current.mutate({ path: '/agents/bad', reason: 'untrusted', denier: 'admin' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.denyMeshAgent).toHaveBeenCalledWith('/agents/bad', 'untrusted', 'admin');
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

// ---------------------------------------------------------------------------
// useUnregisterAgent
// ---------------------------------------------------------------------------
describe('useUnregisterAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      unregisterMeshAgent: vi.fn().mockRejectedValue(new Error('Unregister failed')),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useUnregisterAgent(), { wrapper: Wrapper });

    result.current.mutate('agent-1');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// useUpdateAgent
// ---------------------------------------------------------------------------
describe('useUpdateAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.updateMeshAgent with id and updates', async () => {
    const mockResult = { id: 'agent-1', name: 'Updated' };
    const transport = createMockTransport({
      updateMeshAgent: vi.fn().mockResolvedValue(mockResult),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useUpdateAgent(), { wrapper: Wrapper });

    result.current.mutate({ id: 'agent-1', updates: { name: 'Updated' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.updateMeshAgent).toHaveBeenCalledWith('agent-1', { name: 'Updated' });
    expect(result.current.data).toEqual(mockResult);
  });

  it('invalidates agents query on success', async () => {
    const transport = createMockTransport({
      updateMeshAgent: vi.fn().mockResolvedValue({ id: 'agent-1' }),
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
    });
    const { Wrapper } = createWrapper(transport);

    // Prime the agents cache
    const { result: agentsResult } = renderHook(() => useRegisteredAgents(), { wrapper: Wrapper });
    await waitFor(() => {
      expect(agentsResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useUpdateAgent(), { wrapper: Wrapper });

    result.current.mutate({ id: 'agent-1', updates: { name: 'Updated' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    await waitFor(() => {
      expect(transport.listMeshAgents).toHaveBeenCalledTimes(2);
    });
  });

  it('sweeps the agent manifest caches even when the caller unmounted mid-write', async () => {
    // DOR-1736. The surfaces that write through here are a popover and a
    // settings tab a person closes the instant they have clicked, and a callback
    // handed to `mutate(vars, { onSettled })` is dispatched by the OBSERVER — so
    // it is skipped exactly then. The write still lands; only the refresh is
    // lost, leaving `agentKeys.byPath` holding the pre-write manifest for its 60s
    // stale time, which the status bar reads to name the account a new session
    // will bill to. Driven through a real unmount, because that is the only way
    // to tell a mutation-level callback from an observer-level one.
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
      // `['agents']` — the prefix `entities/agent`'s `agentKeys.all` spells, and
      // the one covering both `byPath` and `resolved`. Compared as a literal for
      // the reason the hook states: importing the factory would close a cycle.
      expect(asked).toContain(JSON.stringify(['agents']));
    });
  });

  it('sweeps the manifest caches after a REFUSED write too', async () => {
    // `onSettled`, not `onSuccess`: the controls that write through here are
    // drawn from the cached manifest, so a re-read is the only thing that proves
    // a refused write did not move them.
    const transport = createMockTransport({
      updateMeshAgent: vi.fn().mockRejectedValue(new Error('Forbidden')),
    });
    const { Wrapper, queryClient } = createWrapper(transport);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateAgent(), { wrapper: Wrapper });
    result.current.mutate({ id: 'agent-1', updates: { account: 'work' } });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const asked = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(asked).toContain(JSON.stringify(['agents']));
    // …and NOT the mesh listing, which a refused write did not change.
    expect(asked).not.toContain(JSON.stringify(['mesh', 'agents']));
  });

  it('names the surface’s action in the failure toast when given a label', async () => {
    // The app-wide `MutationCache.onError` composes `meta.errorLabel` with the
    // server's own sentence, and it is the only report that survives the
    // unmount a `mutate` callback does not (`shared/lib/query-client`). Driven
    // through the REAL error policy — a client declared from scratch here
    // carries no `MutationCache`, so this would assert nothing.
    //
    // The two halves are asserted SEPARATELY because that is now the shape:
    // DOR-1755 split the authored line from the raw one, so the label is the
    // toast's headline and the server's sentence is the description beneath it.
    // They used to be joined with an em dash into a single string, which put
    // "ENOENT: no such file or directory" in the same breath as a sentence
    // written for a person. Naming both keeps this a test of the FEATURE — that
    // a person is told which action failed and why — rather than of one
    // particular way of concatenating them.
    const transport = createMockTransport({
      updateMeshAgent: vi.fn().mockRejectedValue(new Error('Billing is set by a person')),
    });
    const config = createQueryClientConfig();
    const queryClient = new QueryClient({
      ...config,
      defaultOptions: { ...config.defaultOptions, mutations: { retry: false } },
    });
    const { result } = renderHook(
      () => useUpdateAgent({ errorLabel: 'Couldn’t change this agent’s account' }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>
            <TransportProvider transport={transport}>{children}</TransportProvider>
          </QueryClientProvider>
        ),
      }
    );

    result.current.mutate({ id: 'agent-1', updates: { account: 'work' } });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toasts.error).toHaveBeenCalledWith(
      'Couldn’t change this agent’s account',
      expect.objectContaining({ description: 'Billing is set by a person' })
    );
  });
});

// ---------------------------------------------------------------------------
// useDeniedAgents
// ---------------------------------------------------------------------------
describe('useDeniedAgents', () => {
  const mockDenied = {
    denied: [{ path: '/agents/bad', reason: 'untrusted', deniedAt: '2026-01-01T00:00:00Z' }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches denied list from transport.listDeniedMeshAgents', async () => {
    const transport = createMockTransport({
      listDeniedMeshAgents: vi.fn().mockResolvedValue(mockDenied),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useDeniedAgents(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockDenied);
    expect(transport.listDeniedMeshAgents).toHaveBeenCalledTimes(1);
  });

  it('skips fetching when enabled is false', () => {
    const transport = createMockTransport({
      listDeniedMeshAgents: vi.fn().mockResolvedValue(mockDenied),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useDeniedAgents(false), { wrapper: Wrapper });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
    expect(transport.listDeniedMeshAgents).not.toHaveBeenCalled();
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      listDeniedMeshAgents: vi.fn().mockRejectedValue(new Error('Denied fetch failed')),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useDeniedAgents(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});
