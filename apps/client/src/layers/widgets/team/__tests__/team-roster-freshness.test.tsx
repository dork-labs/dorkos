/**
 * @vitest-environment jsdom
 *
 * Everything that changes the fleet has to refresh the roster.
 *
 * The failure this pins is the one a person actually hits: create an agent from
 * the Team page, and the page it was created from never shows it. `['team']` is
 * a second reader of a fleet four hooks already write, and every one of them
 * shipped invalidating only the mesh keys.
 *
 * It lives in `widgets/` because that is the only layer allowed to see both
 * halves — the writers span `entities/mesh` and `features/agent-creation`, and
 * neither may import the other or the team entity.
 *
 * The real `useTeamRoster` is mounted rather than a hand-seeded `['team']` cache
 * entry, and invalidation is observed as the refetch it causes. A writer that
 * invalidated a key the reader does not read would still fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useTeamRoster } from '@/layers/entities/team';
import { useRegisterAgent, useUnregisterAgent, useDeleteAgentData } from '@/layers/entities/mesh';
import { useCreateAgent } from '@/layers/features/agent-creation';

function setup(stubs: Partial<Transport>) {
  const getTeamRoster = vi.fn().mockResolvedValue({ members: [] });
  const transport = createMockTransport({ ...stubs, getTeamRoster } as Partial<Transport>);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { transport, getTeamRoster, Wrapper };
}

/** Prime the roster the way the page does, and prove it was read exactly once. */
async function primeRoster(Wrapper: (p: { children: ReactNode }) => ReactNode, read: () => void) {
  const { result } = renderHook(() => useTeamRoster(), { wrapper: Wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  read();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the team roster after a fleet change', () => {
  it('refreshes when a discovered agent is registered', async () => {
    const { transport, getTeamRoster, Wrapper } = setup({
      registerMeshAgent: vi.fn().mockResolvedValue({ id: 'agent-new' }),
    });
    await primeRoster(Wrapper, () => expect(getTeamRoster).toHaveBeenCalledTimes(1));

    const { result } = renderHook(() => useRegisterAgent(), { wrapper: Wrapper });
    result.current.mutate({ path: '/agents/new' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(transport.registerMeshAgent).toHaveBeenCalled();
    await waitFor(() => expect(getTeamRoster).toHaveBeenCalledTimes(2));
  });

  it('refreshes when an agent is unregistered', async () => {
    const { getTeamRoster, Wrapper } = setup({
      unregisterMeshAgent: vi.fn().mockResolvedValue(undefined),
    });
    await primeRoster(Wrapper, () => expect(getTeamRoster).toHaveBeenCalledTimes(1));

    const { result } = renderHook(() => useUnregisterAgent(), { wrapper: Wrapper });
    result.current.mutate('agent-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await waitFor(() => expect(getTeamRoster).toHaveBeenCalledTimes(2));
  });

  it('refreshes when an agent and its data are deleted', async () => {
    const { getTeamRoster, Wrapper } = setup({
      deleteAgentData: vi.fn().mockResolvedValue({ success: true }),
    });
    await primeRoster(Wrapper, () => expect(getTeamRoster).toHaveBeenCalledTimes(1));

    const { result } = renderHook(() => useDeleteAgentData(), { wrapper: Wrapper });
    result.current.mutate('agent-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await waitFor(() => expect(getTeamRoster).toHaveBeenCalledTimes(2));
  });

  it('refreshes when an agent is created — the failure this file exists for', async () => {
    const { getTeamRoster, Wrapper } = setup({
      createAgent: vi.fn().mockResolvedValue({ id: 'agent-new', name: 'new-agent' }),
    });
    await primeRoster(Wrapper, () => expect(getTeamRoster).toHaveBeenCalledTimes(1));

    const { result } = renderHook(() => useCreateAgent(), { wrapper: Wrapper });
    result.current.mutate({ name: 'new-agent' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await waitFor(() => expect(getTeamRoster).toHaveBeenCalledTimes(2));
  });
});
