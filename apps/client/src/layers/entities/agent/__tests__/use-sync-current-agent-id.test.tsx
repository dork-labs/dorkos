// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { useSyncCurrentAgentId } from '../model/use-sync-current-agent-id';

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

function agentAt(id: string): AgentManifest {
  return {
    id,
    name: `agent-${id}`,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2025-01-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    enabledToolGroups: {},
  };
}

describe('useSyncCurrentAgentId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the singleton store fields this hook reads/writes.
    useAppStore.setState({ selectedCwd: null, currentAgentId: null });
  });

  it('mirrors the resolved agent id into the store when the cwd matches an agent', async () => {
    useAppStore.setState({ selectedCwd: '/projects/app' });
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(agentAt('agent-a')),
    });

    renderHook(() => useSyncCurrentAgentId(), { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(useAppStore.getState().currentAgentId).toBe('agent-a');
    });
    expect(transport.getAgentByPath).toHaveBeenCalledWith('/projects/app');
  });

  it('leaves the store id null when no agent is registered at the cwd', async () => {
    useAppStore.setState({ selectedCwd: '/projects/bare' });
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(null),
    });

    renderHook(() => useSyncCurrentAgentId(), { wrapper: createWrapper(transport) });

    // Give the query a chance to resolve, then assert it stayed null.
    await waitFor(() => {
      expect(transport.getAgentByPath).toHaveBeenCalledWith('/projects/bare');
    });
    expect(useAppStore.getState().currentAgentId).toBeNull();
  });

  it('degrades to null (no throw) when the transport cannot resolve the agent', async () => {
    useAppStore.setState({ selectedCwd: '/projects/offline', currentAgentId: 'stale' });
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockRejectedValue(new Error('unavailable')),
    });

    renderHook(() => useSyncCurrentAgentId(), { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(useAppStore.getState().currentAgentId).toBeNull();
    });
  });

  it('updates the store id when the cwd changes to a different agent', async () => {
    useAppStore.setState({ selectedCwd: '/projects/a' });
    const transport = createMockTransport({
      getAgentByPath: vi.fn(async (path: string) =>
        path === '/projects/a' ? agentAt('agent-a') : agentAt('agent-b')
      ),
    });

    renderHook(() => useSyncCurrentAgentId(), { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(useAppStore.getState().currentAgentId).toBe('agent-a');
    });

    act(() => {
      useAppStore.setState({ selectedCwd: '/projects/b' });
    });

    await waitFor(() => {
      expect(useAppStore.getState().currentAgentId).toBe('agent-b');
    });
  });
});
