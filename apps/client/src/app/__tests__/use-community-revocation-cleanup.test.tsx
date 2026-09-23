// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { toast } from 'sonner';
import { createMockTransport } from '@dorkos/test-utils';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import type { CommunityNavigationState } from '@dorkos/shared/community-navigation';
import {
  confirmCommunityAuthority,
  getCommunityConnectionGeneration,
  invalidateCommunityAuthority,
  tombstoneCommunityConnection,
  type ConfirmedCommunityAuthority,
} from '@/layers/shared/lib';
import { commitCommunityRouteEpoch, TransportProvider } from '@/layers/shared/model';
import {
  communityKeys,
  communityNavigationKeys,
  useCommunityConnectionsSync,
} from '@/layers/entities/community';
import { useCommunityRevocationCleanup } from '../use-community-revocation-cleanup';

const mockNavigate = vi.fn((_options: unknown) => Promise.resolve());
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
}));
vi.mock('sonner', () => ({ toast: vi.fn() }));
// Capture the global-stream handlers without a live stream, so a case can
// play the server's `community_connections_changed` frame.
const streamHandlers = new Map<string, (data: unknown) => void>();
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useEventSubscription: (event: string, handler: (data: unknown) => void) => {
    streamHandlers.set(event, handler);
  },
}));

const all = { read: true, post: true, enrollAgent: true, stream: true };
const none = { read: false, post: false, enrollAgent: false, stream: false };

