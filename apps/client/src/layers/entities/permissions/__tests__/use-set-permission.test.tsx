/**
 * @vitest-environment jsdom
 */
/**
 * The one write hook every permission surface uses: it writes to the route the
 * scope names, refreshes every read a write affects, and — because a write can
 * be refused (only a person changes permissions) — never moves a cached value
 * before the server answers.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type { PermissionsResponse } from '@dorkos/shared/permissions';
import { TransportProvider } from '@/layers/shared/model';

import { usePermissions, useSetPermission, useOverridingAgents } from '../index';

afterEach(() => cleanup());

const OVERVIEW: PermissionsResponse = {
  preset: 'full',
  defaults: { areas: {}, actions: {} },
  changeCount: 0,
  areas: [],
  exceptions: [
    { agentId: 'a1', agentName: 'auditor', area: 'rooms', state: 'blocked' },
    { agentId: 'a2', agentName: 'tester', area: 'rooms', action: 'rooms.create', state: 'ask' },
    { agentId: 'a2', agentName: 'tester', area: 'tasks', state: 'ask' },
  ],
  agentCount: 3,
};

function harness(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { wrapper, queryClient };
}

describe('useSetPermission', () => {
  it('writes the defaults through the defaults route and refreshes every permission read', async () => {
    const transport = createMockTransport();
    const { wrapper, queryClient } = harness(transport);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useSetPermission({ kind: 'default' }), { wrapper });

    await act(() =>
      result.current.mutateAsync({
        kind: 'patch',
        areas: { rooms: 'allowed' },
        applyToAgents: ['a1'],
        surface: 'settings',
      })
    );

    expect(transport.patchPermissionDefaults).toHaveBeenCalledWith({
      areas: { rooms: 'allowed' },
      surface: 'settings',
      applyToAgents: ['a1'],
    });
    const keys = invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
    expect(keys).toContain(JSON.stringify(['permissions']));
    expect(keys).toContain(JSON.stringify(['mesh', 'agents']));
  });

  it('writes one agent through the agent route', async () => {
    const transport = createMockTransport();
    const { wrapper } = harness(transport);
    const { result } = renderHook(() => useSetPermission({ kind: 'agent', agentId: 'a1' }), {
      wrapper,
    });

    await act(() =>
      result.current.mutateAsync({ kind: 'patch', areas: { rooms: null }, surface: 'agent-page' })
    );

    expect(transport.patchAgentPermissions).toHaveBeenCalledWith('a1', {
      areas: { rooms: null },
      surface: 'agent-page',
    });
  });

  it('leaves the cached value where it was when the write is refused', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getPermissions).mockResolvedValue(OVERVIEW);
    vi.mocked(transport.patchPermissionDefaults).mockRejectedValue(
      new Error('Only a person can change permissions.')
    );
    const { wrapper } = harness(transport);
    const { result } = renderHook(
      () => ({ read: usePermissions(), write: useSetPermission({ kind: 'default' }) }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.read.data).toBeDefined());

    await act(async () => {
      await result.current.write
        .mutateAsync({ kind: 'patch', areas: { rooms: 'blocked' }, surface: 'settings' })
        .catch(() => undefined);
    });

    await waitFor(() => expect(result.current.write.isError).toBe(true));
    expect(result.current.read.data?.defaults.areas).toEqual({});
  });
});

describe('useOverridingAgents', () => {
  it('lists each agent that differs in the area once, preferring its area-level row', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getPermissions).mockResolvedValue(OVERVIEW);
    const { wrapper } = harness(transport);
    const { result } = renderHook(() => useOverridingAgents('rooms'), { wrapper });

    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current.map((e) => e.agentId)).toEqual(['a1', 'a2']);
    expect(result.current[0]!.action).toBeUndefined();
  });
});
