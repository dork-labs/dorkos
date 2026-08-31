/**
 * @vitest-environment jsdom
 *
 * DOR-1114: renaming the operator (or changing their photo/handle) must
 * refresh every open room's roster, not just `['team']` — a room's author
 * row is drawn from its own cached detail query, so leaving `roomKeys.detail`
 * stale left a renamed operator's old name sitting in an idle room's message
 * gutter until an unrelated refetch touched it.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { roomKeys } from '@/layers/entities/room';
import { TEAM_ROSTER_KEY } from '@/layers/entities/team';
import {
  useUpdateProfileName,
  useUploadProfileAvatar,
  useDeleteProfileAvatar,
  useSetAuthorHandle,
} from '../model/use-profile-edits';

/** A QueryClient plus every key it was asked to invalidate, in call order. */
function recordingWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const invalidated: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey);
    return original(filters as Parameters<typeof original>[0]);
  }) as typeof queryClient.invalidateQueries;
  return { queryClient, invalidated };
}

afterEach(cleanup);

describe('the operator profile writes', () => {
  it('invalidates the roster and every open room on a display-name change', async () => {
    const transport = createMockTransport();
    const { queryClient, invalidated } = recordingWrapper();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useUpdateProfileName(), { wrapper });

    await act(async () => {
      result.current.mutate('New Name');
    });

    await waitFor(() => expect(transport.updateProfile).toHaveBeenCalledWith('New Name'));
    expect(invalidated).toContainEqual([...TEAM_ROSTER_KEY]);
    expect(invalidated).toContainEqual(roomKeys.details());
  });

  it('invalidates the roster and every open room on an avatar upload', async () => {
    const transport = createMockTransport();
    const { queryClient, invalidated } = recordingWrapper();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useUploadProfileAvatar(), { wrapper });
    const file = new File(['x'], 'me.png', { type: 'image/png' });

    await act(async () => {
      result.current.mutate({ file });
    });

    await waitFor(() => expect(transport.uploadProfileAvatar).toHaveBeenCalled());
    expect(invalidated).toContainEqual([...TEAM_ROSTER_KEY]);
    expect(invalidated).toContainEqual(roomKeys.details());
  });

  it('invalidates the roster and every open room on an avatar delete', async () => {
    const transport = createMockTransport();
    const { queryClient, invalidated } = recordingWrapper();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useDeleteProfileAvatar(), { wrapper });

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(transport.deleteProfileAvatar).toHaveBeenCalled());
    expect(invalidated).toContainEqual([...TEAM_ROSTER_KEY]);
    expect(invalidated).toContainEqual(roomKeys.details());
  });

  it('invalidates the roster and every open room on a handle change', async () => {
    const transport = createMockTransport();
    const { queryClient, invalidated } = recordingWrapper();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useSetAuthorHandle(), { wrapper });

    await act(async () => {
      result.current.mutate({ authorId: 'person-1', handle: 'dorian' });
    });

    await waitFor(() =>
      expect(transport.setAuthorHandle).toHaveBeenCalledWith('person-1', 'dorian')
    );
    expect(invalidated).toContainEqual([...TEAM_ROSTER_KEY]);
    expect(invalidated).toContainEqual(roomKeys.details());
  });
});