function row(
  ref: string,
  status: CommunityConnectionDescriptor['status'],
  state: 'verified' | 'unverified' | 'reconnect-required' = status === 'reconnect-required'
    ? 'reconnect-required'
    : 'verified'
): CommunityConnectionDescriptor {
  return {
    ref,
    remoteCommunityId: `remote-${ref}`,
    label: ref === 'a' ? 'Alpha' : 'Beta',
    pinnedOrigin: `https://${ref}.example.com`,
    connectedHumanMemberId: `person-${ref}`,
    status,
    expiresAt: null,
    access: {
      state,
      effective: state === 'verified' ? all : none,
      lastKnown: { lifecycle: 'active', capabilities: all, verifiedAt: '2026-09-21T00:00:00.000Z' },
    },
    attention: { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
  } as CommunityConnectionDescriptor;
}

let authority: ConfirmedCommunityAuthority;
let client: QueryClient;
let rows: CommunityConnectionDescriptor[];

/** The watcher alone, as every case but the push case mounts it. */
function useWatcher() {
  useCommunityRevocationCleanup();
}

/** The watcher beside the sync hook, the way `AppShell` mounts them. */
function useWatcherWithPush() {
  useCommunityRevocationCleanup();
  useCommunityConnectionsSync();
}

function mount(hook: () => void = useWatcher) {
  const transport = createMockTransport({
    listCommunityConnections: vi.fn(() => Promise.resolve(rows)),
    getCommunityNavigation: vi.fn(() =>
      Promise.resolve({
        ownerKey: 'owner-a',
        installationDestination: { path: '/' as const, search: {} },
        order: [],
        destinations: [],
      } as unknown as CommunityNavigationState)
    ),
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

async function answer(next: CommunityConnectionDescriptor[]) {
  rows = next;
  await act(() => client.refetchQueries({ queryKey: communityKeys.connections(authority) }));
}

const privateRows = (ref: string) =>
  client.getQueriesData({ queryKey: communityKeys.remote(authority, ref) }).map(([, data]) => data);

beforeEach(() => {
  vi.clearAllMocks();
  streamHandlers.clear();
  const pending = invalidateCommunityAuthority();
  confirmCommunityAuthority(pending.epoch, 'owner-a');
  authority = { epoch: pending.epoch, ownerKey: 'owner-a' };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(communityNavigationKeys.authority(pending.epoch), {
    ownerKey: 'owner-a',
    order: [],
    destinations: [],
  });
  client.setQueryData([...communityKeys.remote(authority, 'a'), 'rooms'], ['A private']);
  client.setQueryData([...communityKeys.remote(authority, 'b'), 'rooms'], ['B private']);
  rows = [row('a', 'connected'), row('b', 'connected')];
});

afterEach(() => invalidateCommunityAuthority());

describe('useCommunityRevocationCleanup', () => {
  it('erases a revoked Community and routes away when it was on screen, leaving the other alone', async () => {
    commitCommunityRouteEpoch(JSON.stringify(['community', 'a', 'room', null]));
    mount();
    await waitFor(() =>
      expect(client.getQueryData(communityKeys.connections(authority))).toBeDefined()
    );
    const before = getCommunityConnectionGeneration('a');

    await answer([row('a', 'reconnect-required'), row('b', 'connected')]);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/', replace: true }));
    expect(getCommunityConnectionGeneration('a')).toBe(before + 1);
    expect(privateRows('a')).toEqual([]);
    expect(privateRows('b')).toEqual([['B private']]);
    expect(toast).toHaveBeenCalledWith(
      'This DorkOS can no longer reach Alpha.',
      expect.objectContaining({ description: expect.any(String) })
    );
  });

  it('erases a Community disconnected elsewhere without moving a route that shows another', async () => {
    commitCommunityRouteEpoch(JSON.stringify(['community', 'b', 'room', null]));
    mount();
    await waitFor(() =>
      expect(client.getQueryData(communityKeys.connections(authority))).toBeDefined()
    );

    await answer([row('b', 'connected')]);

    await waitFor(() => expect(privateRows('a')).toEqual([]));
    expect(privateRows('b')).toEqual([['B private']]);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('treats an unreachable host as offline, not as revoked', async () => {
    commitCommunityRouteEpoch(JSON.stringify(['community', 'a', 'room', null]));
    mount();
    await waitFor(() =>
      expect(client.getQueryData(communityKeys.connections(authority))).toBeDefined()
    );
    const before = getCommunityConnectionGeneration('a');

    await answer([row('a', 'connected', 'unverified'), row('b', 'connected')]);

    expect(getCommunityConnectionGeneration('a')).toBe(before);
    expect(privateRows('a')).toEqual([['A private']]);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does nothing for a Community that was already waiting to reconnect', async () => {
    rows = [row('a', 'reconnect-required'), row('b', 'connected')];
    commitCommunityRouteEpoch(JSON.stringify(['community', 'a', 'room', null]));
    mount();
    await waitFor(() =>
      expect(client.getQueryData(communityKeys.connections(authority))).toBeDefined()
    );
    const before = getCommunityConnectionGeneration('a');

    // A new list (B renamed) so the watcher really runs again, while A stays
    // exactly where it was.
    const renamed = { ...row('b', 'connected'), label: 'Beta renamed' };
    await answer([row('a', 'reconnect-required'), renamed]);
    await waitFor(() =>
      expect(
        client
          .getQueryData<CommunityConnectionDescriptor[]>(communityKeys.connections(authority))
          ?.find((item) => item.ref === 'b')?.label
      ).toBe('Beta renamed')
    );

    expect(getCommunityConnectionGeneration('a')).toBe(before);
    expect(privateRows('a')).toEqual([['A private']]);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('only settles the route after a disconnect this tab already cleaned up', async () => {
    commitCommunityRouteEpoch(JSON.stringify(['community', 'a', 'room', null]));
    mount();
    await waitFor(() =>
      expect(client.getQueryData(communityKeys.connections(authority))).toBeDefined()
    );
    tombstoneCommunityConnection('a');
    const after = getCommunityConnectionGeneration('a');

    await answer([row('b', 'connected')]);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/', replace: true }));
    // Not tombstoned a second time.
    expect(getCommunityConnectionGeneration('a')).toBe(after);
  });

  it('leaves a Community the server says ended at once, without waiting for the poll', async () => {
    // The acceptance run's defect: the server knew in ~26 ms, the window moved
    // on its next 30-second poll. With the sync hook mounted beside the
    // watcher, the server's frame alone drives the same cleanup.
    commitCommunityRouteEpoch(JSON.stringify(['community', 'a', 'room', null]));
    mount(useWatcherWithPush);
    await waitFor(() =>
      expect(client.getQueryData(communityKeys.connections(authority))).toBeDefined()
    );
    const before = getCommunityConnectionGeneration('a');

    // The person left A. Nothing re-reads the list yet: the poll is 30 s off.
    rows = [row('a', 'reconnect-required'), row('b', 'connected')];
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockNavigate).not.toHaveBeenCalled();

    act(() => streamHandlers.get('community_connections_changed')!({ changedAt: 'now' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/', replace: true }), {
      timeout: 1_000,
    });
    expect(getCommunityConnectionGeneration('a')).toBe(before + 1);
    expect(privateRows('a')).toEqual([]);
    expect(privateRows('b')).toEqual([['B private']]);
  });
});
