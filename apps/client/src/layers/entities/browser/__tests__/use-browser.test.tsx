// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  browserKeys,
  useBrowserProfiles,
  useBrowserInstances,
  useBrowserInstance,
  useCloseBrowserInstance,
} from '../index';
import type { BrowserProfile } from '../index';
import type { Transport } from '@dorkos/shared/transport';

function setup(transport: Transport) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={cache}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return { cache, wrapper: Wrapper };
}

describe('browser metadata hooks', () => {
  it('does not request profiles without a signed-in cache owner', () => {
    const getBrowserProfiles = vi.fn().mockResolvedValue([]);
    const { wrapper } = setup(createMockTransport({ getBrowserProfiles }));
    const { result } = renderHook(() => useBrowserProfiles(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(getBrowserProfiles).not.toHaveBeenCalled();
  });

  it('refuses manual list refresh without an owner and leaves both private caches empty', async () => {
    const getBrowserProfiles = vi.fn().mockResolvedValue([{ profileId: 'private' }]);
    const getBrowserInstances = vi.fn().mockResolvedValue([{ browserId: 'private' }]);
    const { cache, wrapper } = setup(
      createMockTransport({ getBrowserProfiles, getBrowserInstances })
    );
    const profiles = renderHook(() => useBrowserProfiles(null), { wrapper });
    const instances = renderHook(() => useBrowserInstances(null), { wrapper });
    await act(async () => {
      const [profileResult, instanceResult] = await Promise.all([
        profiles.result.current.refetch(),
        instances.result.current.refetch(),
      ]);
      expect(profileResult.isError).toBe(true);
      expect(instanceResult.isError).toBe(true);
    });
    expect(getBrowserProfiles).not.toHaveBeenCalled();
    expect(getBrowserInstances).not.toHaveBeenCalled();
    expect(cache.getQueryData(browserKeys.profiles(null))).toBeUndefined();
    expect(cache.getQueryData(browserKeys.instances(null))).toBeUndefined();
    expect(profiles.result.current.data).toBeUndefined();
    expect(instances.result.current.data).toBeUndefined();
  });

  it('cancels the old owner request and does not expose its late data to the new owner', async () => {
    let oldSignal: AbortSignal | undefined;
    let settleOld: ((value: BrowserProfile[]) => void) | undefined;
    const getBrowserProfiles = vi.fn((signal?: AbortSignal) => {
      if (!oldSignal) {
        oldSignal = signal;
        return new Promise<BrowserProfile[]>((resolve) => {
          settleOld = resolve;
        });
      }
      return Promise.resolve([]);
    });
    const { wrapper } = setup(createMockTransport({ getBrowserProfiles }));
    const hook = renderHook(({ owner }) => useBrowserProfiles(owner), {
      wrapper,
      initialProps: { owner: 'alice' },
    });
    await waitFor(() => expect(getBrowserProfiles).toHaveBeenCalledOnce());
    hook.rerender({ owner: 'bob' });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(oldSignal?.aborted).toBe(true);
    act(() =>
      settleOld?.([
        { profileId: 'private-alice', label: 'Alice', revision: 1, status: 'available' },
      ])
    );
    expect(hook.result.current.data).toEqual([]);
  });

  it.each([401, 404, 503])('does not retry an authority refusal %s', async (status) => {
    const getBrowserProfiles = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Refused'), { status }));
    const { wrapper } = setup(createMockTransport({ getBrowserProfiles }));
    const { result } = renderHook(() => useBrowserProfiles('alice'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(getBrowserProfiles).toHaveBeenCalledOnce();
    expect(result.current.data).toBeUndefined();
  });

  it('asks for the exact selected generation without serving old cached data', async () => {
    const getBrowserInstance = vi
      .fn()
      .mockResolvedValue({ browserId: 'browser_a', browserGeneration: 2 });
    const { cache, wrapper } = setup(createMockTransport({ getBrowserInstance }));
    cache.setQueryData(browserKeys.instance('alice', 'browser_a', 1), { browserGeneration: 1 });
    const { result } = renderHook(() => useBrowserInstance('alice', 'browser_a', 2), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getBrowserInstance).toHaveBeenCalledWith('browser_a', 2, expect.any(AbortSignal));
    expect(result.current.data?.browserGeneration).toBe(2);
  });

  it('preserves unverified close cleanup and invalidates only the captured owner generation', async () => {
    const request = { requestId: 'request_a', browserId: 'browser_a', browserGeneration: 2 };
    const receipt = {
      ...request,
      cleanup: 'unverified',
      reason: 'observationUnavailable',
    } as const;
    let complete: ((value: typeof receipt) => void) | undefined;
    const closeBrowserInstance = vi.fn(
      () =>
        new Promise<typeof receipt>((resolve) => {
          complete = resolve;
        })
    );
    const { cache, wrapper } = setup(createMockTransport({ closeBrowserInstance }));
    cache.setQueryData(browserKeys.instance('alice', 'browser_a', 2), {});
    cache.setQueryData(browserKeys.instance('bob', 'browser_a', 2), {});
    cache.setQueryData(browserKeys.profiles('alice'), []);
    cache.setQueryData(browserKeys.profiles('bob'), []);
    const hook = renderHook(({ owner }) => useCloseBrowserInstance(owner), {
      wrapper,
      initialProps: { owner: 'alice' },
    });
    act(() => hook.result.current.mutate(request));
    await waitFor(() => expect(closeBrowserInstance).toHaveBeenCalledOnce());
    const originalMutation = cache.getMutationCache().getAll()[0];
    hook.rerender({ owner: 'bob' });
    expect(hook.result.current.isIdle).toBe(true);
    expect(hook.result.current.data).toBeUndefined();
    act(() => complete?.(receipt));
    await waitFor(() => expect(originalMutation?.state.status).toBe('success'));
    expect(originalMutation?.state.data).toEqual(receipt);
    expect(hook.result.current.isIdle).toBe(true);
    expect(hook.result.current.data).toBeUndefined();
    expect(cache.getQueryState(browserKeys.instance('alice', 'browser_a', 2))?.isInvalidated).toBe(
      true
    );
    expect(cache.getQueryState(browserKeys.instance('bob', 'browser_a', 2))?.isInvalidated).toBe(
      false
    );
    expect(cache.getQueryState(browserKeys.profiles('alice'))?.isInvalidated).toBe(true);
    expect(cache.getQueryState(browserKeys.profiles('bob'))?.isInvalidated).toBe(false);
  });

  it.each(['observed', 'unverified', 'failed'] as const)(
    'refreshes genuine profile metadata after %s close without inferring availability',
    async (outcome) => {
      let closed = false;
      const profile: BrowserProfile = {
        profileId: 'profile-a',
        label: 'Saved',
        revision: 1,
        status: 'inUse',
      };
      const getBrowserProfiles = vi.fn(async () => [
        {
          ...profile,
          status: closed && outcome === 'observed' ? ('available' as const) : ('inUse' as const),
        },
      ]);
      const closeBrowserInstance = vi.fn(
        async (request: Parameters<Transport['closeBrowserInstance']>[0]) => {
          closed = true;
          if (outcome === 'failed') throw new Error('Original close failed');
          return outcome === 'observed'
            ? { ...request, cleanup: 'observed' as const }
            : {
                ...request,
                cleanup: 'unverified' as const,
                reason: 'observationUnavailable' as const,
              };
        }
      );
      const { cache, wrapper } = setup(
        createMockTransport({ getBrowserProfiles, closeBrowserInstance })
      );
      const hook = renderHook(
        () => ({ profiles: useBrowserProfiles('alice'), close: useCloseBrowserInstance('alice') }),
        { wrapper }
      );
      try {
        await waitFor(() => expect(hook.result.current.profiles.data?.[0]?.status).toBe('inUse'));
        act(() =>
          hook.result.current.close.mutate({
            requestId: 'request-a',
            browserId: 'browser-a',
            browserGeneration: 1,
          })
        );
        await waitFor(() => expect(getBrowserProfiles).toHaveBeenCalledTimes(2));
        await waitFor(() =>
          expect(hook.result.current.profiles.data?.[0]?.status).toBe(
            outcome === 'observed' ? 'available' : 'inUse'
          )
        );
        expect(closeBrowserInstance).toHaveBeenCalledOnce();
      } finally {
        hook.unmount();
        cache.clear();
      }
    }
  );
});
