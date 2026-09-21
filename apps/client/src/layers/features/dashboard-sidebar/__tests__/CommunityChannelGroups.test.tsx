// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createMockTransport } from '@dorkos/test-utils';
import { CommunityConnectionDescriptorSchema } from '@dorkos/shared/community-connections';
import { RemoteCommunityRoomSchema } from '@dorkos/shared/community-views';
import { TransportProvider } from '@/layers/shared/model';
import { CommunityChannelGroups } from '../ui/CommunityChannelGroups';

afterEach(cleanup);
const access = {
  state: 'verified',
  effective: { read: true, post: true, enrollAgent: true, stream: true },
  lastKnown: {
    lifecycle: 'active',
    capabilities: { read: true, post: true, enrollAgent: true, stream: true },
    verifiedAt: '2026-09-16T10:00:00Z',
  },
} as const;
const connection = (ref: string) =>
  CommunityConnectionDescriptorSchema.parse({
    ref,
    remoteCommunityId: `deployment-${ref}`,
    label: `Community ${ref}`,
    pinnedOrigin: `https://${ref}.example.com`,
    connectedHumanMemberId: 'person',
    status: 'connected',
    expiresAt: null,
    access,
  });
const room = (community: string) =>
  RemoteCommunityRoomSchema.parse({
    community,
    roomId: 'same',
    remoteCommunityId: `deployment-${community}`,
    kind: 'channel',
    title: 'General',
    slug: 'general',
    topic: null,
    archived: false,
    createdAt: '2026-09-16T10:00:00Z',
    lastActivityAt: '2026-09-16T10:00:00Z',
    unreadCount: 2,
    visibility: 'public',
    readable: true,
    writable: true,
    joined: true,
    stale: false,
    cacheCursor: null,
    lastRemoteSeq: 0,
    access,
  });

function mount(community?: string, failFirst = false) {
  const transport = createMockTransport();
  vi.mocked(transport.listCommunityConnections).mockResolvedValue([
    connection('a'),
    connection('b'),
  ]);
  vi.mocked(transport.listRemoteCommunityRooms).mockImplementation(async (ref) => {
    if (ref === 'a' && failFirst) throw new Error('offline');
    return { community: room(ref).community, rooms: [room(ref)], stale: false };
  });
  const root = createRootRoute({ component: CommunityChannelGroups, staticData: { header: null } });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({
      initialEntries: [community ? `/channels?community=${community}&id=same` : '/'],
    }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <RouterProvider router={router} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('community channel discovery', () => {
  it('shows only the route-selected community and keeps its room address qualified', async () => {
    mount('b');
    const link = await screen.findByRole('link', { name: /general/ });
    const address = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(address.searchParams.get('community')).toBe('b');
    expect(address.searchParams.get('id')).toBe('same');
    expect(screen.getByRole('region', { name: 'Community b' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Community a' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('2 unread messages')).toBeInTheDocument();
  });

  it('renders no remote navigation while the installation route is selected', async () => {
    const transport = mount();
    await waitFor(() => expect(transport.listCommunityConnections).toHaveBeenCalled());
    expect(transport.listRemoteCommunityRooms).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /general/ })).not.toBeInTheDocument();
  });

  it('contains a selected community failure without drawing another community', async () => {
    const transport = mount('a', true);
    await waitFor(() => expect(transport.listRemoteCommunityRooms).toHaveBeenCalledWith('a'));
    expect(await screen.findByText(/Community unavailable/)).toBeInTheDocument();
    expect(transport.listRemoteCommunityRooms).not.toHaveBeenCalledWith('b');
  });
});
