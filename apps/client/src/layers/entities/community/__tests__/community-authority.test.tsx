import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { CommunityNavigationState } from '@dorkos/shared/community-navigation';
import { RemoteCommunityRoomSchema } from '@dorkos/shared/community-views';
import {
  confirmCommunityAuthority,
  getCommunityAuthority,
  invalidateCommunityAuthority,
} from '@/layers/shared/lib';
import { commitCommunityRouteEpoch, TransportProvider } from '@/layers/shared/model';
import { communityNavigationKeys, useCommunityNavigation } from '../model/use-community-navigation';
import { communityAccessState, withinCommunityAuthority } from '../model/use-community-connections';
import { useRemoteCommunityRoom } from '../model/use-remote-community';

const access = {
  state: 'verified',
  effective: { read: true, post: true, enrollAgent: true, stream: true },
  lastKnown: {
    lifecycle: 'active',
    capabilities: { read: true, post: true, enrollAgent: true, stream: true },
    verifiedAt: '2026-09-21T00:00:00.000Z',
  },
} as const;

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

describe('Community access projection', () => {
  it('keeps an outage on the same cache generation while failing every live capability closed', () => {
    const verified = communityAccessState(access);
    const unverified = communityAccessState({
      ...access,
      state: 'unverified',
      effective: { read: false, post: false, enrollAgent: false, stream: false },
    });
    expect(unverified.fingerprint).toBe(verified.fingerprint);
    expect(unverified.cacheReadable).toBe(true);
    expect(unverified.capabilities).toEqual({
      read: false,
      post: false,
      enrollAgent: false,
      stream: false,
    });
  });

  it('keeps one generation across re-verifications that grant the same access (DOR-2268)', () => {
    // The server stamps a fresh `verifiedAt` on every listing. Reading it into
    // the fingerprint made every open channel rebuild itself every 30 seconds,
    // dropping the receipt of a post in flight.
    const earlier = communityAccessState(access);
    const later = communityAccessState({
      ...access,
      lastKnown: { ...access.lastKnown, verifiedAt: '2026-09-21T00:00:30.000Z' },
    });
    expect(later.fingerprint).toBe(earlier.fingerprint);
    // What the grant allows is still the fence: less access is a new generation.
    const readOnly = communityAccessState({
      ...access,
      effective: { ...access.effective, post: false },
      lastKnown: {
        ...access.lastKnown,
        capabilities: { ...access.lastKnown.capabilities, post: false },
      },
    });
    expect(readOnly.fingerprint).not.toBe(earlier.fingerprint);
    const archived = communityAccessState({
      ...access,
      lastKnown: { ...access.lastKnown, lifecycle: 'archived' },
    });
    expect(archived.fingerprint).not.toBe(earlier.fingerprint);
  });

  it('moves reconnect-required access into a purge generation', () => {
    const reconnect = communityAccessState({
      ...access,
      state: 'reconnect-required',
      effective: { read: false, post: false, enrollAgent: false, stream: false },
    });
    expect(reconnect.fingerprint).toBe('reconnect-required');
    expect(reconnect.cacheReadable).toBe(false);
  });
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
      first.resolve({
        ownerKey: 'owner-a',
        installationDestination: { path: '/', search: {} },
        order: [],
        destinations: [],
      });
      await first.promise;
    });
    expect(getCommunityAuthority().ownerKey).toBeNull();
    expect(hook.result.current.data).toBeUndefined();

    await act(async () => {
      second.resolve({
        ownerKey: 'owner-b',
        installationDestination: { path: '/', search: {} },
        order: [],
        destinations: [],
      });
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

  it('starts a new protected read and rejects the first completion after A→B→A', async () => {
    const firstA = deferred<ReturnType<typeof RemoteCommunityRoomSchema.parse>>();
    const roomB = deferred<ReturnType<typeof RemoteCommunityRoomSchema.parse>>();
    const finalA = deferred<ReturnType<typeof RemoteCommunityRoomSchema.parse>>();
    let aReads = 0;
    const getRemoteCommunityRoom = vi.fn((refName: string) => {
      if (refName === 'b') return roomB.promise;
      return aReads++ === 0 ? firstA.promise : finalA.promise;
    });
    const transport = createMockTransport({
      getRemoteCommunityRoom,
      getCommunityNavigation: vi
        .fn()
        .mockResolvedValue({ ownerKey: 'owner-a', order: [], destinations: [] }),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pending = invalidateCommunityAuthority();
    confirmCommunityAuthority(pending.epoch, 'owner-a');
    client.setQueryData(communityNavigationKeys.authority(pending.epoch), {
      ownerKey: 'owner-a',
      order: [],
      destinations: [],
    });
    function Probe({ refName }: { refName: string }) {
      const room = useRemoteCommunityRoom(refName, 'same');
      return <p>{room.data?.title ?? 'loading'}</p>;
    }
    function App({ refName }: { refName: string }) {
      return (
        <QueryClientProvider client={client}>
          <TransportProvider transport={transport}>
            <Probe refName={refName} />
          </TransportProvider>
        </QueryClientProvider>
      );
    }
    commitCommunityRouteEpoch('a');
    const view = render(<App refName="a" />);
    await waitFor(() => expect(getRemoteCommunityRoom).toHaveBeenCalledTimes(1));
    act(() => commitCommunityRouteEpoch('b'));
    view.rerender(<App refName="b" />);
    await waitFor(() =>
      expect(getRemoteCommunityRoom.mock.calls.some(([refName]) => refName === 'b')).toBe(true)
    );
    act(() => commitCommunityRouteEpoch('a'));
    view.rerender(<App refName="a" />);
    await waitFor(() =>
      expect(
        getRemoteCommunityRoom.mock.calls.filter(([refName]) => refName === 'a').length
      ).toBeGreaterThanOrEqual(2)
    );

    await act(async () => {
      firstA.resolve(
        RemoteCommunityRoomSchema.parse({
          community: 'a',
          roomId: 'same',
          remoteCommunityId: 'remote-a',
          kind: 'channel',
          title: 'stale A private data',
          slug: 'same',
          topic: null,
          archived: false,
          createdAt: '2026-09-21T00:00:00.000Z',
          lastActivityAt: '2026-09-21T00:00:00.000Z',
          unreadCount: 0,
          visibility: 'public',
          readable: true,
          writable: true,
          joined: true,
          stale: false,
          cacheCursor: null,
          lastRemoteSeq: 0,
          access,
        })
      );
      await firstA.promise;
    });
    expect(screen.queryByText('stale A private data')).not.toBeInTheDocument();

    await act(async () => {
      finalA.resolve(
        RemoteCommunityRoomSchema.parse({
          community: 'a',
          roomId: 'same',
          remoteCommunityId: 'remote-a',
          kind: 'channel',
          title: 'final A',
          slug: 'same',
          topic: null,
          archived: false,
          createdAt: '2026-09-21T00:00:00.000Z',
          lastActivityAt: '2026-09-21T00:00:00.000Z',
          unreadCount: 0,
          visibility: 'public',
          readable: true,
          writable: true,
          joined: true,
          stale: false,
          cacheCursor: null,
          lastRemoteSeq: 0,
          access,
        })
      );
      await finalA.promise;
    });
    expect(await screen.findByText('final A')).toBeInTheDocument();
  });
});
