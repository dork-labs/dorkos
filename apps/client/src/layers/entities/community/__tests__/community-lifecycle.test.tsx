import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  RemoteCommunityRoomSchema,
  type RemoteCommunityRoom,
} from '@dorkos/shared/community-views';
import {
  confirmCommunityAuthority,
  getCommunityConnectionGeneration,
  invalidateCommunityAuthority,
  type ConfirmedCommunityAuthority,
} from '@/layers/shared/lib';
import { commitCommunityRouteEpoch, TransportProvider } from '@/layers/shared/model';
import { endCommunityConnection, useEndCommunityConnection } from '../model/community-lifecycle';
import {
  communityKeys,
  isCommunityContentAuthorityCurrent,
  useCommunityContentAuthority,
} from '../model/use-community-connections';
import { communityNavigationKeys } from '../model/use-community-navigation';
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

function connection(
  ref: string,
  status: CommunityConnectionDescriptor['status'] = 'connected'
): CommunityConnectionDescriptor {
  return {
    ref,
    remoteCommunityId: `remote-${ref}`,
    label: ref.toUpperCase(),
    pinnedOrigin: `https://${ref}.example.com`,
    connectedHumanMemberId: status === 'pending' ? null : `person-${ref}`,
    status,
    expiresAt: null,
    access: status === 'pending' ? null : access,
    attention:
      status === 'pending'
        ? null
        : { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
  } as CommunityConnectionDescriptor;
}

function room(ref: string, title: string): RemoteCommunityRoom {
  return RemoteCommunityRoomSchema.parse({
    community: ref,
    roomId: 'same',
    remoteCommunityId: `remote-${ref}`,
    kind: 'channel',
    title,
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
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

let authority: ConfirmedCommunityAuthority;
let client: QueryClient;

beforeEach(() => {
  const pending = invalidateCommunityAuthority();
  confirmCommunityAuthority(pending.epoch, 'owner-a');
  authority = { epoch: pending.epoch, ownerKey: 'owner-a' };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(communityNavigationKeys.authority(pending.epoch), {
    ownerKey: 'owner-a',
    order: [],
    destinations: [],
  });
});

afterEach(() => {
  cleanup();
  invalidateCommunityAuthority();
});

describe('endCommunityConnection', () => {
  it('erases only the ended Community, and keeps its row when access was revoked', async () => {
    client.setQueryData(communityKeys.connections(authority), [connection('a'), connection('b')]);
    client.setQueryData(
      [...communityKeys.remote(authority, 'a'), 'context', 1, 'x', 'rooms'],
      ['A private']
    );
    client.setQueryData(
      [...communityKeys.remote(authority, 'b'), 'context', 1, 'x', 'rooms'],
      ['B private']
    );
    const before = {
      a: getCommunityConnectionGeneration('a'),
      b: getCommunityConnectionGeneration('b'),
    };

    await endCommunityConnection(client, authority, 'a', 'revoked');

    expect(getCommunityConnectionGeneration('a')).toBe(before.a + 1);
    expect(getCommunityConnectionGeneration('b')).toBe(before.b);
    expect(client.getQueriesData({ queryKey: communityKeys.remote(authority, 'a') })).toEqual([]);
    expect(
      client
        .getQueriesData({ queryKey: communityKeys.remote(authority, 'b') })
        .map(([, data]) => data)
    ).toEqual([['B private']]);
    // Revoked: the row stays, asking to reconnect.
    expect(
      client
        .getQueryData<CommunityConnectionDescriptor[]>(communityKeys.connections(authority))
        ?.map((row) => row.ref)
    ).toEqual(['a', 'b']);
  });

  it('drops the row itself when the connection was removed', async () => {
    client.setQueryData(communityKeys.connections(authority), [connection('a'), connection('b')]);
    await endCommunityConnection(client, authority, 'a', 'removed');
    expect(
      client
        .getQueryData<CommunityConnectionDescriptor[]>(communityKeys.connections(authority))
        ?.map((row) => row.ref)
    ).toEqual(['b']);
  });

  it('discards a read that was in flight when its Community ended, even back on the same route', async () => {
    const stale = deferred<RemoteCommunityRoom>();
    const fresh = deferred<RemoteCommunityRoom>();
    const getRemoteCommunityRoom = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    const transport = createMockTransport({ getRemoteCommunityRoom });
    function Probe() {
      const query = useRemoteCommunityRoom('a', 'same');
      return <p>{query.data?.title ?? 'loading'}</p>;
    }
    commitCommunityRouteEpoch(JSON.stringify(['community', 'a', 'same', null]));
    render(
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>
          <Probe />
        </TransportProvider>
      </QueryClientProvider>
    );
    await waitFor(() => expect(getRemoteCommunityRoom).toHaveBeenCalledTimes(1));

    await act(() => endCommunityConnection(client, authority, 'a', 'revoked'));
    // The route never moved: ending A alone cancels its read and asks again.
    await waitFor(() => expect(getRemoteCommunityRoom).toHaveBeenCalledTimes(2));
    await act(async () => {
      stale.resolve(room('a', 'A before it ended'));
      await stale.promise.catch(() => {});
    });
    expect(screen.queryByText('A before it ended')).not.toBeInTheDocument();

    await act(async () => {
      fresh.resolve(room('a', 'A now'));
      await fresh.promise;
    });
    expect(await screen.findByText('A now')).toBeInTheDocument();
  });
});

describe('the per-connection guard', () => {
  it('fails content captured for the ended Community and no other', () => {
    commitCommunityRouteEpoch(JSON.stringify(['community', 'a', 'same', null]));
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>
        <TransportProvider transport={createMockTransport()}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    const a = renderHook(() => useCommunityContentAuthority(true, 'fp', 'a'), { wrapper });
    const b = renderHook(() => useCommunityContentAuthority(true, 'fp', 'b'), { wrapper });
    const capturedA = a.result.current!;
    const capturedB = b.result.current!;
    expect(isCommunityContentAuthorityCurrent(capturedA)).toBe(true);

    act(() => void endCommunityConnection(client, authority, 'a', 'revoked'));

    // A delayed receipt, stream event or action result captured for A is now
    // refused, while B's are untouched.
    expect(isCommunityContentAuthorityCurrent(capturedA)).toBe(false);
    expect(isCommunityContentAuthorityCurrent(capturedB)).toBe(true);
    // A's fresh authority carries a new fingerprint, so drafts, receipts and
    // cache keys addressed by it start empty rather than reusing A's old ones.
    expect(a.result.current!.accessFingerprint).not.toBe(capturedA.accessFingerprint);
    expect(isCommunityContentAuthorityCurrent(a.result.current!)).toBe(true);
    expect(b.result.current).toBe(capturedB);
  });
});

describe('useEndCommunityConnection', () => {
  function wrapper(transport: ReturnType<typeof createMockTransport>) {
    return ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }

  it('disconnects a connected Community and then erases it', async () => {
    const disconnectCommunity = vi.fn().mockResolvedValue(undefined);
    const cancelCommunityConnection = vi.fn().mockResolvedValue(undefined);
    const transport = createMockTransport({ disconnectCommunity, cancelCommunityConnection });
    client.setQueryData(communityKeys.connections(authority), [connection('a'), connection('b')]);
    const before = getCommunityConnectionGeneration('a');
    const hook = renderHook(() => useEndCommunityConnection(), { wrapper: wrapper(transport) });

    await act(() => hook.result.current.mutateAsync(connection('a')));

    expect(disconnectCommunity).toHaveBeenCalledWith('a');
    expect(cancelCommunityConnection).not.toHaveBeenCalled();
    expect(getCommunityConnectionGeneration('a')).toBe(before + 1);
  });

  it('cancels a pending approval instead of disconnecting', async () => {
    const disconnectCommunity = vi.fn().mockResolvedValue(undefined);
    const cancelCommunityConnection = vi.fn().mockResolvedValue(undefined);
    const transport = createMockTransport({ disconnectCommunity, cancelCommunityConnection });
    const hook = renderHook(() => useEndCommunityConnection(), { wrapper: wrapper(transport) });
    await act(() => hook.result.current.mutateAsync(connection('p', 'pending')));
    expect(cancelCommunityConnection).toHaveBeenCalledWith('p');
    expect(disconnectCommunity).not.toHaveBeenCalled();
  });

  it('keeps the Community and its content when the server does not confirm', async () => {
    const failure = deferred<void>();
    const disconnectCommunity = vi.fn(() => failure.promise);
    const transport = createMockTransport({ disconnectCommunity });
    client.setQueryData([...communityKeys.remote(authority, 'a'), 'rooms'], ['A private']);
    const before = getCommunityConnectionGeneration('a');
    const hook = renderHook(() => useEndCommunityConnection(), { wrapper: wrapper(transport) });

    const result = hook.result.current.mutateAsync(connection('a'));
    failure.reject(new Error('offline'));
    await act(() => expect(result).rejects.toThrow('offline'));

    expect(getCommunityConnectionGeneration('a')).toBe(before);
    expect(client.getQueryData([...communityKeys.remote(authority, 'a'), 'rooms'])).toEqual([
      'A private',
    ]);
  });
});
