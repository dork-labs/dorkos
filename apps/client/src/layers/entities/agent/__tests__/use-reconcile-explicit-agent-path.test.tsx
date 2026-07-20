// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { useReconcileExplicitAgentPath } from '../model/use-reconcile-explicit-agent-path';

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

describe('useReconcileExplicitAgentPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ explicitAgentPath: null });
  });

  // Unmount each hook before the next test: the app store is a singleton, so a
  // lingering mounted hook would react to the next test's setState and clear the
  // field out from under it.
  afterEach(() => {
    cleanup();
  });

  it('clears the field when the opened agent no longer resolves (deleted)', async () => {
    useAppStore.setState({ explicitAgentPath: '/opened/then-deleted' });
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(null),
    });

    renderHook(() => useReconcileExplicitAgentPath(), { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(useAppStore.getState().explicitAgentPath).toBeNull();
    });
    expect(transport.getAgentByPath).toHaveBeenCalledWith('/opened/then-deleted');
  });

  it('keeps the field while the opened agent still resolves (sticky)', async () => {
    useAppStore.setState({ explicitAgentPath: '/opened/live' });
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(agentAt('live')),
    });

    renderHook(() => useReconcileExplicitAgentPath(), { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(transport.getAgentByPath).toHaveBeenCalledWith('/opened/live');
    });
    expect(useAppStore.getState().explicitAgentPath).toBe('/opened/live');
  });

  it('does not clear on a transient transport error (would re-open on refetch)', async () => {
    useAppStore.setState({ explicitAgentPath: '/opened/offline' });
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockRejectedValue(new Error('unavailable')),
    });

    renderHook(() => useReconcileExplicitAgentPath(), { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(transport.getAgentByPath).toHaveBeenCalledWith('/opened/offline');
    });
    expect(useAppStore.getState().explicitAgentPath).toBe('/opened/offline');
  });

  it('is a no-op when no agent is explicitly opened', async () => {
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(null),
    });

    renderHook(() => useReconcileExplicitAgentPath(), { wrapper: createWrapper(transport) });

    // The query is disabled with a null path, so the transport is never queried
    // and there is nothing to clear.
    await act(async () => {
      await Promise.resolve();
    });
    expect(transport.getAgentByPath).not.toHaveBeenCalled();
    expect(useAppStore.getState().explicitAgentPath).toBeNull();
  });

  it('clears once the opened agent is deleted mid-session', async () => {
    useAppStore.setState({ explicitAgentPath: '/opened/a' });
    let deleted = false;
    const transport = createMockTransport({
      getAgentByPath: vi.fn(async () => (deleted ? null : agentAt('a'))),
    });

    const { rerender } = renderHook(() => useReconcileExplicitAgentPath(), {
      wrapper: createWrapper(transport),
    });

    // Initially resolves — stays sticky.
    await waitFor(() => {
      expect(transport.getAgentByPath).toHaveBeenCalledWith('/opened/a');
    });
    expect(useAppStore.getState().explicitAgentPath).toBe('/opened/a');

    // Agent is deleted; a refetch now yields null and the field is cleared. Point
    // the field at a fresh path so the query key changes and refetches.
    deleted = true;
    act(() => {
      useAppStore.setState({ explicitAgentPath: '/opened/a-gone' });
    });
    rerender();

    await waitFor(() => {
      expect(useAppStore.getState().explicitAgentPath).toBeNull();
    });
  });
});
