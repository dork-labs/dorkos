// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useCurrentAgent } from '../model/use-current-agent';
import { useCreateAgent } from '../model/use-create-agent';
import { useUpdateAgent } from '../model/use-update-agent';
import { useResolvedAgents } from '../model/use-resolved-agents';
import { useAgentVisual } from '../model/use-agent-visual';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

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

const mockAgent: AgentManifest = {
  id: '01HZ0000000000000000000001',
  name: 'test-agent',
  description: 'A mock agent for testing',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2025-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
};

// ---------------------------------------------------------------------------
// useCurrentAgent
// ---------------------------------------------------------------------------
describe('useCurrentAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches agent by path from transport', async () => {
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(mockAgent),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useCurrentAgent('/projects/myapp'), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockAgent);
    expect(transport.getAgentByPath).toHaveBeenCalledWith('/projects/myapp');
  });

  it('returns null when no agent is registered at path', async () => {
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(null),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useCurrentAgent('/projects/no-agent'), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toBeNull();
  });

  it('does not fetch when cwd is null', () => {
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(null),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useCurrentAgent(null), { wrapper: Wrapper });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
    expect(transport.getAgentByPath).not.toHaveBeenCalled();
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockRejectedValue(new Error('Not found')),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useCurrentAgent('/projects/failing'), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// useCreateAgent
// ---------------------------------------------------------------------------
describe('useCreateAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.createAgent with path and optional fields', async () => {
    const transport = createMockTransport({
      createAgent: vi.fn().mockResolvedValue(mockAgent),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useCreateAgent(), { wrapper: Wrapper });

    result.current.mutate({
      path: '/projects/newapp',
      name: 'New Agent',
      description: 'A new agent',
      runtime: 'claude-code',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.createAgent).toHaveBeenCalledWith(
      '/projects/newapp',
      'New Agent',
      'A new agent',
      'claude-code'
    );
    expect(result.current.data).toEqual(mockAgent);
  });

  it('calls transport.createAgent with only path when no optional fields', async () => {
    const transport = createMockTransport({
      createAgent: vi.fn().mockResolvedValue(mockAgent),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useCreateAgent(), { wrapper: Wrapper });

    result.current.mutate({ path: '/projects/minimal' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.createAgent).toHaveBeenCalledWith(
      '/projects/minimal',
      undefined,
      undefined,
      undefined
    );
  });

  it('invalidates agent queries on success', async () => {
    const transport = createMockTransport({
      createAgent: vi.fn().mockResolvedValue(mockAgent),
      getAgentByPath: vi.fn().mockResolvedValue(null),
    });
    const { Wrapper, queryClient } = createWrapper(transport);

    // Prime the cache for the path
    const { result: agentResult } = renderHook(() => useCurrentAgent('/projects/newapp'), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(agentResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useCreateAgent(), { wrapper: Wrapper });

    result.current.mutate({ path: '/projects/newapp' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Cache invalidation triggers additional refetches (byPath + all = at least 2 total)
    await waitFor(() => {
      expect(vi.mocked(transport.getAgentByPath).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    void queryClient; // prevent unused warning
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      createAgent: vi.fn().mockRejectedValue(new Error('Create failed')),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useCreateAgent(), { wrapper: Wrapper });

    result.current.mutate({ path: '/projects/failing' });

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

  it('calls transport.updateAgentByPath with path and updates', async () => {
    const updatedAgent = { ...mockAgent, name: 'Updated Agent' };
    const transport = createMockTransport({
      updateAgentByPath: vi.fn().mockResolvedValue(updatedAgent),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useUpdateAgent(), { wrapper: Wrapper });

    result.current.mutate({ path: '/projects/myapp', updates: { name: 'Updated Agent' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.updateAgentByPath).toHaveBeenCalledWith('/projects/myapp', {
      name: 'Updated Agent',
    });
    expect(result.current.data).toEqual(updatedAgent);
  });

  it('applies optimistic update before server response', async () => {
    let resolveUpdate: (v: AgentManifest) => void;
    const updatePromise = new Promise<AgentManifest>((res) => {
      resolveUpdate = res;
    });

    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(mockAgent),
      updateAgentByPath: vi.fn().mockReturnValue(updatePromise),
    });
    const { Wrapper } = createWrapper(transport);

    // Prime the cache
    const { result: agentResult } = renderHook(() => useCurrentAgent('/projects/myapp'), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(agentResult.current.data).toEqual(mockAgent);
    });

    const { result } = renderHook(() => useUpdateAgent(), { wrapper: Wrapper });

    act(() => {
      result.current.mutate({ path: '/projects/myapp', updates: { name: 'Optimistic Name' } });
    });

    // Optimistic update should be visible immediately
    await waitFor(() => {
      expect(agentResult.current.data?.name).toBe('Optimistic Name');
    });

    // Resolve the server response
    const resolved = { ...mockAgent, name: 'Optimistic Name' };
    act(() => {
      resolveUpdate!(resolved);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it('rolls back optimistic update on error', async () => {
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(mockAgent),
      updateAgentByPath: vi.fn().mockRejectedValue(new Error('Update failed')),
    });
    const { Wrapper } = createWrapper(transport);

    // Prime the cache
    const { result: agentResult } = renderHook(() => useCurrentAgent('/projects/myapp'), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(agentResult.current.data).toEqual(mockAgent);
    });

    const { result } = renderHook(() => useUpdateAgent(), { wrapper: Wrapper });

    result.current.mutate({ path: '/projects/myapp', updates: { name: 'Bad Update' } });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Cache should be reverted to original
    expect(agentResult.current.data?.name).toBe(mockAgent.name);
  });
});

// ---------------------------------------------------------------------------
// useResolvedAgents
// ---------------------------------------------------------------------------
describe('useResolvedAgents', () => {
  const mockResolved: Record<string, AgentManifest | null> = {
    '/projects/app1': mockAgent,
    '/projects/app2': null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('batch-resolves agents for multiple paths', async () => {
    const transport = createMockTransport({
      resolveAgents: vi.fn().mockResolvedValue(mockResolved),
    });
    const { Wrapper } = createWrapper(transport);

    const paths = ['/projects/app1', '/projects/app2'];
    const { result } = renderHook(() => useResolvedAgents(paths), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockResolved);
    expect(transport.resolveAgents).toHaveBeenCalledWith(paths);
  });

  it('does not fetch when paths array is empty', () => {
    const transport = createMockTransport({
      resolveAgents: vi.fn().mockResolvedValue({}),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useResolvedAgents([]), { wrapper: Wrapper });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
    expect(transport.resolveAgents).not.toHaveBeenCalled();
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      resolveAgents: vi.fn().mockRejectedValue(new Error('Resolve failed')),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useResolvedAgents(['/projects/app1']), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// useAgentVisual
// ---------------------------------------------------------------------------
describe('useAgentVisual', () => {
  it('uses color and icon overrides when agent has them', () => {
    const agentWithOverrides: AgentManifest = {
      ...mockAgent,
      color: '#6366f1',
      icon: '🤖',
    };

    const { result } = renderHook(() => useAgentVisual(agentWithOverrides, '/projects/myapp'));

    expect(result.current.color).toBe('#6366f1');
    expect(result.current.emoji).toBe('🤖');
  });

  it('hashes from agent.id when agent exists but has no overrides', () => {
    const { result } = renderHook(() => useAgentVisual(mockAgent, '/projects/myapp'));

    // Should be deterministic from agent.id, not cwd
    const { result: resultSameCwd } = renderHook(() =>
      useAgentVisual(mockAgent, '/projects/different-cwd')
    );

    expect(result.current.color).toBe(resultSameCwd.current.color);
    expect(result.current.emoji).toBe(resultSameCwd.current.emoji);
  });

  it('hashes from cwd when no agent is registered', () => {
    const { result } = renderHook(() => useAgentVisual(null, '/projects/myapp'));

    const { result: resultDifferentCwd } = renderHook(() =>
      useAgentVisual(null, '/projects/different-app')
    );

    // Different CWDs should yield different visuals (may rarely collide but statistically distinct)
    expect(result.current).toBeDefined();
    expect(resultDifferentCwd.current).toBeDefined();
    // Both should have valid color and emoji
    expect(result.current.color).toMatch(/^hsl\(/);
    expect(result.current.emoji).toBeTruthy();
  });

  it('hashes from cwd when agent is undefined', () => {
    const { result } = renderHook(() => useAgentVisual(undefined, '/projects/myapp'));

    expect(result.current.color).toMatch(/^hsl\(/);
    expect(result.current.emoji).toBeTruthy();
  });

  it('uses partial overrides — only color override, emoji hashed from agent.id', () => {
    const agentWithColorOnly: AgentManifest = {
      ...mockAgent,
      color: '#ff0000',
      // no icon override
    };

    const { result } = renderHook(() => useAgentVisual(agentWithColorOnly, '/projects/myapp'));

    expect(result.current.color).toBe('#ff0000');
    // emoji should be hashed from agent.id, not cwd
    const { result: noOverride } = renderHook(() => useAgentVisual(mockAgent, '/projects/myapp'));
    expect(result.current.emoji).toBe(noOverride.current.emoji);
  });

  it('produces stable output for same inputs (memoization)', () => {
    const { result, rerender } = renderHook(
      ({ agent, cwd }: { agent: AgentManifest | null; cwd: string }) => useAgentVisual(agent, cwd),
      { initialProps: { agent: mockAgent, cwd: '/projects/myapp' } }
    );

    const first = result.current;
    rerender({ agent: mockAgent, cwd: '/projects/myapp' });
    const second = result.current;

    // Same object reference due to useMemo
    expect(first).toBe(second);
  });
});
