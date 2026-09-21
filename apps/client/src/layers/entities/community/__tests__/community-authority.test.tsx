import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { CommunityNavigationState } from '@dorkos/shared/community-navigation';
import {
  confirmCommunityAuthority,
  getCommunityAuthority,
  invalidateCommunityAuthority,
} from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { useCommunityNavigation } from '../model/use-community-navigation';
import { withinCommunityAuthority } from '../model/use-community-connections';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  invalidateCommunityAuthority();
});

describe('Community authority bootstrap', () => {
  it('ignores a late owner response after invalidation and confirms the new epoch', async () => {
    const first = deferred<CommunityNavigationState>();
    const second = deferred<CommunityNavigationState>();
    const getCommunityNavigation = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const transport = createMockTransport({ getCommunityNavigation });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    const hook = renderHook(() => useCommunityNavigation(), { wrapper });
    await waitFor(() => expect(getCommunityNavigation).toHaveBeenCalledTimes(1));

    act(() => {
      invalidateCommunityAuthority();
    });
    await waitFor(() => expect(getCommunityNavigation).toHaveBeenCalledTimes(2));
    await act(async () => {
      first.resolve({ ownerKey: 'owner-a', order: [], destinations: [] });
      await first.promise;
    });
    expect(getCommunityAuthority().ownerKey).toBeNull();
    expect(hook.result.current.data).toBeUndefined();

    await act(async () => {
      second.resolve({ ownerKey: 'owner-b', order: [], destinations: [] });
      await second.promise;
    });
    await waitFor(() => expect(hook.result.current.data?.ownerKey).toBe('owner-b'));
    expect(getCommunityAuthority().ownerKey).toBe('owner-b');
  });

  it('rejects a protected read that settles after its owner generation changed', async () => {
    const read = deferred<string>();
    const pending = getCommunityAuthority();
    const confirmed = { epoch: pending.epoch, ownerKey: 'owner-a' };
    confirmCommunityAuthority(confirmed.epoch, confirmed.ownerKey);
    const result = withinCommunityAuthority(confirmed, () => read.promise);

    invalidateCommunityAuthority();
    read.resolve('owner-a private data');

    await expect(result).rejects.toThrow('Community authority changed');
  });
});
